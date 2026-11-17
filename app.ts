// The forge HTTP surface: /healthz, REST v3 under /api/v3, GraphQL at
// /api/graphql, MCP at /mcp, and git smart HTTP at /{owner}/{repo}.git.
// One in-memory store (see store.ts) backs every surface.

import { createServer as httpCreateServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { Forge, setPath, makeCommit } from './store.ts';
import type { Repo } from './store.ts';
import { parseCommit, commitHistory, ZERO_OID } from './git.ts';
import {
  HttpError, repoJson, issueJson, issueJsonText, pullJson, createIssue, createPull,
  mergePull, pullFiles, viewerIdentity, epochOf,
} from './service.ts';
import { executeGraphQL } from './graphql.ts';
import { handleGit } from './gitweb.ts';
import { handleMcp } from './mcp.ts';

const forge = new Forge();
let requestSeq = 0;

function token(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

function authed(req: IncomingMessage): boolean {
  const expected = token();
  if (!expected) return true;
  return (req.headers.authorization ?? '') === `Bearer ${expected}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  requestSeq += 1;
  const text = body === null || body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': `REQ-${requestSeq}`,
    ...extra,
  });
  res.end(text);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

/** sendJson for a body that is already serialized (hot read paths). */
function sendText(res: ServerResponse, status: number, text: string): void {
  requestSeq += 1;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': `REQ-${requestSeq}`,
  });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function parseJsonBody(body: Buffer): { value: Record<string, unknown> } | { error: true } {
  if (body.length === 0) return { value: {} };
  try {
    const value = JSON.parse(body.toString('utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { value: {} };
    return { value: value as Record<string, unknown> };
  } catch {
    return { error: true };
  }
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// ------------------------------------------------------------------ REST

function repoJsonFull(repo: Repo): Record<string, unknown> {
  return repoJson(forge, repo);
}

function branchList(repo: Repo): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const [ref, sha] of repo.refs) {
    if (!ref.startsWith('refs/heads/')) continue;
    out.push({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false });
  }
  out.sort((a, b) => {
    const an = a.name as string;
    const bn = b.name as string;
    if (an === repo.defaultBranch) return -1;
    if (bn === repo.defaultBranch) return 1;
    return an < bn ? -1 : 1;
  });
  return out;
}

function commitJson(repo: Repo, sha: string): Record<string, unknown> {
  const obj = repo.store.get(sha);
  const info = obj ? parseCommit(obj.data) : { tree: '', parents: [], message: '' };
  const raw = obj ? obj.data.toString('utf8') : '';
  const authorLine = /^author (.*)$/m.exec(raw)?.[1] ?? '';
  const m = /^(.*) <(.*)> (\d+) /.exec(authorLine);
  return {
    sha,
    commit: {
      message: info.message.replace(/\n$/, ''),
      tree: { sha: info.tree },
      author: { name: m?.[1] ?? '', email: m?.[2] ?? '', date: new Date(parseInt(m?.[3] ?? '0', 10) * 1000).toISOString() },
      committer: { name: m?.[1] ?? '', email: m?.[2] ?? '', date: new Date(parseInt(m?.[3] ?? '0', 10) * 1000).toISOString() },
    },
    parents: info.parents.map((p) => ({ sha: p })),
  };
}

function handleRest(req: IncomingMessage, res: ServerResponse, segments: string[], query: URLSearchParams, body: Buffer): void {
  const method = req.method ?? 'GET';
  // segments[0] === 'api', segments[1] === 'v3'
  const rest = segments.slice(2);

  if (rest.length === 0) {
    sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }
  if (rest.length === 1 && rest[0] === 'meta') {
    sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: false });
    return;
  }
  if (!authed(req)) {
    sendError(res, 401, 'Requires authentication');
    return;
  }

  const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  let json: Record<string, unknown> = {};
  if (needsBody && body.length > 0) {
    const parsed = parseJsonBody(body);
    if ('error' in parsed) {
      sendError(res, 400, 'Problems parsing JSON');
      return;
    }
    json = parsed.value;
  }

  try {
    routeRest(req, res, method, rest, query, json);
  } catch (err) {
    if (err instanceof HttpError) sendError(res, err.status, err.message);
    else sendError(res, 500, 'Internal error');
  }
}

function routeRest(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  rest: string[],
  query: URLSearchParams,
  json: Record<string, unknown>,
): void {
  // /user
  if (rest[0] === 'user' && rest.length === 1 && method === 'GET') {
    sendJson(res, 200, { login: forge.viewerLogin, id: 1000, type: 'User', name: forge.viewerLogin });
    return;
  }
  // /user/repos
  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'POST') {
      const name = typeof json.name === 'string' ? json.name : '';
      if (!name) throw new HttpError(422, 'Repository creation failed: name is required');
      const created = forge.createRepo(name, typeof json.description === 'string' ? json.description : '', json.private !== false);
      if (created === 'exists') throw new HttpError(422, 'name already exists on this account');
      sendJson(res, 201, repoJsonFull(created));
      return;
    }
    if (method === 'GET') {
      const perPage = Math.max(1, parseInt(query.get('per_page') ?? '30', 10) || 30);
      const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
      const all = [...forge.repos.values()];
      const slice = all.slice((page - 1) * perPage, page * perPage);
      const extra: Record<string, string> = {};
      if (page * perPage < all.length) {
        const host = req.headers.host ?? 'localhost';
        const lastPage = Math.ceil(all.length / perPage);
        extra.link = `<http://${host}/api/v3/user/repos?page=${page + 1}&per_page=${perPage}>; rel="next", <http://${host}/api/v3/user/repos?page=${lastPage}&per_page=${perPage}>; rel="last"`;
      }
      sendJson(res, 200, slice.map((r) => repoJsonFull(r)), extra);
      return;
    }
  }
  // /repos/{owner}/{repo}/...
  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = rest[1] as string;
    const name = rest[2] as string;
    const repo = forge.repoFor(owner, name);
    if (!repo) throw new HttpError(404, 'Not Found');
    const sub = rest.slice(3);
    routeRepo(res, method, repo, sub, query, json);
    return;
  }
  throw new HttpError(404, 'Not Found');
}

function routeRepo(
  res: ServerResponse,
  method: string,
  repo: Repo,
  sub: string[],
  query: URLSearchParams,
  json: Record<string, unknown>,
): void {
  if (sub.length === 0) {
    if (method === 'GET') { sendJson(res, 200, repoJsonFull(repo)); return; }
    if (method === 'PATCH') {
      if (typeof json.description === 'string') repo.description = json.description;
      if (typeof json.private === 'boolean') (repo as { isPrivate: boolean }).isPrivate = json.private;
      sendJson(res, 200, repoJsonFull(repo));
      return;
    }
    if (method === 'DELETE') {
      forge.repos.delete(repo.name);
      sendJson(res, 204, null);
      return;
    }
  }
  if (sub[0] === 'branches' && sub.length === 1 && method === 'GET') {
    sendJson(res, 200, branchList(repo));
    return;
  }
  if (sub[0] === 'branches' && sub.length === 2 && method === 'GET') {
    const sha = repo.tipOf(decode(sub[1] as string));
    if (!sha) throw new HttpError(404, 'Branch not found');
    sendJson(res, 200, { name: decode(sub[1] as string), commit: { sha }, protected: false });
    return;
  }
  if (sub[0] === 'git' && sub[1] === 'refs') {
    if (method === 'POST' && sub.length === 2) {
      const ref = typeof json.ref === 'string' ? json.ref : '';
      const sha = typeof json.sha === 'string' ? json.sha : '';
      if (!ref || !sha) throw new HttpError(422, 'ref and sha are required');
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, object: { sha, type: 'commit' } });
      return;
    }
    if (method === 'GET' && sub.length >= 3) {
      const ref = `refs/${sub.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (!sha) throw new HttpError(404, 'Reference not found');
      sendJson(res, 200, { ref, object: { sha, type: 'commit' } });
      return;
    }
  }
  if (sub[0] === 'commits' && sub.length === 1 && method === 'GET') {
    const shaParam = query.get('sha');
    const start = shaParam
      ? (repo.tipOf(shaParam) ?? (repo.store.has(shaParam) ? shaParam : null))
      : repo.tipOf(repo.defaultBranch);
    if (!start) { sendJson(res, 200, []); return; }
    sendJson(res, 200, commitHistory(repo.store, start).map((sha) => commitJson(repo, sha)));
    return;
  }
  if (sub[0] === 'commits' && sub.length === 2 && method === 'GET') {
    const sha = sub[1] as string;
    if (!repo.store.has(sha)) throw new HttpError(404, 'Commit not found');
    sendJson(res, 200, commitJson(repo, sha));
    return;
  }
  if (sub[0] === 'contents') {
    routeContents(res, method, repo, sub.slice(1), query, json);
    return;
  }
  if (sub[0] === 'labels' && sub.length === 1) {
    if (method === 'POST') {
      const labelName = typeof json.name === 'string' ? json.name : '';
      if (!labelName) throw new HttpError(422, 'name is required');
      const color = typeof json.color === 'string' ? json.color : 'ededed';
      if (!repo.labels.has(labelName)) repo.labels.set(labelName, { name: labelName, color });
      const label = repo.labels.get(labelName) as { name: string; color: string };
      sendJson(res, 201, { name: label.name, color: label.color });
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color })));
      return;
    }
  }
  if (sub[0] === 'issues') {
    routeIssues(res, method, repo, sub.slice(1), query, json);
    return;
  }
  if (sub[0] === 'pulls') {
    routePulls(res, method, repo, sub.slice(1), query, json);
    return;
  }
  throw new HttpError(404, 'Not Found');
}

function routeContents(
  res: ServerResponse,
  method: string,
  repo: Repo,
  pathSegs: string[],
  query: URLSearchParams,
  json: Record<string, unknown>,
): void {
  const path = pathSegs.map((s) => decode(s)).join('/');
  if (method === 'GET') {
    const ref = query.get('ref') ?? repo.defaultBranch;
    const file = path ? repo.fileAt(ref, path) : null;
    if (file) {
      sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        content: file.data.toString('base64'),
        sha: file.oid,
        size: file.data.length,
        name: path.split('/').pop(),
        path,
      });
      return;
    }
    const dir = repo.dirAt(ref, path);
    if (dir) {
      sendJson(res, 200, dir.map((e) => ({
        type: e.type,
        name: e.name,
        path: e.path,
        sha: e.oid,
        size: e.type === 'file' ? (repo.store.get(e.oid)?.data.length ?? 0) : 0,
      })));
      return;
    }
    if (path === '' && !repo.tipOf(ref)) {
      sendJson(res, 200, []);
      return;
    }
    throw new HttpError(404, 'Not Found');
  }
  if (method === 'PUT') {
    const branch = typeof json.branch === 'string' ? json.branch : repo.defaultBranch;
    const message = typeof json.message === 'string' ? json.message : 'Update file';
    const contentB64 = typeof json.content === 'string' ? json.content : '';
    const existing = repo.fileAt(branch, path);
    if (existing && json.sha !== existing.oid) throw new HttpError(409, 'SHA does not match');
    let tip = repo.tipOf(branch);
    if (!tip && branch !== repo.defaultBranch) tip = repo.tipOf(repo.defaultBranch);
    const baseTree = tip ? parseCommit(repo.store.get(tip)?.data ?? Buffer.alloc(0)).tree : null;
    const blob = repo.store.put('blob', Buffer.from(contentB64.replace(/\s/g, ''), 'base64'));
    const newTree = setPath(repo, baseTree, path, blob);
    const commit = makeCommit(repo, newTree, tip ? [tip] : [], message, viewerIdentity(forge), epochOf(forge));
    repo.refs.set(`refs/heads/${branch}`, commit);
    const blobObj = repo.store.get(blob);
    sendJson(res, existing ? 200 : 201, {
      content: { name: path.split('/').pop(), path, sha: blob, size: blobObj?.data.length ?? 0, encoding: 'base64' },
      commit: { sha: commit, message },
    });
    return;
  }
  if (method === 'DELETE') {
    const branch = typeof json.branch === 'string' ? json.branch : repo.defaultBranch;
    const message = typeof json.message === 'string' ? json.message : 'Delete file';
    const existing = repo.fileAt(branch, path);
    if (!existing) throw new HttpError(404, 'Not Found');
    if (json.sha !== existing.oid) throw new HttpError(409, 'SHA does not match');
    const tip = repo.tipOf(branch);
    if (!tip) throw new HttpError(404, 'Not Found');
    const baseTree = parseCommit(repo.store.get(tip)?.data ?? Buffer.alloc(0)).tree;
    const newTree = setPath(repo, baseTree, path, null);
    const commit = makeCommit(repo, newTree, [tip], message, viewerIdentity(forge), epochOf(forge));
    repo.refs.set(`refs/heads/${branch}`, commit);
    sendJson(res, 200, { content: null, commit: { sha: commit, message } });
    return;
  }
  throw new HttpError(404, 'Not Found');
}

function routeIssues(
  res: ServerResponse,
  method: string,
  repo: Repo,
  sub: string[],
  query: URLSearchParams,
  json: Record<string, unknown>,
): void {
  if (sub.length === 0) {
    if (method === 'POST') {
      const issue = createIssue(forge, repo, json);
      sendText(res, 201, issueJsonText(forge, repo, issue));
      return;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const direction = query.get('direction') ?? 'asc';
      let list = [...repo.issues.values()].filter((i) => state === 'all' || i.state === state);
      list.sort((a, b) => (a.createdSeq - b.createdSeq) * (direction === 'desc' ? -1 : 1));
      const perPage = parseInt(query.get('per_page') ?? '30', 10) || 30;
      const page = parseInt(query.get('page') ?? '1', 10) || 1;
      list = list.slice((page - 1) * perPage, page * perPage);
      sendJson(res, 200, list.map((i) => issueJson(forge, repo, i)));
      return;
    }
  }
  const number = parseInt(sub[0] ?? '', 10);
  const issue = Number.isNaN(number) ? undefined : repo.issues.get(number);
  if (!issue) throw new HttpError(404, 'Issue not found');
  if (sub.length === 1) {
    if (method === 'GET') { sendText(res, 200, issueJsonText(forge, repo, issue)); return; }
    if (method === 'PATCH') {
      issue.version += 1;
      if (json.state === 'closed' || json.state === 'open') issue.state = json.state;
      if (typeof json.title === 'string') issue.title = json.title;
      if (typeof json.body === 'string') issue.body = json.body;
      if (Array.isArray(json.labels)) {
        const labels = json.labels.map((l) => (typeof l === 'string' ? l : (l as { name?: string }).name ?? '')).filter(Boolean);
        for (const name of labels) if (!repo.labels.has(name)) throw new HttpError(422, `Label "${name}" does not exist`);
        issue.labels = labels;
      }
      sendText(res, 200, issueJsonText(forge, repo, issue));
      return;
    }
  }
  if (sub.length === 2 && sub[1] === 'comments') {
    if (method === 'GET') {
      sendJson(res, 200, issue.comments.map((c) => ({
        id: c.id, body: c.body, created_at: c.createdAt, user: { login: forge.viewerLogin },
      })));
      return;
    }
    if (method === 'POST') {
      const comment = {
        id: repo.nextCommentId,
        body: typeof json.body === 'string' ? json.body : '',
        createdAt: forge.stamp(),
      };
      repo.nextCommentId += 1;
      issue.comments.push(comment);
      issue.version += 1;
      sendJson(res, 201, { id: comment.id, body: comment.body, created_at: comment.createdAt, user: { login: forge.viewerLogin } });
      return;
    }
  }
  throw new HttpError(404, 'Not Found');
}

function routePulls(
  res: ServerResponse,
  method: string,
  repo: Repo,
  sub: string[],
  query: URLSearchParams,
  json: Record<string, unknown>,
): void {
  if (sub.length === 0) {
    if (method === 'POST') {
      const pull = createPull(forge, repo, json);
      sendJson(res, 201, pullJson(forge, repo, pull));
      return;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let list = [...repo.pulls.values()].filter((p) => state === 'all' || p.state === state);
      list.sort((a, b) => a.number - b.number);
      const perPage = parseInt(query.get('per_page') ?? '30', 10) || 30;
      const page = parseInt(query.get('page') ?? '1', 10) || 1;
      list = list.slice((page - 1) * perPage, page * perPage);
      sendJson(res, 200, list.map((p) => pullJson(forge, repo, p)));
      return;
    }
  }
  const number = parseInt(sub[0] ?? '', 10);
  const pull = Number.isNaN(number) ? undefined : repo.pulls.get(number);
  if (!pull) throw new HttpError(404, 'Pull request not found');
  if (sub.length === 1 && method === 'GET') {
    sendJson(res, 200, pullJson(forge, repo, pull));
    return;
  }
  if (sub.length === 2 && sub[1] === 'files' && method === 'GET') {
    sendJson(res, 200, pullFiles(repo, pull).map((f) => ({
      filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.changes,
    })));
    return;
  }
  if (sub.length === 2 && sub[1] === 'merge' && method === 'PUT') {
    if (pull.merged && pull.mergeCommitSha) {
      sendJson(res, 200, { sha: pull.mergeCommitSha, merged: true, message: 'Pull Request successfully merged' });
      return;
    }
    if (pull.state !== 'open') throw new HttpError(405, 'Pull Request is not mergeable');
    const sha = mergePull(forge, repo, pull);
    sendJson(res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
    return;
  }
  throw new HttpError(404, 'Not Found');
}

// ------------------------------------------------------------------ GraphQL

function handleGraphQL(req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  if (!req.headers.authorization) {
    sendError(res, 401, 'Unauthorized');
    return;
  }
  if (!authed(req)) {
    sendError(res, 401, 'Unauthorized');
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => {
      const e = (entry ?? {}) as { query?: string; variables?: Record<string, unknown>; operationName?: string };
      return executeGraphQL(forge, e.query ?? '', e.variables ?? {}, e.operationName).body;
    });
    sendJson(res, 200, results);
    return;
  }
  const e = (parsed ?? {}) as { query?: string; variables?: Record<string, unknown>; operationName?: string };
  const result = executeGraphQL(forge, e.query ?? '', e.variables ?? {}, e.operationName);
  sendJson(res, result.status, result.body);
}

// ------------------------------------------------------------------ server

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const rawSegments = url.pathname.split('/').filter((s) => s.length > 0);
  const segments = rawSegments.map((s) => decode(s));

  if (url.pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (segments[0] === 'api' && segments[1] === 'graphql') {
    const body = await readBody(req);
    handleGraphQL(req, res, body);
    return;
  }
  if (segments[0] === 'mcp' && segments.length === 1) {
    const body = req.method === 'POST' ? await readBody(req) : Buffer.alloc(0);
    handleMcp(forge, req, res, body, token());
    return;
  }
  if (segments[0] === 'api' && segments[1] === 'v3') {
    const body = (req.method === 'GET' || req.method === 'HEAD') ? Buffer.alloc(0) : await readBody(req);
    handleRest(req, res, segments, url.searchParams, body);
    return;
  }
  // Git smart HTTP: /{owner}/{repo}.git/...
  if (segments.length >= 3 && (segments[1] as string).endsWith('.git')) {
    const owner = segments[0] as string;
    const repoName = (segments[1] as string).slice(0, -4);
    const body = req.method === 'POST' ? await readBody(req) : Buffer.alloc(0);
    const handled = handleGit(forge, req, res, owner, repoName, segments.slice(2), url.searchParams, body);
    if (handled) return;
  }
  sendError(res, 404, 'Not Found');
}

export function createApp(): Server {
  const server = httpCreateServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) sendError(res, 500, 'Internal error');
      else res.end();
    });
  });
  // Small responses on loopback should not wait on Nagle/delayed-ACK pairing.
  server.on('connection', (socket) => socket.setNoDelay(true));
  server.keepAliveTimeout = 75_000;
  server.headersTimeout = 76_000;
  return server;
}

export { ZERO_OID };

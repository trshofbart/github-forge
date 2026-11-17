// MCP over streamable HTTP (JSON-RPC 2.0, plain-JSON responses). Supports the
// modern server/discover negotiation (revision 2026-07-28) and the legacy
// initialize handshake. The tool list is a fixed literal so two tools/list
// calls are byte-identical.

import type { RawRequest, RawResponse } from './transport.ts';
import type { Forge, Repo } from './store.ts';
import { HttpError, repoJson, issueJson, pullJson, createIssue, createPull, mergePull } from './service.ts';

const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function schema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, additionalProperties: true, required };
}

export const MCP_TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: schema(
      {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      ['name'],
    ),
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: schema(
      {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      ['owner', 'repo'],
    ),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: schema(
      {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      ['owner', 'repo', 'title'],
    ),
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: schema(
      {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state filter: open, closed or all' },
      },
      ['owner', 'repo'],
    ),
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: schema(
      {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      ['owner', 'repo', 'title', 'head', 'base'],
    ),
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: schema(
      {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'number', description: 'Pull request number' },
      },
      ['owner', 'repo', 'pull_number'],
    ),
  },
];

interface RpcResponse {
  jsonrpc: '2.0';
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function ok(id: unknown, result: unknown): RpcResponse {
  return { jsonrpc: '2.0', id, result };
}
function fail(id: unknown, code: number, message: string): RpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolResult(payload: unknown, isError = false): Record<string, unknown> {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const out: Record<string, unknown> = { content: [{ type: 'text', text }], isError };
  if (!isError && payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
    out.structuredContent = payload;
  }
  return out;
}

function findRepo(forge: Forge, args: Record<string, unknown>): Repo | null {
  const owner = typeof args.owner === 'string' ? args.owner : forge.viewerLogin;
  const name = typeof args.repo === 'string' ? args.repo : typeof args.name === 'string' ? args.name : '';
  if (owner !== forge.viewerLogin) return null;
  return forge.repos.get(name) ?? null;
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): RpcResponse | null {
  // Returns null when the tool name is unknown (caller maps to -32602).
  const tool = MCP_TOOLS.find((t) => t.name === name);
  if (!tool) return null;
  const required = (tool.inputSchema.required as string[]) ?? [];
  for (const key of required) {
    if (args[key] === undefined || args[key] === null || args[key] === '') {
      return fail(null, -32602, `Missing required argument: ${key}`);
    }
  }
  try {
    switch (name) {
      case 'create_repo': {
        const repoName = String(args.name ?? '');
        const created = forge.createRepo(repoName, typeof args.description === 'string' ? args.description : '', args.private !== false);
        if (created === 'exists') return ok(null, toolResult(`Repository ${repoName} already exists`, true));
        return ok(null, toolResult(repoJson(forge, created)));
      }
      case 'get_repo': {
        const repo = findRepo(forge, args);
        if (!repo) return ok(null, toolResult('Repository not found', true));
        return ok(null, toolResult(repoJson(forge, repo)));
      }
      case 'create_issue': {
        const repo = findRepo(forge, args);
        if (!repo) return ok(null, toolResult('Repository not found', true));
        const issue = createIssue(forge, repo, { title: args.title, body: args.body });
        return ok(null, toolResult(issueJson(forge, repo, issue)));
      }
      case 'list_issues': {
        const repo = findRepo(forge, args);
        if (!repo) return ok(null, toolResult('Repository not found', true));
        const state = typeof args.state === 'string' ? args.state : 'open';
        const list = [...repo.issues.values()]
          .filter((i) => state === 'all' || i.state === state)
          .sort((a, b) => a.number - b.number)
          .map((i) => issueJson(forge, repo, i));
        return ok(null, toolResult(list));
      }
      case 'create_pull_request': {
        const repo = findRepo(forge, args);
        if (!repo) return ok(null, toolResult('Repository not found', true));
        const pull = createPull(forge, repo, { title: args.title, body: args.body, head: args.head, base: args.base });
        return ok(null, toolResult(pullJson(forge, repo, pull)));
      }
      case 'merge_pull_request': {
        const repo = findRepo(forge, args);
        if (!repo) return ok(null, toolResult('Repository not found', true));
        const pull = repo.pulls.get(Number(args.pull_number));
        if (!pull) return ok(null, toolResult('Pull request not found', true));
        mergePull(forge, repo, pull);
        return ok(null, toolResult(pullJson(forge, repo, pull)));
      }
    }
  } catch (err) {
    if (err instanceof HttpError) return ok(null, toolResult(err.message, true));
    throw err;
  }
  return null;
}

export function handleMcp(forge: Forge, req: RawRequest, res: RawResponse, body: Buffer, token: string): void {
  const send = (status: number, payload: unknown): void => {
    const text = payload === null ? '' : JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(text);
  };
  if (req.method === 'DELETE') {
    send(200, {});
    return;
  }
  if (req.method === 'GET') {
    send(405, { message: 'Method not allowed' });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    send(400, fail(null, -32700, 'Parse error'));
    return;
  }
  const auth = req.headers.authorization ?? '';
  if (auth !== `Bearer ${token}`) {
    send(401, { message: 'Unauthorized' });
    return;
  }
  const rpc = (parsed ?? {}) as { id?: unknown; method?: unknown; params?: Record<string, unknown> };
  const id = rpc.id ?? null;
  const method = typeof rpc.method === 'string' ? rpc.method : '';
  const params = (rpc.params ?? {}) as Record<string, unknown>;

  if (method === 'server/discover' || method === 'discover') {
    send(200, ok(id, {
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    }));
    return;
  }
  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const protocolVersion = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
    send(200, ok(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO }));
    return;
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    res.writeHead(204);
    res.end();
    return;
  }
  if (method === 'tools/list') {
    send(200, ok(id, { tools: MCP_TOOLS }));
    return;
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const result = callTool(forge, name, args);
    if (result === null) {
      send(200, fail(id, -32602, `Unknown tool: ${name}`));
      return;
    }
    if (result.error) {
      send(200, { ...result, id });
      return;
    }
    send(200, { ...result, id });
    return;
  }
  if (method === 'ping') {
    send(200, ok(id, {}));
    return;
  }
  send(200, fail(id, -32601, `Method not found: ${method}`));
}

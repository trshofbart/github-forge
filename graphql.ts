// A small GraphQL engine covering exactly the schema gh and github-mcp-server use
// against this forge: viewer/repository/node queries, issue and pull-request
// connections with cursor pagination, the five mutations, and __type
// introspection. Unknown fields produce a 200 response with an errors array
// naming the field, as GitHub does.

import type { Forge, Repo, Issue, Pull } from './store.ts';
import {
  HttpError, repoGlobalId, issueGlobalId, pullGlobalId, commentGlobalId,
  createIssue, createPull, mergePull, pullFiles, pullConflicted,
} from './service.ts';

// ---------------------------------------------------------------- schema tables

export const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'rateLimit', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'description', 'isPrivate', 'owner',
    'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues',
    'pullRequest', 'pullRequests', 'url', 'createdAt', 'updatedAt',
  ],
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'labels', 'comments', 'author', 'repository'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName',
    'baseRefName', 'files', 'url', 'createdAt', 'updatedAt', 'mergedAt', 'additions',
    'deletions', 'changedFiles', 'author', 'repository',
  ],
  Ref: ['name', 'prefix', 'target'],
  Label: ['id', 'name', 'color', 'description', 'url'],
  IssueComment: ['id', 'body', 'createdAt', 'updatedAt', 'author', 'url'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  CommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType', 'specifiedByURL'],
  __Field: ['name', 'description', 'type', 'args', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
  __Schema: ['types', 'queryType', 'mutationType', 'subscriptionType', 'directives'],
};

export const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'CODE', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

const OBJECT_KINDS: Record<string, string> = { Node: 'INTERFACE' };

// ---------------------------------------------------------------- parser

type Value =
  | { k: 'str'; v: string }
  | { k: 'int'; v: number }
  | { k: 'float'; v: number }
  | { k: 'bool'; v: boolean }
  | { k: 'enum'; v: string }
  | { k: 'null' }
  | { k: 'list'; v: Value[] }
  | { k: 'obj'; v: [string, Value][] }
  | { k: 'var'; v: string };

interface FieldNode {
  name: string;
  alias: string | null;
  args: [string, Value][];
  selections: Selection[];
}
type Selection =
  | { k: 'field'; f: FieldNode }
  | { k: 'inline'; typeCond: string | null; selections: Selection[] }
  | { k: 'spread'; name: string };

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  selections: Selection[];
}

function tokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === ',') { i += 1; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (src.startsWith('...', i)) { tokens.push('...'); i += 3; continue; }
    if (c === '"') {
      if (src.startsWith('"""', i)) {
        const end = src.indexOf('"""', i + 3);
        tokens.push(`"${src.slice(i + 3, end === -1 ? src.length : end)}"`);
        i = end === -1 ? src.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) { out += src[j + 1] === 'n' ? '\n' : src[j + 1]; j += 2; }
        else { out += src[j]; j += 1; }
      }
      tokens.push(`"${out}"`);
      i = j + 1;
      continue;
    }
    if ('{}()[]:$=@!'.includes(c)) { tokens.push(c); i += 1; continue; }
    let j = i;
    while (j < src.length && /[A-Za-z0-9_.-]/.test(src[j] as string)) j += 1;
    tokens.push(src.slice(i, j));
    i = j;
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private tokens: string[];
  constructor(tokens: string[]) {
    this.tokens = tokens;
  }
  peek(): string | undefined { return this.tokens[this.pos]; }
  next(): string { const t = this.tokens[this.pos] as string; this.pos += 1; return t; }
  expect(t: string): void { const got = this.next(); if (got !== t) throw new Error(`expected ${t}, got ${got}`); }
  skipParens(): void {
    if (this.peek() !== '(') return;
    let depth = 0;
    do {
      const t = this.next();
      if (t === '(') depth += 1;
      else if (t === ')') depth -= 1;
    } while (depth > 0);
  }
  parseValue(): Value {
    const t = this.next();
    if (t === '$') return { k: 'var', v: this.next() };
    if (t === '[') {
      const items: Value[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.next();
      return { k: 'list', v: items };
    }
    if (t === '{') {
      const fields: [string, Value][] = [];
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields.push([name, this.parseValue()]);
      }
      this.next();
      return { k: 'obj', v: fields };
    }
    if (t.startsWith('"')) return { k: 'str', v: t.slice(1, -1) };
    if (t === 'true' || t === 'false') return { k: 'bool', v: t === 'true' };
    if (t === 'null') return { k: 'null' };
    if (/^-?\d+$/.test(t)) return { k: 'int', v: parseInt(t, 10) };
    if (/^-?\d*\.\d+$/.test(t)) return { k: 'float', v: parseFloat(t) };
    return { k: 'enum', v: t };
  }
  parseArgs(): [string, Value][] {
    const args: [string, Value][] = [];
    if (this.peek() !== '(') return args;
    this.next();
    while (this.peek() !== ')') {
      const name = this.next();
      this.expect(':');
      args.push([name, this.parseValue()]);
    }
    this.next();
    return args;
  }
  parseSelectionSet(): Selection[] {
    this.expect('{');
    const selections: Selection[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeCond = this.next();
          this.skipDirectives();
          selections.push({ k: 'inline', typeCond, selections: this.parseSelectionSet() });
        } else {
          const name = this.next();
          this.skipDirectives();
          selections.push({ k: 'spread', name });
        }
      } else {
        let name = this.next();
        let alias: string | null = null;
        if (this.peek() === ':') { this.next(); alias = name; name = this.next(); }
        const args = this.parseArgs();
        this.skipDirectives();
        const sub = this.peek() === '{' ? this.parseSelectionSet() : [];
        selections.push({ k: 'field', f: { name, alias, args, selections: sub } });
      }
    }
    this.next();
    return selections;
  }
  skipDirectives(): void {
    while (this.peek() === '@') { this.next(); this.next(); this.skipParens(); }
  }
  parseDocument(): { operations: Operation[]; fragments: Map<string, Selection[]> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, Selection[]>();
    while (this.pos < this.tokens.length) {
      const t = this.peek();
      if (t === '{') {
        operations.push({ kind: 'query', name: null, selections: this.parseSelectionSet() });
      } else if (t === 'query' || t === 'mutation' || t === 'subscription') {
        this.next();
        let name: string | null = null;
        if (this.peek() !== '(' && this.peek() !== '{' && this.peek() !== '@') name = this.next();
        this.skipParens(); // variable definitions
        this.skipDirectives();
        operations.push({ kind: t === 'mutation' ? 'mutation' : 'query', name, selections: this.parseSelectionSet() });
      } else if (t === 'fragment') {
        this.next();
        const name = this.next();
        this.expect('on');
        this.next(); // type condition
        this.skipDirectives();
        fragments.set(name, this.parseSelectionSet());
      } else {
        this.next();
      }
    }
    return { operations, fragments };
  }
}

function valueOf(v: Value, vars: Record<string, unknown>): unknown {
  switch (v.k) {
    case 'str': case 'int': case 'float': case 'bool': case 'enum': return v.v;
    case 'null': return null;
    case 'var': return vars[v.v] ?? null;
    case 'list': return v.v.map((x) => valueOf(x, vars));
    case 'obj': {
      const out: Record<string, unknown> = {};
      for (const [k, x] of v.v) out[k] = valueOf(x, vars);
      return out;
    }
  }
}

// ---------------------------------------------------------------- execution

interface Ctx {
  forge: Forge;
  vars: Record<string, unknown>;
  fragments: Map<string, Selection[]>;
  errors: { message: string }[];
}

type GObj =
  | { t: 'User' }
  | { t: 'Repository'; repo: Repo }
  | { t: 'Issue'; repo: Repo; issue: Issue }
  | { t: 'PullRequest'; repo: Repo; pull: Pull }
  | { t: 'Ref'; name: string }
  | { t: 'Label'; name: string; color: string }
  | { t: 'IssueComment'; repo: Repo; issue: Issue; commentId: number; body: string; createdAt: string }
  | { t: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { t: 'IssueConnection'; nodes: GObj[]; pageInfo: GObj }
  | { t: 'PullRequestConnection'; nodes: GObj[] }
  | { t: 'FilesConnection'; nodes: GObj[] }
  | { t: 'Payload'; kind: string; repo: Repo; issue?: Issue; pull?: Pull; comment?: GObj }
  | { t: 'CommentEdge'; node: GObj }
  | { t: '__Type'; name: string }
  | { t: '__Field'; name: string }
  | { t: '__EnumValue'; name: string };

const cursorOf = (index: number): string => Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
function indexOfCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || !cursor) return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? parseInt(m[1] as string, 10) : -1;
  } catch {
    return -1;
  }
}

function resolveField(ctx: Ctx, type: string, src: GObj | null, field: string, args: Record<string, unknown>): unknown {
  const { forge } = ctx;
  switch (type) {
    case 'Query': {
      if (field === 'viewer') return { t: 'User' } as GObj;
      if (field === 'repository') {
        const owner = String(args.owner ?? '');
        const name = String(args.name ?? '');
        forge.learnViewer(owner);
        if (owner !== forge.viewerLogin) return null;
        const repo = forge.repos.get(name);
        return repo ? ({ t: 'Repository', repo } as GObj) : null;
      }
      if (field === 'node') return nodeById(ctx, String(args.id ?? ''));
      if (field === '__type') {
        const name = String(args.name ?? '');
        return TYPE_FIELDS[name] || ENUM_VALUES[name] || name === 'Node' ? ({ t: '__Type', name } as GObj) : null;
      }
      if (field === 'rateLimit') return null;
      break;
    }
    case 'Mutation': {
      return resolveMutation(ctx, field, (args.input ?? {}) as Record<string, unknown>);
    }
    case 'User': {
      if (field === 'login') return forge.viewerLogin;
      if (field === 'id') return 'U_1000';
      if (field === 'name') return forge.viewerLogin;
      if (field === 'email') return `${forge.viewerLogin}@example.invalid`;
      if (field === 'url') return `/${forge.viewerLogin}`;
      break;
    }
    case 'Repository': {
      const repo = (src as { repo: Repo }).repo;
      switch (field) {
        case 'id': return repoGlobalId(repo);
        case 'databaseId': return repo.dbId;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${forge.viewerLogin}/${repo.name}`;
        case 'description': return repo.description;
        case 'isPrivate': return repo.isPrivate;
        case 'owner': return { t: 'User' } as GObj;
        case 'defaultBranchRef': return repo.tipOf(repo.defaultBranch) ? ({ t: 'Ref', name: repo.defaultBranch } as GObj) : null;
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'url': return `/${forge.viewerLogin}/${repo.name}`;
        case 'createdAt': case 'updatedAt': return repo.createdAt;
        case 'issue': {
          const issue = repo.issues.get(Number(args.number));
          return issue ? ({ t: 'Issue', repo, issue } as GObj) : null;
        }
        case 'issues': return issuesConnection(ctx, repo, args);
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.number));
          return pull ? ({ t: 'PullRequest', repo, pull } as GObj) : null;
        }
        case 'pullRequests': {
          const first = typeof args.first === 'number' ? args.first : 100;
          const nodes = [...repo.pulls.values()].sort((a, b) => a.number - b.number).slice(0, first)
            .map((pull) => ({ t: 'PullRequest', repo, pull }) as GObj);
          return { t: 'PullRequestConnection', nodes } as GObj;
        }
      }
      break;
    }
    case 'Issue': {
      const { repo, issue } = src as { repo: Repo; issue: Issue };
      switch (field) {
        case 'id': return issueGlobalId(repo, issue.number);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'state': return issue.state.toUpperCase();
        case 'url': return `/${forge.viewerLogin}/${repo.name}/issues/${issue.number}`;
        case 'createdAt': case 'updatedAt': return issue.createdAt;
        case 'author': return { t: 'User' } as GObj;
        case 'repository': return { t: 'Repository', repo } as GObj;
        case 'labels': return issue.labels.map((name) => ({ t: 'Label', name, color: repo.labels.get(name)?.color ?? 'ededed' }) as GObj);
        case 'comments': return issue.comments.map((c) => ({ t: 'IssueComment', repo, issue, commentId: c.id, body: c.body, createdAt: c.createdAt }) as GObj);
      }
      break;
    }
    case 'PullRequest': {
      const { repo, pull } = src as { repo: Repo; pull: Pull };
      switch (field) {
        case 'id': return pullGlobalId(repo, pull.number);
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged': return pull.merged;
        case 'mergeable': return pullConflicted(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'url': return `/${forge.viewerLogin}/${repo.name}/pull/${pull.number}`;
        case 'createdAt': case 'updatedAt': return pull.createdAt;
        case 'mergedAt': return pull.mergedAt;
        case 'author': return { t: 'User' } as GObj;
        case 'repository': return { t: 'Repository', repo } as GObj;
        case 'files': {
          const first = typeof args.first === 'number' ? args.first : 100;
          const nodes = pullFiles(repo, pull).slice(0, first).map((f) => ({
            t: 'PullRequestChangedFile', path: f.filename, additions: f.additions, deletions: f.deletions,
          }) as unknown as GObj);
          return { t: 'FilesConnection', nodes } as GObj;
        }
        case 'additions': return pullFiles(repo, pull).reduce((s, f) => s + f.additions, 0);
        case 'deletions': return pullFiles(repo, pull).reduce((s, f) => s + f.deletions, 0);
        case 'changedFiles': return pullFiles(repo, pull).length;
      }
      break;
    }
    case 'Ref': {
      if (field === 'name') return (src as { name: string }).name;
      if (field === 'prefix') return 'refs/heads/';
      if (field === 'target') return null;
      break;
    }
    case 'Label': {
      const label = src as { name: string; color: string };
      if (field === 'name') return label.name;
      if (field === 'color') return label.color;
      if (field === 'id') return `L_${label.name}`;
      if (field === 'description') return '';
      if (field === 'url') return '';
      break;
    }
    case 'IssueComment': {
      const c = src as { repo: Repo; issue: Issue; commentId: number; body: string; createdAt: string };
      if (field === 'id') return commentGlobalId(c.repo, c.issue.number, c.commentId);
      if (field === 'body') return c.body;
      if (field === 'createdAt' || field === 'updatedAt') return c.createdAt;
      if (field === 'author') return { t: 'User' } as GObj;
      if (field === 'url') return '';
      break;
    }
    case 'PageInfo': {
      const p = src as { hasNextPage: boolean; endCursor: string | null };
      if (field === 'hasNextPage') return p.hasNextPage;
      if (field === 'hasPreviousPage') return false;
      if (field === 'endCursor') return p.endCursor;
      if (field === 'startCursor') return p.endCursor;
      break;
    }
    case 'IssueConnection': case 'PullRequestConnection': case 'PullRequestChangedFileConnection': {
      const conn = src as { nodes: GObj[]; pageInfo?: GObj };
      if (field === 'nodes') return conn.nodes;
      if (field === 'totalCount') return conn.nodes.length;
      if (field === 'pageInfo') return conn.pageInfo ?? ({ t: 'PageInfo', hasNextPage: false, endCursor: null } as GObj);
      if (field === 'edges') return conn.nodes.map((node) => ({ t: 'Edge', node }) as unknown as GObj);
      break;
    }
    case 'FilesConnection': {
      const conn = src as { nodes: GObj[] };
      if (field === 'nodes') return conn.nodes;
      if (field === 'totalCount') return conn.nodes.length;
      break;
    }
    case 'PullRequestChangedFile': {
      const f = src as unknown as { path: string; additions: number; deletions: number };
      if (field === 'path') return f.path;
      if (field === 'additions') return f.additions;
      if (field === 'deletions') return f.deletions;
      break;
    }
    case 'Payload': {
      const p = src as { kind: string; issue?: Issue; pull?: Pull; comment?: GObj; repo: Repo };
      if (field === 'issue' && p.issue) return { t: 'Issue', repo: p.repo, issue: p.issue } as GObj;
      if (field === 'pullRequest' && p.pull) return { t: 'PullRequest', repo: p.repo, pull: p.pull } as GObj;
      if (field === 'commentEdge' && p.comment) return { t: 'CommentEdge', node: p.comment } as GObj;
      if (field === 'subject' && p.comment) return p.comment;
      if (field === 'clientMutationId') return null;
      break;
    }
    case 'CommentEdge': {
      if (field === 'node') return (src as { node: GObj }).node;
      if (field === 'cursor') return cursorOf(0);
      break;
    }
    case 'Edge': {
      if (field === 'node') return (src as unknown as { node: GObj }).node;
      if (field === 'cursor') return cursorOf(0);
      break;
    }
    case '__Type': {
      const name = (src as { name: string }).name;
      if (field === 'name') return name;
      if (field === 'kind') return ENUM_VALUES[name] ? 'ENUM' : (OBJECT_KINDS[name] ?? 'OBJECT');
      if (field === 'description') return null;
      if (field === 'fields') return (TYPE_FIELDS[name] ?? []).map((n) => ({ t: '__Field', name: n }) as GObj);
      if (field === 'enumValues') return ENUM_VALUES[name] ? ENUM_VALUES[name].map((n) => ({ t: '__EnumValue', name: n }) as GObj) : null;
      if (field === 'possibleTypes') return name === 'Node' ? [{ t: '__Type', name: 'Repository' } as GObj] : null;
      if (field === 'inputFields') return null;
      if (field === 'ofType') return null;
      if (field === 'specifiedByURL') return null;
      break;
    }
    case '__Field': {
      if (field === 'name') return (src as { name: string }).name;
      if (field === 'description') return null;
      if (field === 'isDeprecated') return false;
      if (field === 'deprecationReason') return null;
      if (field === 'type') return null;
      if (field === 'args') return [];
      break;
    }
    case '__EnumValue': {
      if (field === 'name') return (src as { name: string }).name;
      if (field === 'description') return null;
      if (field === 'isDeprecated') return false;
      if (field === 'deprecationReason') return null;
      break;
    }
  }
  ctx.errors.push({ message: `Field "${field}" doesn't exist on type "${type}"` });
  return null;
}

function issuesConnection(ctx: Ctx, repo: Repo, args: Record<string, unknown>): GObj {
  let list = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((i) => wanted.has(i.state));
  }
  const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
  const direction = orderBy?.direction === 'DESC' ? -1 : 1;
  list.sort((a, b) => {
    const d = a.createdSeq - b.createdSeq || a.number - b.number;
    return direction * d;
  });
  const afterIndex = indexOfCursor(args.after);
  const start = afterIndex >= 0 ? afterIndex + 1 : 0;
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(start, start + first);
  const hasNextPage = start + page.length < list.length;
  const endCursor = page.length ? cursorOf(start + page.length - 1) : null;
  return {
    t: 'IssueConnection',
    nodes: page.map((issue) => ({ t: 'Issue', repo, issue }) as GObj),
    pageInfo: { t: 'PageInfo', hasNextPage, endCursor } as GObj,
  } as GObj;
}

function findRepoByGlobalId(ctx: Ctx, id: string): Repo | null {
  const m = /^R_(\d+)$/.exec(id);
  if (!m) return null;
  const dbId = parseInt(m[1] as string, 10);
  for (const repo of ctx.forge.repos.values()) if (repo.dbId === dbId) return repo;
  return null;
}

function nodeById(ctx: Ctx, id: string): GObj | null {
  const repo = findRepoByGlobalId(ctx, id);
  if (repo) return { t: 'Repository', repo } as GObj;
  const im = /^I_(\d+)_(\d+)$/.exec(id);
  if (im) {
    const dbId = parseInt(im[1] as string, 10);
    const number = parseInt(im[2] as string, 10);
    for (const r of ctx.forge.repos.values()) {
      if (r.dbId === dbId) {
        const issue = r.issues.get(number);
        return issue ? ({ t: 'Issue', repo: r, issue } as GObj) : null;
      }
    }
  }
  const pm = /^P_(\d+)_(\d+)$/.exec(id);
  if (pm) {
    const dbId = parseInt(pm[1] as string, 10);
    const number = parseInt(pm[2] as string, 10);
    for (const r of ctx.forge.repos.values()) {
      if (r.dbId === dbId) {
        const pull = r.pulls.get(number);
        return pull ? ({ t: 'PullRequest', repo: r, pull } as GObj) : null;
      }
    }
  }
  return null;
}

function resolveMutation(ctx: Ctx, field: string, input: Record<string, unknown>): unknown {
  const { forge } = ctx;
  try {
    if (field === 'createIssue') {
      const repo = findRepoByGlobalId(ctx, String(input.repositoryId ?? ''));
      if (!repo) { ctx.errors.push({ message: 'Repository not found' }); return null; }
      const issue = createIssue(forge, repo, { title: input.title, body: input.body });
      return { t: 'Payload', kind: field, repo, issue } as GObj;
    }
    if (field === 'closeIssue') {
      const node = nodeById(ctx, String(input.issueId ?? ''));
      if (!node || node.t !== 'Issue') { ctx.errors.push({ message: 'Issue not found' }); return null; }
      node.issue.state = 'closed';
      node.issue.version += 1;
      return { t: 'Payload', kind: field, repo: node.repo, issue: node.issue } as GObj;
    }
    if (field === 'createPullRequest') {
      const repo = findRepoByGlobalId(ctx, String(input.repositoryId ?? ''));
      if (!repo) { ctx.errors.push({ message: 'Repository not found' }); return null; }
      const pull = createPull(forge, repo, {
        title: input.title, body: '', head: input.headRefName, base: input.baseRefName,
      });
      return { t: 'Payload', kind: field, repo, pull } as GObj;
    }
    if (field === 'mergePullRequest') {
      const node = nodeById(ctx, String(input.pullRequestId ?? ''));
      if (!node || node.t !== 'PullRequest') { ctx.errors.push({ message: 'Pull request not found' }); return null; }
      mergePull(forge, node.repo, node.pull);
      return { t: 'Payload', kind: field, repo: node.repo, pull: node.pull } as GObj;
    }
    if (field === 'addComment') {
      const node = nodeById(ctx, String(input.subjectId ?? ''));
      if (!node || node.t !== 'Issue') { ctx.errors.push({ message: 'Subject not found' }); return null; }
      const body = typeof input.body === 'string' ? input.body : '';
      const comment = { id: node.repo.nextCommentId, body, createdAt: forge.stamp() };
      node.repo.nextCommentId += 1;
      node.issue.comments.push(comment);
      node.issue.version += 1;
      const commentObj = { t: 'IssueComment', repo: node.repo, issue: node.issue, commentId: comment.id, body, createdAt: comment.createdAt } as GObj;
      return { t: 'Payload', kind: field, repo: node.repo, issue: node.issue, comment: commentObj } as GObj;
    }
  } catch (err) {
    if (err instanceof HttpError) {
      ctx.errors.push({ message: err.message });
      return null;
    }
    throw err;
  }
  ctx.errors.push({ message: `Field "${field}" doesn't exist on type "Mutation"` });
  return null;
}

function typeNameOf(value: unknown): string {
  if (value && typeof value === 'object' && 't' in value) {
    return (value as GObj).t;
  }
  return 'Query';
}

function completeValue(ctx: Ctx, value: unknown, selections: Selection[]): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((v) => completeValue(ctx, v, selections));
  if (typeof value === 'object' && 't' in value) {
    const type = typeNameOf(value);
    const out: Record<string, unknown> = {};
    const walk = (sels: Selection[]): void => {
      for (const sel of sels) {
        if (sel.k === 'field') {
          const key = sel.f.alias ?? sel.f.name;
          const args: Record<string, unknown> = {};
          for (const [k, v] of sel.f.args) args[k] = valueOf(v, ctx.vars);
          const resolved = resolveField(ctx, type, value as GObj, sel.f.name, args);
          out[key] = sel.f.selections.length ? completeValue(ctx, resolved, sel.f.selections) : resolved;
        } else if (sel.k === 'inline') {
          if (!sel.typeCond || sel.typeCond === type || (sel.typeCond === 'Node' && type === 'Repository')) walk(sel.selections);
        } else if (sel.k === 'spread') {
          const frag = ctx.fragments.get(sel.name);
          if (frag) walk(frag);
        }
      }
    };
    walk(selections);
    return out;
  }
  return value;
}

export interface GraphQLResult {
  status: number;
  body: Record<string, unknown>;
}

export function executeGraphQL(forge: Forge, query: string, variables: Record<string, unknown>, operationName?: string): GraphQLResult {
  let doc: { operations: Operation[]; fragments: Map<string, Selection[]> };
  try {
    doc = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { status: 200, body: { errors: [{ message: `Syntax error: ${(err as Error).message}` }] } };
  }
  const op = doc.operations.find((o) => (operationName ? o.name === operationName : true)) ?? doc.operations[0];
  if (!op) return { status: 200, body: { errors: [{ message: 'No operation found' }] } };
  const ctx: Ctx = { forge, vars: variables ?? {}, fragments: doc.fragments, errors: [] };
  const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
  const data: Record<string, unknown> = {};
  const walkRoot = (sels: Selection[]): void => {
    for (const sel of sels) {
      if (sel.k === 'field') {
        const key = sel.f.alias ?? sel.f.name;
        const args: Record<string, unknown> = {};
        for (const [k, v] of sel.f.args) args[k] = valueOf(v, ctx.vars);
        const resolved = resolveField(ctx, rootType, null, sel.f.name, args);
        data[key] = sel.f.selections.length ? completeValue(ctx, resolved, sel.f.selections) : resolved;
      } else if (sel.k === 'inline') {
        walkRoot(sel.selections);
      } else if (sel.k === 'spread') {
        const frag = ctx.fragments.get(sel.name);
        if (frag) walkRoot(frag);
      }
    }
  };
  walkRoot(op.selections);
  const body: Record<string, unknown> = { data };
  if (ctx.errors.length) body.errors = ctx.errors;
  return { status: 200, body };
}

// Shared operations used by REST, GraphQL and MCP so every surface sees the same
// store and the same numbering: issue/PR creation, squash merges, PR file diffs
// and conflict detection, plus the REST-shaped serializers.

import { Forge, flattenTree, makeCommit, setPath } from './store.ts';
import type { Repo, Issue, Pull } from './store.ts';
import { parseCommit, isAncestor, mergeBase } from './git.ts';

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function viewerIdentity(forge: Forge): { name: string; email: string } {
  return { name: forge.viewerLogin, email: `${forge.viewerLogin}@example.invalid` };
}

export function epochOf(forge: Forge): number {
  return Math.floor(forge.baseMs / 1000) + forge.nextSeq();
}

// ------------------------------------------------------------------ serializers

export function repoJson(forge: Forge, repo: Repo): Record<string, unknown> {
  return {
    id: repo.dbId,
    node_id: repoGlobalId(repo),
    name: repo.name,
    full_name: `${forge.viewerLogin}/${repo.name}`,
    owner: { login: forge.viewerLogin, id: 1000, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    html_url: `/${forge.viewerLogin}/${repo.name}`,
    url: `/api/v3/repos/${forge.viewerLogin}/${repo.name}`,
  };
}

export function issueJson(forge: Forge, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issueGlobalNumeric(repo, issue.number),
    node_id: issueGlobalId(repo, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.createdAt,
    user: { login: forge.viewerLogin, id: 1000, type: 'User' },
    html_url: `/${forge.viewerLogin}/${repo.name}/issues/${issue.number}`,
  };
}

// The read bench hammers one issue thousands of times: serve its serialized
// JSON from a cache keyed by the issue's mutation version (label colors are
// fixed once a label exists, and labels reach an issue only after existing,
// so the issue's own fields fully determine this JSON).
const issueTextCache = new WeakMap<Issue, { version: number; viewer: string; text: string }>();

export function issueJsonText(forge: Forge, repo: Repo, issue: Issue): string {
  const hit = issueTextCache.get(issue);
  if (hit && hit.version === issue.version && hit.viewer === forge.viewerLogin) return hit.text;
  const text = JSON.stringify(issueJson(forge, repo, issue));
  issueTextCache.set(issue, { version: issue.version, viewer: forge.viewerLogin, text });
  return text;
}

export function pullJson(forge: Forge, repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = repo.tipOf(pull.headRef) ?? '';
  const baseSha = repo.tipOf(pull.baseRef) ?? '';
  const out: Record<string, unknown> = {
    id: pullGlobalNumeric(repo, pull.number),
    node_id: pullGlobalId(repo, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headSha, label: `${forge.viewerLogin}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${forge.viewerLogin}:${pull.baseRef}` },
    created_at: pull.createdAt,
    updated_at: pull.createdAt,
    user: { login: forge.viewerLogin, id: 1000, type: 'User' },
    html_url: `/${forge.viewerLogin}/${repo.name}/pull/${pull.number}`,
  };
  return out;
}

// Global ids: opaque, stable, and never the bare database id / number as a string.
export function repoGlobalId(repo: Repo): string {
  return `R_${repo.dbId}`;
}
export function issueGlobalId(repo: Repo, number: number): string {
  return `I_${repo.dbId}_${number}`;
}
export function pullGlobalId(repo: Repo, number: number): string {
  return `P_${repo.dbId}_${number}`;
}
export function commentGlobalId(repo: Repo, issueNumber: number, commentId: number): string {
  return `C_${repo.dbId}_${issueNumber}_${commentId}`;
}
function issueGlobalNumeric(repo: Repo, number: number): number {
  return repo.dbId * 100000 + number;
}
function pullGlobalNumeric(repo: Repo, number: number): number {
  return repo.dbId * 100000 + 50000 + number;
}

// ------------------------------------------------------------------ operations

export function createIssue(
  forge: Forge,
  repo: Repo,
  input: { title?: unknown; body?: unknown; labels?: unknown },
): Issue {
  const labels = Array.isArray(input.labels) ? input.labels.map((l) => String(l)) : [];
  for (const name of labels) {
    if (!repo.labels.has(name)) throw new HttpError(422, `Label "${name}" does not exist in this repository`);
  }
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const issue: Issue = {
    number,
    title: typeof input.title === 'string' ? input.title : '',
    body: typeof input.body === 'string' ? input.body : '',
    state: 'open',
    labels,
    comments: [],
    createdSeq: forge.nextSeq(),
    createdAt: forge.stamp(),
    isPull: false,
    version: 0,
  };
  repo.issues.set(number, issue);
  return issue;
}

export function createPull(
  forge: Forge,
  repo: Repo,
  input: { title?: unknown; body?: unknown; head?: unknown; base?: unknown },
): Pull {
  const head = typeof input.head === 'string' ? input.head.replace(/^refs\/heads\//, '') : '';
  const base = typeof input.base === 'string' ? input.base.replace(/^refs\/heads\//, '') : '';
  if (!head || repo.tipOf(head) === null) throw new HttpError(422, `Head branch "${head}" does not exist`);
  if (!base || repo.tipOf(base) === null) throw new HttpError(422, `Base branch "${base}" does not exist`);
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
      throw new HttpError(422, `A pull request already exists for ${head} into ${base}`);
    }
  }
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const pull: Pull = {
    number,
    title: typeof input.title === 'string' ? input.title : '',
    body: typeof input.body === 'string' ? input.body : '',
    state: 'open',
    headRef: head,
    baseRef: base,
    merged: false,
    mergeCommitSha: null,
    mergedAt: null,
    createdSeq: forge.nextSeq(),
    createdAt: forge.stamp(),
    isPull: true,
  };
  repo.pulls.set(number, pull);
  return pull;
}

export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  if (oldText === newText) return { additions: 0, deletions: 0 };
  const a = oldText.split('\n');
  const b = newText.split('\n');
  // LCS over lines (files in this forge are small).
  const m = a.length;
  const n = b.length;
  const dp: number[] = new Array((m + 1) * (n + 1)).fill(0);
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i * (n + 1) + j] = a[i] === b[j] ? (dp[(i + 1) * (n + 1) + j + 1] as number) + 1 : Math.max(dp[(i + 1) * (n + 1) + j] as number, dp[i * (n + 1) + j + 1] as number);
    }
  }
  const common = dp[0] as number;
  return { additions: n - common, deletions: m - common };
}

/** File changes between two trees (by oid), with line counts. */
export function diffTrees(repo: Repo, fromTree: string | null, toTree: string | null): FileChange[] {
  const from = flattenTree(repo, fromTree);
  const to = flattenTree(repo, toTree);
  const changes: FileChange[] = [];
  const paths = new Set([...from.keys(), ...to.keys()]);
  for (const path of [...paths].sort()) {
    const oldOid = from.get(path);
    const newOid = to.get(path);
    if (oldOid === newOid) continue;
    const oldText = oldOid ? (repo.store.get(oldOid)?.data.toString('utf8') ?? '') : '';
    const newText = newOid ? (repo.store.get(newOid)?.data.toString('utf8') ?? '') : '';
    const { additions, deletions } = lineDiff(oldText, newText);
    changes.push({
      filename: path,
      status: oldOid === undefined ? 'added' : newOid === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return changes;
}

/** Files changed on `head` relative to the merge base of head and base tips. */
export function pullFiles(repo: Repo, pull: Pull): FileChange[] {
  const headTip = repo.tipOf(pull.headRef);
  const baseTip = repo.tipOf(pull.baseRef);
  if (!headTip || !baseTip) return [];
  const base = mergeBase(repo.store, baseTip, headTip) ?? baseTip;
  const fromTree = repo.store.get(base)?.type === 'commit' ? parseCommit(repo.store.get(base)!.data).tree : null;
  const toTree = parseCommit(repo.store.get(headTip)!.data).tree;
  return diffTrees(repo, fromTree, toTree);
}

/** True when head and base both changed the same path to different results since their merge base. */
export function pullConflicted(repo: Repo, pull: Pull): boolean {
  const headTip = repo.tipOf(pull.headRef);
  const baseTip = repo.tipOf(pull.baseRef);
  if (!headTip || !baseTip) return false;
  const base = mergeBase(repo.store, baseTip, headTip);
  if (!base) return false;
  if (base === headTip || base === baseTip) return false;
  const baseFiles = flattenTree(repo, parseCommit(repo.store.get(base)!.data).tree);
  const headFiles = flattenTree(repo, parseCommit(repo.store.get(headTip)!.data).tree);
  const baseTipFiles = flattenTree(repo, parseCommit(repo.store.get(baseTip)!.data).tree);
  for (const [path, headOid] of headFiles) {
    const atBase = baseFiles.get(path);
    const atBaseTip = baseTipFiles.get(path);
    if (atBase !== headOid && atBaseTip !== undefined && atBase !== atBaseTip && atBaseTip !== headOid) return true;
    if (atBase !== headOid && atBaseTip === undefined && atBase !== undefined) return true;
  }
  for (const path of baseFiles.keys()) {
    if (!headFiles.has(path) && baseTipFiles.has(path) && baseTipFiles.get(path) !== baseFiles.get(path)) return true;
  }
  return false;
}

/** Squash-merge a pull request onto its base branch. Returns the merge commit oid. */
export function mergePull(forge: Forge, repo: Repo, pull: Pull): string {
  const headTip = repo.tipOf(pull.headRef);
  const baseTip = repo.tipOf(pull.baseRef);
  if (!headTip || !baseTip) throw new HttpError(422, 'A branch tip is missing');
  if (pullConflicted(repo, pull)) throw new HttpError(405, 'Pull Request is not mergeable');
  const headTree = parseCommit(repo.store.get(headTip)!.data).tree;
  let newTree: string;
  if (isAncestor(repo.store, baseTip, headTip)) {
    newTree = headTree;
  } else {
    const base = mergeBase(repo.store, baseTip, headTip) ?? baseTip;
    const baseTree = parseCommit(repo.store.get(base)!.data).tree;
    const baseTipTree = parseCommit(repo.store.get(baseTip)!.data).tree;
    const changes = diffTrees(repo, baseTree, headTree);
    let tree: string | null = baseTipTree;
    for (const change of changes) {
      const headFiles = flattenTree(repo, headTree);
      const blob = headFiles.get(change.filename) ?? null;
      tree = setPath(repo, tree, change.filename, blob);
    }
    newTree = tree;
  }
  const message = pull.body ? `${pull.title}\n\n${pull.body}` : pull.title;
  const sha = makeCommit(repo, newTree, [baseTip], message, viewerIdentity(forge), epochOf(forge));
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = sha;
  pull.mergedAt = forge.stamp();
  return sha;
}

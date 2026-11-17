// The forge's data model: one token-owned account, its repositories, and inside each
// repository a git object store plus issues, pull requests, labels and comments.
// Everything lives in memory; ids and timestamps come from deterministic counters
// rooted at MAKEFUN_TRIAL_NOW so two runs of the same trial agree byte for byte.

import { ObjectStore, parseCommit, parseTree, buildTree, reachable, ZERO_OID } from './git.ts';

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdSeq: number;
  createdAt: string;
  isPull: false;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  createdSeq: number;
  createdAt: string;
  isPull: true;
}

export class Repo {
  readonly store = new ObjectStore();
  readonly refs = new Map<string, string>();
  readonly labels = new Map<string, Label>();
  readonly issues = new Map<number, Issue>();
  readonly pulls = new Map<number, Pull>();
  nextNumber = 1;
  nextCommentId = 1;

  readonly dbId: number;
  readonly name: string;
  public description: string;
  readonly isPrivate: boolean;
  readonly createdAt: string;

  constructor(dbId: number, name: string, description: string, isPrivate: boolean, createdAt: string) {
    this.dbId = dbId;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
    this.createdAt = createdAt;
  }

  get defaultBranch(): string {
    return 'main';
  }

  tipOf(branch: string): string | null {
    return this.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** Tree oid at a ref (branch name, full ref, or commit oid), or null. */
  treeAt(ref: string): string | null {
    const oid = this.refs.get(ref) ?? this.refs.get(`refs/heads/${ref}`) ?? (this.store.has(ref) ? ref : null);
    if (!oid) return null;
    const obj = this.store.get(oid);
    if (!obj) return null;
    if (obj.type === 'commit') return parseCommit(obj.data).tree;
    if (obj.type === 'tree') return oid;
    return null;
  }

  /** Read a file's blob oid + bytes at a ref, or null when absent. */
  fileAt(ref: string, path: string): { oid: string; data: Buffer } | null {
    let tree = this.treeAt(ref);
    if (!tree) return null;
    const parts = path.split('/').filter((p) => p.length > 0);
    for (let i = 0; i < parts.length; i += 1) {
      const obj = this.store.get(tree);
      if (!obj || obj.type !== 'tree') return null;
      const entry = parseTree(obj.data).find((e) => e.name === parts[i]);
      if (!entry) return null;
      if (i === parts.length - 1) {
        const blob = this.store.get(entry.oid);
        if (!blob || blob.type !== 'blob') return null;
        return { oid: entry.oid, data: blob.data };
      }
      tree = entry.oid;
    }
    return null;
  }

  /** List a directory at a ref: entries of the tree at `path` ('' = root). */
  dirAt(ref: string, path: string): { name: string; path: string; type: 'file' | 'dir'; oid: string }[] | null {
    let tree = this.treeAt(ref);
    if (!tree) return null;
    const parts = path.split('/').filter((p) => p.length > 0);
    for (const part of parts) {
      const obj = this.store.get(tree);
      if (!obj || obj.type !== 'tree') return null;
      const entry = parseTree(obj.data).find((e) => e.name === part);
      if (!entry || entry.mode !== '40000') return null;
      tree = entry.oid;
    }
    const obj = this.store.get(tree);
    if (!obj || obj.type !== 'tree') return null;
    const prefix = parts.length ? `${parts.join('/')}/` : '';
    return parseTree(obj.data).map((e) => ({
      name: e.name,
      path: `${prefix}${e.name}`,
      type: e.mode === '40000' ? ('dir' as const) : ('file' as const),
      oid: e.oid,
    }));
  }
}

export class Forge {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private seq = 0;
  readonly baseMs: number;
  /** Learned from the first owner-bearing request path; the scenario viewer until then. */
  viewerLogin = 'adaiversen';
  private viewerLearned = false;

  constructor() {
    const now = process.env.MAKEFUN_TRIAL_NOW ?? '';
    const parsed = Date.parse(now);
    this.baseMs = Number.isNaN(parsed) ? Date.UTC(2025, 0, 1) : parsed;
  }

  /** A deterministic timestamp: the trial's opening time plus a per-mutation tick. */
  stamp(): string {
    this.seq += 1;
    return new Date(this.baseMs + this.seq * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  learnViewer(owner: string): void {
    if (!this.viewerLearned && owner && owner !== this.viewerLogin) {
      this.viewerLogin = owner;
      this.viewerLearned = true;
    } else if (!this.viewerLearned && owner === this.viewerLogin) {
      this.viewerLearned = true;
    }
  }

  /** Resolve a repository for a path owner: foreign owners see nothing. */
  repoFor(owner: string, name: string): Repo | null {
    this.learnViewer(owner);
    if (owner !== this.viewerLogin) return null;
    return this.repos.get(name) ?? null;
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo | 'exists' {
    if (this.repos.has(name)) return 'exists';
    const repo = new Repo(this.nextRepoId, name, description, isPrivate, this.stamp());
    this.nextRepoId += 1;
    this.repos.set(name, repo);
    return repo;
  }
}

// ------------------------------------------------------------ git write helpers

export interface Identity {
  name: string;
  email: string;
}

/** Format and store a commit object; returns its oid. */
export function makeCommit(
  repo: Repo,
  tree: string,
  parents: string[],
  message: string,
  identity: Identity,
  epochSec: number,
): string {
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  const stamp = `${epochSec} +0000`;
  lines.push(`author ${identity.name} <${identity.email}> ${stamp}`);
  lines.push(`committer ${identity.name} <${identity.email}> ${stamp}`);
  const data = Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
  return repo.store.put('commit', data);
}

/**
 * Write `path` → `blobOid` (or delete when blobOid is null) into the tree at
 * `treeOid` (or an empty tree), returning the new root tree oid.
 */
export function setPath(repo: Repo, treeOid: string | null, path: string, blobOid: string | null): string {
  const parts = path.split('/').filter((p) => p.length > 0);
  const write = (current: string | null, depth: number): string => {
    const entries = current ? parseTree(repo.store.get(current)?.data ?? Buffer.alloc(0)) : [];
    const name = parts[depth] as string;
    const idx = entries.findIndex((e) => e.name === name);
    if (depth === parts.length - 1) {
      if (blobOid === null) {
        if (idx >= 0) entries.splice(idx, 1);
      } else if (idx >= 0) {
        entries[idx] = { mode: '100644', name, oid: blobOid };
      } else {
        entries.push({ mode: '100644', name, oid: blobOid });
      }
    } else {
      const child = idx >= 0 && entries[idx]?.mode === '40000' ? entries[idx]?.oid ?? null : null;
      const newChild = write(child, depth + 1);
      if (idx >= 0) entries[idx] = { mode: '40000', name, oid: newChild };
      else entries.push({ mode: '40000', name, oid: newChild });
    }
    return repo.store.put('tree', buildTree(entries));
  };
  return write(treeOid, 0);
}

/** Every path → blob oid in a tree (recursive). */
export function flattenTree(repo: Repo, treeOid: string | null): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (oid: string, prefix: string): void => {
    const obj = repo.store.get(oid);
    if (!obj || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      if (e.mode === '40000') walk(e.oid, `${prefix}${e.name}/`);
      else out.set(`${prefix}${e.name}`, e.oid);
    }
  };
  if (treeOid) walk(treeOid, '');
  return out;
}

export { ZERO_OID, reachable };

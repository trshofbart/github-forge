// Git object model, packfiles and pkt-line framing — implemented from the protocol
// (node:crypto SHA-1, node:zlib), no git binary. Objects are stored byte-exact and
// immutable; packs I send are plain (no deltas), packs I receive may use ofs/ref deltas.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';
export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);
export const TYPE_CODES: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const CODE_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function objectId(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

/** A per-repository object store. */
export class ObjectStore {
  readonly objects = new Map<string, GitObject>();

  put(type: ObjType, data: Buffer): string {
    const oid = objectId(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  putKnown(oid: string, type: ObjType, data: Buffer): void {
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
  }

  get(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  has(oid: string): boolean {
    return this.objects.has(oid);
  }
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const mode = data.toString('ascii', i, sp);
    const nul = data.indexOf(0x00, sp + 1);
    const name = data.toString('utf8', sp + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message };
}

export function tagTarget(data: Buffer): string {
  const text = data.toString('utf8');
  const first = text.split('\n')[0] ?? '';
  return first.startsWith('object ') ? first.slice(7).trim() : '';
}

/** The commit a (possibly annotated) ref ultimately points at, or null. */
export function peelToCommit(store: ObjectStore, oid: string): string | null {
  let current = oid;
  for (let guard = 0; guard < 32; guard += 1) {
    const obj = store.get(current);
    if (!obj) return null;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      current = tagTarget(obj.data);
      continue;
    }
    return null;
  }
  return null;
}

/**
 * Every object reachable from `tips`. When `stopCommits` is given, those commits are
 * included but their parents are not walked (a shallow client's boundary).
 */
export function reachable(store: ObjectStore, tips: string[], stopCommits?: Set<string>): Set<string> {
  const out = new Set<string>();
  const stack = [...tips];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (out.has(oid)) continue;
    const obj = store.get(oid);
    if (!obj) continue;
    out.add(oid);
    if (obj.type === 'commit') {
      const info = parseCommit(obj.data);
      stack.push(info.tree);
      if (!stopCommits || !stopCommits.has(oid)) for (const p of info.parents) stack.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) if (e.mode !== '160000') stack.push(e.oid);
    } else if (obj.type === 'tag') {
      stack.push(tagTarget(obj.data));
    }
  }
  return out;
}

/** Ancestor test: is `ancestor` reachable from `descendant` through commit parents? */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = store.get(oid);
    if (obj && obj.type === 'commit') stack.push(...parseCommit(obj.data).parents);
  }
  return false;
}

/** All commits reachable from `tip`, newest first (topological by discovery). */
export function commitHistory(store: ObjectStore, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    seen.add(oid);
    out.push(oid);
    const parents = parseCommit(obj.data).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i]);
  }
  return out;
}

/** Lowest common ancestor of two commits (first found by BFS from both sides). */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const fromA = new Set<string>();
  const stackA = [a];
  while (stackA.length) {
    const oid = stackA.pop() as string;
    if (fromA.has(oid)) continue;
    fromA.add(oid);
    const obj = store.get(oid);
    if (obj && obj.type === 'commit') stackA.push(...parseCommit(obj.data).parents);
  }
  const seen = new Set<string>();
  const stack = [b];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (fromA.has(oid)) return oid;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = store.get(oid);
    if (obj && obj.type === 'commit') stack.push(...parseCommit(obj.data).parents);
  }
  return null;
}

// ---------------------------------------------------------------- packfiles

function packEntryHeader(type: ObjType, size: number): Buffer {
  const bytes: number[] = [];
  let first = (TYPE_CODES[type] << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let b = size & 0x7f;
    size >>= 7;
    if (size > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

/** Build a plain (delta-free) pack holding `oids`, in the order given. */
export function buildPack(store: ObjectStore, oids: string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  parts.push(header);
  for (const oid of oids) {
    const obj = store.get(oid);
    if (!obj) continue;
    parts.push(packEntryHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let i = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = delta[i] as number;
      i += 1;
      value |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    return value;
  };
  readVarint(); // base size
  const outSize = readVarint();
  const chunks: Buffer[] = [];
  while (i < delta.length) {
    const op = delta[i] as number;
    i += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) { offset = delta[i] as number; i += 1; }
      if (op & 0x02) { offset |= (delta[i] as number) << 8; i += 1; }
      if (op & 0x04) { offset |= (delta[i] as number) << 16; i += 1; }
      if (op & 0x08) { offset |= (delta[i] as number) << 24; i += 1; }
      if (op & 0x10) { size = delta[i] as number; i += 1; }
      if (op & 0x20) { size |= (delta[i] as number) << 8; i += 1; }
      if (op & 0x40) { size |= (delta[i] as number) << 16; i += 1; }
      if (size === 0) size = 0x10000;
      chunks.push(base.subarray(offset, offset + size));
    } else if (op > 0) {
      chunks.push(delta.subarray(i, i + op));
      i += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const out = Buffer.concat(chunks);
  if (out.length !== outSize) throw new Error('delta result size mismatch');
  return out;
}

/** Parse a pack into the store (resolving ofs/ref deltas). Returns the object ids added. */
export function readPack(store: ObjectStore, pack: Buffer): string[] {
  if (pack.length < 12 + 20 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a pack');
  const count = pack.readUInt32BE(8);
  let offset = 12;
  const end = pack.length - 20;
  const added: string[] = [];
  interface Pending { type: ObjType; data?: Buffer; baseOid?: string; baseOffset?: number; delta?: Buffer; start: number }
  const pendings: Pending[] = [];
  const byStart = new Map<number, Pending>();
  for (let n = 0; n < count; n += 1) {
    const start = offset;
    let b = pack[offset] as number;
    offset += 1;
    const typeCode = (b >> 4) & 0x07;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) {
      b = pack[offset] as number;
      offset += 1;
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    if (typeCode === 6) {
      // OFS_DELTA: negative offset to the base entry's start.
      let c = pack[offset] as number;
      offset += 1;
      let baseOffset = c & 0x7f;
      while (c & 0x80) {
        c = pack[offset] as number;
        offset += 1;
        baseOffset = ((baseOffset + 1) << 7) | (c & 0x7f);
      }
      const data = inflateSync(pack.subarray(offset, end));
      offset += compressedLength(pack, offset, end, size);
      const pending: Pending = { type: 'blob', baseOffset: start - baseOffset, delta: data, start };
      pendings.push(pending);
      byStart.set(start, pending);
    } else if (typeCode === 7) {
      // REF_DELTA: 20-byte base id.
      const baseOid = pack.toString('hex', offset, offset + 20);
      offset += 20;
      const data = inflateSync(pack.subarray(offset, end));
      offset += compressedLength(pack, offset, end, size);
      const pending: Pending = { type: 'blob', baseOid, delta: data, start };
      pendings.push(pending);
      byStart.set(start, pending);
    } else {
      const type = CODE_TYPES[typeCode];
      if (!type) throw new Error(`pack entry type ${typeCode}`);
      const data = inflateSync(pack.subarray(offset, end));
      offset += compressedLength(pack, offset, end, size);
      if (data.length !== size) throw new Error('pack entry size mismatch');
      const pending: Pending = { type, data, start };
      pendings.push(pending);
      byStart.set(start, pending);
    }
  }
  const resolve = (pending: Pending): GitObject => {
    if (pending.data) return { type: pending.type, data: pending.data };
    let base: GitObject | undefined;
    if (pending.baseOid) {
      base = store.get(pending.baseOid);
      if (!base) {
        const bp = pendings.find((p) => p.data && objectId(p.type, p.data) === pending.baseOid);
        if (bp) base = resolve(bp);
      }
    } else if (pending.baseOffset !== undefined) {
      const bp = byStart.get(pending.baseOffset);
      if (bp) base = resolve(bp);
    }
    if (!base || !pending.delta) throw new Error('unresolvable delta base');
    return { type: base.type, data: applyDelta(base.data, pending.delta) };
  };
  for (const pending of pendings) {
    const obj = resolve(pending);
    const oid = objectId(obj.type, obj.data);
    store.putKnown(oid, obj.type, obj.data);
    added.push(oid);
  }
  return added;
}

/** Length of the zlib stream starting at `offset` whose inflated size is `expected`. */
function compressedLength(pack: Buffer, offset: number, end: number, expected: number): number {
  // Any prefix at or past the true stream end inflates to `expected` (trailing bytes
  // are ignored); a shorter prefix throws or inflates short. Binary-search the
  // smallest prefix that inflates to exactly `expected`.
  let lo = 1;
  let hi = end - offset;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    let ok = false;
    try {
      ok = inflateSync(pack.subarray(offset, offset + mid)).length === expected;
    } catch {
      ok = false;
    }
    if (ok) hi = mid;
    else lo = mid + 1;
  }
  const out = inflateSync(pack.subarray(offset, offset + lo));
  if (out.length !== expected) throw new Error('cannot find zlib stream end');
  return lo;
}

// ---------------------------------------------------------------- pkt-line

export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export interface PktReader {
  /** Next packet: a Buffer payload, 'flush', 'delim', or null when exhausted. */
  next(): Buffer | 'flush' | 'delim' | null;
  rest(): Buffer;
}

export function pktReader(buf: Buffer): PktReader {
  let offset = 0;
  return {
    next() {
      if (offset + 4 > buf.length) return null;
      const hex = buf.toString('ascii', offset, offset + 4);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
      const len = parseInt(hex, 16);
      if (len === 0) { offset += 4; return 'flush'; }
      if (len === 1) { offset += 4; return 'delim'; }
      if (len === 2) { offset += 4; return 'delim'; }
      if (len < 4 || offset + len > buf.length) return null;
      const payload = buf.subarray(offset + 4, offset + len);
      offset += len;
      return payload;
    },
    rest() {
      return buf.subarray(offset);
    },
  };
}

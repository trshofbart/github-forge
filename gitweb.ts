// Git smart HTTP: v0 advertisements, protocol v2 ls-refs/fetch for upload-pack,
// and v0 receive-pack with report-status. Packs sent are plain (no deltas) and
// cached per (repo, object set) so the 50-way shallow-clone bench reuses one build.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Forge, Repo } from './store.ts';
import type { ObjectStore } from './git.ts';
import {
  ZERO_OID, pktLine, pktReader, PKT_FLUSH, buildPack, readPack,
  reachable, isAncestor, parseCommit, peelToCommit,
} from './git.ts';

const UPLOAD_CAPS_V0 = 'multi_ack_detailed side-band-64k thin-pack ofs-delta symref=HEAD:refs/heads/main';
const RECEIVE_CAPS_V0 = 'report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/main';

const packCaches = new WeakMap<Repo, Map<string, Buffer>>();

function cachedPack(repo: Repo, oids: string[]): Buffer {
  let cache = packCaches.get(repo);
  if (!cache) {
    cache = new Map();
    packCaches.set(repo, cache);
  }
  const key = oids.join(',');
  const hit = cache.get(key);
  if (hit) return hit;
  const pack = buildPack(repo.store, oids);
  if (cache.size > 64) cache.clear();
  cache.set(key, pack);
  return pack;
}

function sortedRefs(repo: Repo): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

function advertisement(repo: Repo, service: string, v2: boolean): Buffer {
  if (v2) {
    return Buffer.concat([
      pktLine('version 2\n'),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow thin-pack ofs-delta\n'),
      pktLine('object-format=sha1\n'),
      PKT_FLUSH,
    ]);
  }
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    const headOid = repo.refs.get('refs/heads/main') ?? ZERO_OID;
    const lines: [string, string][] = [['HEAD', headOid], ...refs];
    for (const [ref, oid] of lines) {
      const suffix = first ? `\0${caps}` : '';
      first = false;
      parts.push(pktLine(`${oid} ${ref}${suffix}\n`));
      const obj = repo.store.get(oid);
      if (obj && obj.type === 'tag') {
        const peeled = peelToCommit(repo.store, oid);
        if (peeled) parts.push(pktLine(`${peeled} ${ref}^{}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function sideband(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  // A pkt-line is at most 65520 bytes including its 4-byte header, and each frame
  // spends 1 payload byte on the band, leaving 65515 for data.
  const CHUNK = 65515;
  for (let i = 0; i < data.length; i += CHUNK) {
    const chunk = data.subarray(i, i + CHUNK);
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function lsRefs(repo: Repo, args: string[]): Buffer {
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const lines: string[] = [];
  const headTarget = 'refs/heads/main';
  const headOid = repo.refs.get(headTarget);
  if (matches('HEAD')) {
    if (headOid) {
      lines.push(`${headOid} HEAD${symrefs ? ` symref-target:${headTarget}` : ''}`);
    } else if (unborn) {
      lines.push(`unborn HEAD${symrefs ? ` symref-target:${headTarget}` : ''}`);
    }
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    const obj = repo.store.get(oid);
    if (peel && obj && obj.type === 'tag') {
      const peeled = peelToCommit(repo.store, oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    lines.push(line);
  }
  return Buffer.concat([...lines.map((l) => pktLine(`${l}\n`)), PKT_FLUSH]);
}

function fetchPack(repo: Repo, args: string[]): Buffer {
  const store: ObjectStore = repo.store;
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let deepen = 0;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) clientShallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) deepen = parseInt(arg.slice(7).trim(), 10) || 0;
  }
  const stop = new Set(clientShallow);
  const haveClosure = reachable(store, haves, stop);
  const shallowLines: string[] = [];
  let deliver: Set<string>;

  if (deepen > 0) {
    // BFS by commit generation from the wants; include each included commit's
    // full tree closure; boundary commits become the new shallow lines.
    const depthOf = new Map<string, number>();
    const queue: [string, number][] = [];
    for (const want of wants) {
      const commit = peelToCommit(store, want) ?? want;
      if (!depthOf.has(commit)) {
        depthOf.set(commit, 1);
        queue.push([commit, 1]);
      }
    }
    const included = new Set<string>();
    while (queue.length) {
      const [oid, depth] = queue.shift() as [string, number];
      if (depth > deepen) continue;
      const obj = store.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      included.add(oid);
      const info = parseCommit(obj.data);
      for (const parent of info.parents) {
        if (!depthOf.has(parent)) {
          depthOf.set(parent, depth + 1);
          queue.push([parent, depth + 1]);
        }
      }
    }
    deliver = new Set<string>();
    for (const oid of included) {
      deliver.add(oid);
      const info = parseCommit((store.get(oid) as { data: Buffer }).data);
      for (const o of reachable(store, [info.tree])) deliver.add(o);
    }
    // Tag objects on the wants ride along.
    for (const want of wants) if (want && store.has(want) && !included.has(want)) deliver.add(want);
    // A commit is a shallow boundary when a parent exists in the store but was cut.
    for (const oid of included) {
      const info = parseCommit((store.get(oid) as { data: Buffer }).data);
      if (info.parents.some((p) => store.has(p) && !included.has(p))) shallowLines.push(`shallow ${oid}`);
    }
    for (const o of haveClosure) deliver.delete(o);
  } else {
    const wantClosure = reachable(store, wants, stop);
    deliver = new Set<string>();
    for (const o of wantClosure) if (!haveClosure.has(o)) deliver.add(o);
  }

  const rank = (oid: string): number => {
    const t = store.get(oid)?.type;
    return t === 'commit' ? 0 : t === 'tree' ? 1 : t === 'tag' ? 2 : 3;
  };
  const oids = [...deliver].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1));
  const pack = cachedPack(repo, oids);

  const parts: Buffer[] = [pktLine('acknowledgments\n'), pktLine('NAK\n'), PKT_FLUSH];
  if (shallowLines.length) {
    parts.push(pktLine('shallow-info\n'));
    for (const line of shallowLines) parts.push(pktLine(`${line}\n`));
    parts.push(PKT_FLUSH);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sideband(pack));
  return Buffer.concat(parts);
}

function receivePack(repo: Repo, body: Buffer): Buffer {
  const reader = pktReader(body);
  const commands: { old: string; next: string; ref: string }[] = [];
  let caps = '';
  for (;;) {
    const packet = reader.next();
    if (packet === null || packet === 'flush' || packet === 'delim') break;
    let line = packet.toString('utf8');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      caps = line.slice(nul + 1).trim();
      line = line.slice(0, nul);
    }
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 3) commands.push({ old: parts[0] as string, next: parts[1] as string, ref: parts[2] as string });
  }
  const pack = reader.rest();
  let unpackOk = true;
  const needsPack = commands.some((c) => c.next !== ZERO_OID);
  if (needsPack && pack.length > 0) {
    try {
      readPack(repo.store, pack);
    } catch {
      unpackOk = false;
    }
  }
  const report: Buffer[] = [pktLine(unpackOk ? 'unpack ok\n' : 'unpack index-pack failed\n')];
  for (const cmd of commands) {
    if (!unpackOk) {
      report.push(pktLine(`ng ${cmd.ref} unpack failed\n`));
      continue;
    }
    const current = repo.refs.get(cmd.ref) ?? ZERO_OID;
    if (cmd.next === ZERO_OID) {
      repo.refs.delete(cmd.ref);
      report.push(pktLine(`ok ${cmd.ref}\n`));
    } else if (current === ZERO_OID || current === cmd.next || isAncestor(repo.store, current, cmd.next)) {
      repo.refs.set(cmd.ref, cmd.next);
      report.push(pktLine(`ok ${cmd.ref}\n`));
    } else {
      report.push(pktLine(`ng ${cmd.ref} non-fast-forward\n`));
    }
  }
  report.push(PKT_FLUSH);
  const reportBuf = Buffer.concat(report);
  return caps.includes('side-band-64k') ? sideband(reportBuf) : reportBuf;
}

export function handleGit(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  rest: string[],
  query: URLSearchParams,
  body: Buffer,
): boolean {
  const repo = forge.repoFor(owner, repoName);
  const service = query.get('service') ?? '';
  const isInfoRefs = rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs';
  const isUpload = rest.length === 1 && rest[0] === 'git-upload-pack';
  const isReceive = rest.length === 1 && rest[0] === 'git-receive-pack';
  if (!isInfoRefs && !isUpload && !isReceive) return false;
  if (!repo) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return true;
  }
  if (isInfoRefs) {
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('unknown service');
      return true;
    }
    const protocol = req.headers['git-protocol'] ?? '';
    const v2 = service === 'git-upload-pack' && /(^|,)version=2/.test(protocol.replace(/\s/g, ''));
    res.writeHead(200, { 'content-type': `application/x-${service}-advertisement` });
    res.end(advertisement(repo, service, v2));
    return true;
  }
  if (isUpload) {
    try {
      const reader = pktReader(body);
      const first = reader.next();
      if (first === null || first === 'flush' || first === 'delim') throw new Error('empty request');
      const commandLine = first.toString('utf8').trim();
      const args: string[] = [];
      let afterDelim = false;
      for (;;) {
        const packet = reader.next();
        if (packet === null || packet === 'flush') break;
        if (packet === 'delim') { afterDelim = true; continue; }
        if (afterDelim) args.push(packet.toString('utf8').replace(/\n$/, ''));
      }
      let out: Buffer;
      if (commandLine === 'command=ls-refs') out = lsRefs(repo, args);
      else if (commandLine === 'command=fetch') out = fetchPack(repo, args);
      else throw new Error(`unknown command ${commandLine}`);
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
      res.end(out);
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad request');
    }
    return true;
  }
  // receive-pack
  try {
    const out = receivePack(repo, body);
    res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result' });
    res.end(out);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('bad request');
  }
  return true;
}

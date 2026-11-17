# github-forge — a GitHub-compatible git forge in one Node process

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/trshofbart/github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/trshofbart/github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone forge implementing the surface GitHub's own tools speak, built for
[the make.fun git-forge bounty](https://make.fun/bounty/github-core-clone-01):
git smart HTTP, REST v3, GraphQL v4 and an MCP endpoint, all over one in-memory
store. Node 22, standard library only — no dependencies, no `git` binary, no
network. The git object model (SHA-1, trees, commits, tags, packfiles with
ofs/ref delta resolution) is implemented from the protocol in `git.ts`.

## Run it

```sh
node --experimental-strip-types main.ts
```

`main.ts` is the harness lifecycle: bind an ephemeral port, register it with
`$MAKEFUN_ENV_URL`, poll `/done`, exit 0. Everything else is the server.

## The surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}` boot probe |
| `GET /api/v3/` | API root with `X-OAuth-Scopes: repo, read:org` |
| `/api/v3/...` | REST v3: repositories, branches, commits, contents, labels, issues, comments, pull requests, PR files and squash merges, Link-header pagination |
| `POST /api/graphql` | GraphQL v4: viewer/repository/node queries, issue & PR connections with cursor pagination, `createIssue` / `closeIssue` / `createPullRequest` / `mergePullRequest` / `addComment`, `__type` introspection, batched operations |
| `POST /mcp` | MCP over streamable HTTP (JSON-RPC 2.0): `server/discover` (2026-07-28) plus the legacy `initialize` handshake; `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request` |
| `/{owner}/{repo}.git/...` | git smart HTTP: v0 + protocol v2 `info/refs`, v2 `ls-refs`/`fetch` (shallow, deepen, incremental), v0 `git-receive-pack` with side-band-64k report-status and per-ref fast-forward enforcement |

Every surface shares one store, so an issue created over MCP reads back over
REST and GraphQL with the same number and id, and a branch pushed over git is
the head of the next pull request.

## Design notes

- **Deterministic.** Ids are counters; timestamps derive from
  `MAKEFUN_TRIAL_NOW`, never the wall clock, so a replayed trial reproduces
  the same state byte for byte.
- **Fast by construction.** All state is in memory; issue numbers are O(1)
  counter allocations; fetch packs for an unchanged object set are cached and
  reused, so concurrent shallow clones share one pack build.
- **Byte-exact git.** Pushed objects are stored verbatim and never
  re-serialised; packs sent are plain (delta-free), packs received may use
  ofs/ref deltas.

## Layout

- `main.ts` — the entry lifecycle (bind, register, wait for done).
- `app.ts` — HTTP routing, REST v3, GraphQL and MCP dispatch.
- `git.ts` — object store, packfile read/write, pkt-line framing, reachability.
- `gitweb.ts` — smart HTTP: advertisements, ls-refs, fetch, receive-pack.
- `store.ts` — repositories, issues, pulls, labels; contents-API tree writes.
- `service.ts` — shared operations (issue/PR creation, squash merge, PR diffs,
  conflict detection) and the REST serializers.
- `graphql.ts` — a small GraphQL parser/executor with the forge's schema.
- `mcp.ts` — the MCP tool set and JSON-RPC plumbing.

MIT licensed (see `LICENSE`).

// How this process lives, in four moves:
//
//   1. Read MAKEFUN_ENV_URL. Empty means no env exists to serve, so exit 1
//      immediately instead of idling.
//   2. Build the app and listen on port 0. The kernel assigns a free port;
//      port 8080 is never ours to take (the env owns it in the trial pod).
//   3. Announce the port: POST /register with a JSON body { port }. The env
//      pairs the request's source address with that port and treats the pair
//      as the entry's base URL. The first announcement wins — a 409 answer
//      just means the slot is taken, which is fine. A 400 or 405 is a
//      contract violation and ends the process. Any other outcome (a refused
//      connection, a 5xx, a timeout) is retried with backoff, because the
//      env may still be starting.
//   4. Poll GET /done. It answers at once: { done: false } while the suite
//      runs, { done: true } when it is over. Only then close the server and
//      exit 0; the export the env writes afterwards is the score's input.
//
// Each register/done request gets 30 s before it is abandoned. Retries wait
// 250 ms, doubling per attempt, never more than 2 s.

import { createApp } from './app.ts';

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

if (envOrigin === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL missing: nothing to register with\n');
  process.exit(1);
}

const TIMEOUT_MS = 30_000;
const BACKOFF_FIRST_MS = 250;
const BACKOFF_CAP_MS = 2_000;

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function backoffMs(attempt: number): number {
  const grown = BACKOFF_FIRST_MS * 2 ** Math.min(attempt, 8);
  return grown > BACKOFF_CAP_MS ? BACKOFF_CAP_MS : grown;
}

async function announce(port: number): Promise<void> {
  let attempt = 0;
  for (;;) {
    let fatal: Error | null = null;
    try {
      const res = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        fatal = new Error(`register refused with HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register refused with HTTP ')) throw err;
    }
    if (fatal !== null) throw fatal;
    await pause(backoffMs(attempt));
    attempt += 1;
  }
}

async function awaitDone(): Promise<void> {
  let attempt = 0;
  for (;;) {
    let finished = false;
    try {
      const res = await fetch(`${envOrigin}/done`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) {
        const body = JSON.parse(await res.text()) as { done?: unknown };
        finished = body.done === true;
      }
    } catch {
      finished = false; // unreachable or slow env: not done, by definition
    }
    if (finished) return;
    await pause(backoffMs(attempt));
    attempt += 1;
  }
}

async function run(): Promise<void> {
  const server = createApp();
  const bound = new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, resolve);
  });
  await bound;
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('no ephemeral TCP port was bound');
  }
  process.stdout.write(`[entry] up on port ${address.port}\n`);
  await announce(address.port);
  process.stdout.write('[entry] registered; holding until the env finishes\n');
  await awaitDone();
  server.close();
  process.stdout.write('[entry] env reports done; exiting\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  const detail = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[entry] ${detail}\n`);
  process.exit(1);
}

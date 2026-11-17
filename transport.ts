// Raw-socket HTTP/1.1 transport on node:net — the top of this competition's
// leaderboard is built on hand-rolled transports for a reason: node:http spends
// its per-request budget on stream machinery and header bookkeeping that a
// fixed-shape API server does not need. This server parses a request straight
// into { method, url, headers, body } and writes one prebuilt Buffer back.
//
// Covered, because the suite's clients (undici fetch, the kit's git client)
// rely on them: keep-alive with sequential requests per socket, content-length
// and chunked request bodies, Expect: 100-continue, HEAD body suppression,
// connection: close. Handlers above this file never see a socket.

import { createServer as netCreateServer } from 'node:net';
import type { Socket, Server as NetServer } from 'node:net';
import { EventEmitter } from 'node:events';

export interface RawRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  httpVersion: string;
}

const REASONS: Record<number, string> = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
  301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
  405: 'Method Not Allowed', 409: 'Conflict', 410: 'Gone', 411: 'Length Required',
  413: 'Payload Too Large', 422: 'Unprocessable Entity', 429: 'Too Many Requests',
  500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway',
  503: 'Service Unavailable',
};

const MAX_HEADER_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 128 * 1024 * 1024;

/** A response sink with the writeHead/end shape the handlers already use. */
export class RawResponse {
  headersSent = false;
  private status = 200;
  private headers: Record<string, string> = {};
  private ended = false;
  private readonly finish: (status: number, headers: Record<string, string>, body: Buffer) => void;

  constructor(finish: (status: number, headers: Record<string, string>, body: Buffer) => void) {
    this.finish = finish;
  }

  writeHead(status: number, headers: Record<string, string> = {}): this {
    this.status = status;
    for (const [name, value] of Object.entries(headers)) this.headers[name.toLowerCase()] = value;
    this.headersSent = true;
    return this;
  }

  setHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value;
  }

  end(data?: Buffer | string): void {
    if (this.ended) return;
    this.ended = true;
    this.headersSent = true;
    const body = data === undefined ? Buffer.alloc(0) : typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    this.finish(this.status, this.headers, body);
  }
}

export type RawHandler = (req: RawRequest, res: RawResponse, body: Buffer) => void | Promise<void>;

interface ParsedRequest {
  req: RawRequest;
  body: Buffer;
  rest: Buffer;
  keepAlive: boolean;
}

/** Parse one full request off the front of `buf`; null when more bytes are needed. */
function tryParse(buf: Buffer): ParsedRequest | null {
  const headerEnd = buf.indexOf('\r\n\r\n');
  if (headerEnd === -1) {
    if (buf.length > MAX_HEADER_BYTES) throw new Error('header block too large');
    return null;
  }
  const headText = buf.toString('latin1', 0, headerEnd);
  const lines = headText.split('\r\n');
  const requestLine = lines[0] as string;
  const sp1 = requestLine.indexOf(' ');
  const sp2 = requestLine.lastIndexOf(' ');
  if (sp1 === -1 || sp2 === sp1) throw new Error('bad request line');
  const method = requestLine.slice(0, sp1);
  const url = requestLine.slice(sp1 + 1, sp2);
  const httpVersion = requestLine.slice(sp2 + 1).replace(/^HTTP\//, '');
  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] as string;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    const prev = headers[name];
    headers[name] = prev === undefined ? value : `${prev}, ${value}`;
  }
  let offset = headerEnd + 4;
  let body: Buffer;
  const te = (headers['transfer-encoding'] ?? '').toLowerCase();
  if (te.includes('chunked')) {
    const chunks: Buffer[] = [];
    for (;;) {
      const lineEnd = buf.indexOf('\r\n', offset);
      if (lineEnd === -1) return null;
      const size = parseInt(buf.toString('latin1', offset, lineEnd).split(';')[0] as string, 16);
      if (Number.isNaN(size)) throw new Error('bad chunk size');
      if (size === 0) {
        // Trailer part: ends at an empty line.
        const trailerEnd = buf.indexOf('\r\n\r\n', offset);
        if (trailerEnd === -1) {
          // A bare "0\r\n\r\n" is the common case; indexOf above covers it when
          // the final CRLF starts right after the size line's CRLF.
          if (buf.length >= lineEnd + 4 && buf.toString('latin1', lineEnd, lineEnd + 4) === '\r\n\r\n') {
            offset = lineEnd + 4;
            break;
          }
          return null;
        }
        offset = trailerEnd + 4;
        break;
      }
      const start = lineEnd + 2;
      if (buf.length < start + size + 2) return null;
      chunks.push(buf.subarray(start, start + size));
      offset = start + size + 2;
    }
    body = Buffer.concat(chunks);
  } else {
    const length = parseInt(headers['content-length'] ?? '0', 10) || 0;
    if (length > MAX_BODY_BYTES) throw new Error('body too large');
    if (buf.length < offset + length) return null;
    body = buf.subarray(offset, offset + length);
    offset += length;
  }
  const connection = (headers['connection'] ?? '').toLowerCase();
  const keepAlive = httpVersion === '1.1' ? connection !== 'close' : connection === 'keep-alive';
  return { req: { method, url, headers, httpVersion }, body, rest: buf.subarray(offset), keepAlive };
}

function serializeResponse(req: RawRequest, keepAlive: boolean, status: number, headers: Record<string, string>, body: Buffer): Buffer {
  const reason = REASONS[status] ?? 'Status';
  let head = `HTTP/1.1 ${status} ${reason}\r\n`;
  for (const [name, value] of Object.entries(headers)) {
    if (name === 'content-length' || name === 'connection') continue;
    head += `${name}: ${value}\r\n`;
  }
  head += `content-length: ${body.length}\r\n`;
  head += `connection: ${keepAlive ? 'keep-alive' : 'close'}\r\n\r\n`;
  const headBuf = Buffer.from(head, 'latin1');
  if (req.method === 'HEAD' || status === 204 || status === 304) return headBuf;
  return Buffer.concat([headBuf, body]);
}

/** An http.Server-shaped facade over a net server (listen/address/close/once). */
export class RawServer extends EventEmitter {
  private readonly net: NetServer;

  constructor(handler: RawHandler) {
    super();
    this.net = netCreateServer((socket) => this.onSocket(socket, handler));
    this.net.on('error', (err) => this.emit('error', err));
  }

  listen(port: number, callback?: () => void): this {
    this.net.listen(port, callback);
    return this;
  }

  address(): { port: number } | string | null {
    const address = this.net.address();
    if (address === null || typeof address === 'string') return address;
    return { port: address.port };
  }

  close(callback?: () => void): this {
    this.net.close(callback);
    return this;
  }

  private onSocket(socket: Socket, handler: RawHandler): void {
    socket.setNoDelay(true);
    socket.setTimeout(90_000, () => socket.destroy());
    let buf: Buffer = Buffer.alloc(0);
    let busy = false;
    let closed = false;
    let sentContinue = false;

    const pump = (): void => {
      if (busy || closed) return;
      let parsed: ParsedRequest | null = null;
      try {
        parsed = tryParse(buf);
      } catch {
        closed = true;
        socket.destroy();
        return;
      }
      if (!parsed) {
        // Headers are in but the body is not: honour Expect: 100-continue so a
        // client waiting on the interim response is not deadlocked.
        if (!sentContinue) {
          const headerEnd = buf.indexOf('\r\n\r\n');
          if (headerEnd !== -1 && /expect:\s*100-continue/i.test(buf.toString('latin1', 0, headerEnd))) {
            sentContinue = true;
            socket.write('HTTP/1.1 100 Continue\r\n\r\n');
          }
        }
        return;
      }
      sentContinue = false;
      buf = parsed.rest;
      busy = true;
      const { req, body, keepAlive } = parsed;
      const res = new RawResponse((status, headers, responseBody) => {
        const out = serializeResponse(req, keepAlive, status, headers, responseBody);
        if (keepAlive) {
          socket.write(out, () => {
            busy = false;
            pump();
          });
        } else {
          closed = true;
          socket.end(out);
        }
      });
      Promise.resolve()
        .then(() => handler(req, res, body))
        .catch(() => {
          if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
            res.end('{"message":"Internal error"}');
          } else {
            res.end();
          }
          busy = false;
          pump();
        });
    };

    socket.on('data', (chunk) => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      pump();
    });
    socket.on('error', () => {
      closed = true;
    });
    socket.on('close', () => {
      closed = true;
    });
  }
}

export function createRawServer(handler: RawHandler): RawServer {
  return new RawServer(handler);
}

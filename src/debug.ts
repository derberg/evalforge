import { appendFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fetch as undiciFetch } from 'undici';
import chalk from 'chalk';

// Always go through undici's own fetch so a custom Agent passed via
// init.dispatcher uses the same interceptor protocol as the fetch
// implementation. Mixing Node's bundled fetch with a standalone-undici Agent
// throws "invalid onRequestStart method" at request time.
const _fetch = undiciFetch as unknown as typeof fetch;

const STDERR_BODY_HEAD = 1024;
const STDERR_BODY_TAIL = 512;
const STDERR_BODY_MAX = STDERR_BODY_HEAD + STDERR_BODY_TAIL;
const REDACTED_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'anthropic-api-key',
  'openai-api-key',
]);
const STREAM_CHUNK_HEARTBEAT = 32;

export interface OllamaStreamSummary {
  promptEvalCount: number;
  promptEvalMs: number;
  evalCount: number;
  evalMs: number;
  totalMs: number;
}

export interface DebugLogger {
  enabled: boolean;
  logFile: string | null;
  event(name: string, fields: Record<string, unknown>, body?: string): void;
  fetch(
    url: string,
    init: RequestInit,
    ctx?: { onStreamLine?: (line: string) => void; expectStream?: boolean },
  ): Promise<{ res: Response; bodyText: string }>;
  close(): Promise<void>;
}

interface InitOptions {
  snapshotDir: string;
  name: string;
  // Override timestamp (used in tests for determinism). Defaults to now().
  now?: () => Date;
}

export async function initDebug(opts: InitOptions): Promise<DebugLogger> {
  const dir = resolve(opts.snapshotDir, opts.name);
  await mkdir(dir, { recursive: true });
  const stamp = (opts.now ? opts.now() : new Date())
    .toISOString()
    .replace(/[:.]/g, '-');
  const logFile = resolve(dir, `debug-${stamp}.log`);
  return makeLogger(logFile);
}

export function noopDebug(): DebugLogger {
  return {
    enabled: false,
    logFile: null,
    event() {},
    async fetch(url, init, ctx) {
      const res = await _fetch(url, init);
      if (ctx?.expectStream && res.body && ctx.onStreamLine) {
        const text = await consumeStream(res.body, ctx.onStreamLine);
        return { res, bodyText: text };
      }
      const bodyText = await res.text();
      return { res: cloneWithBody(res, bodyText), bodyText };
    },
    async close() {},
  };
}

function makeLogger(logFile: string): DebugLogger {
  let writeChain: Promise<void> = Promise.resolve();

  const append = (line: string): void => {
    writeChain = writeChain.then(() => appendFile(logFile, line));
  };

  const writeEvent = (
    name: string,
    fields: Record<string, unknown>,
    body?: string,
  ): void => {
    const ts = new Date().toISOString();
    const inline = formatFields(fields);
    const stderrLine = `${chalk.dim(ts)} ${eventTag(name, fields)} ${inline}`;
    process.stderr.write(stderrLine + '\n');
    if (body !== undefined) {
      process.stderr.write(`  body: ${truncateForStderr(body)}\n`);
    }

    let fileLine = `${ts} [${name}] ${inline}\n`;
    if (body !== undefined) {
      fileLine += `  body: ${body.replace(/\r?\n/g, '\\n')}\n`;
    }
    append(fileLine);
  };

  return {
    enabled: true,
    logFile,
    event: writeEvent,
    async fetch(url, init, ctx) {
      const headers = headersFromInit(init);
      const reqBody = typeof init.body === 'string' ? init.body : '';
      writeEvent('http-req', {
        method: init.method ?? 'GET',
        url,
        headers: redactHeaders(headers),
        bodyBytes: reqBody.length,
      }, reqBody);

      const startedAt = Date.now();
      const res = await _fetch(url, init);
      const durationMs = Date.now() - startedAt;

      let bodyText = '';
      if (ctx?.expectStream && res.body && ctx.onStreamLine) {
        let chunkCount = 0;
        let bytesSoFar = 0;
        bodyText = await consumeStream(res.body, (line) => {
          chunkCount += 1;
          bytesSoFar += line.length;
          ctx.onStreamLine!(line);
          if (chunkCount % STREAM_CHUNK_HEARTBEAT === 0) {
            writeEvent('http-chunk', { url, chunkCount, bytesSoFar });
          }
        });
        if (chunkCount % STREAM_CHUNK_HEARTBEAT !== 0) {
          writeEvent('http-chunk', { url, chunkCount, bytesSoFar });
        }
      } else {
        bodyText = await res.text();
      }

      writeEvent('http-res', {
        status: res.status,
        durationMs,
        headers: redactHeaders(headersToObject(res.headers)),
        bodyBytes: bodyText.length,
      }, bodyText);

      const usableRes = ctx?.expectStream ? res : cloneWithBody(res, bodyText);
      return { res: usableRes, bodyText };
    },
    async close() {
      await writeChain;
    },
  };
}

function eventTag(name: string, fields: Record<string, unknown>): string {
  const tag = `[${name}]`;
  if (name === 'run-end' || name === 'judge-end') {
    return fields.error ? chalk.red(tag) : chalk.green(tag);
  }
  if (name === 'http-res') {
    const status = Number(fields.status);
    if (status >= 400) return chalk.red(tag);
    if (status >= 300) return chalk.yellow(tag);
    if (status >= 200) return chalk.green(tag);
  }
  return chalk.dim(tag);
}

function formatFields(fields: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(`${k}=${formatValue(v)}`);
  }
  return parts.join(' ');
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'string') {
    return v.includes(' ') || v.includes('=') ? JSON.stringify(v) : v;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

function truncateForStderr(body: string): string {
  if (body.length <= STDERR_BODY_MAX) return body.replace(/\r?\n/g, '\\n');
  const head = body.slice(0, STDERR_BODY_HEAD);
  const tail = body.slice(-STDERR_BODY_TAIL);
  const elided = body.length - STDERR_BODY_HEAD - STDERR_BODY_TAIL;
  return `${head}... [${elided} bytes elided] ...${tail}`.replace(/\r?\n/g, '\\n');
}

function headersFromInit(init: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  const h = init.headers;
  if (!h) return out;
  if (h instanceof Headers) {
    h.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(h)) {
    for (const [k, v] of h) out[k] = v;
    return out;
  }
  for (const [k, v] of Object.entries(h)) out[k] = String(v);
  return out;
}

function headersToObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = REDACTED_HEADERS.has(k.toLowerCase()) ? '<redacted>' : v;
  }
  return out;
}

function cloneWithBody(res: Response, body: string): Response {
  return new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

async function consumeStream(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let full = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    full += chunk;
    buffer += chunk;
    let nlIdx: number;
    while ((nlIdx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nlIdx);
      buffer = buffer.slice(nlIdx + 1);
      if (line.length > 0) onLine(line);
    }
  }
  const tail = decoder.decode();
  if (tail) {
    full += tail;
    buffer += tail;
  }
  if (buffer.length > 0) onLine(buffer);
  return full;
}

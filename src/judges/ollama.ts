import { Agent } from 'undici';
import { buildJudgePrompt } from './rubric.js';
import { parseJudgeResponse, type ParsedJudgment } from './parse.js';
import type { DebugLogger, OllamaStreamSummary } from '../debug.js';
import { noopDebug } from '../debug.js';

// Local Ollama generation can take many minutes (prompt prefill on a partially
// CPU-offloaded large model is itself slow, before any tokens are produced).
// Disable undici's headersTimeout/bodyTimeout entirely for /api/chat so the
// connection survives until the server replies or the user Ctrl-C's.
const ollamaDispatcher = new Agent({
  headersTimeout: 0,
  bodyTimeout: 0,
  connect: { timeout: 30_000 },
});

export interface OllamaJudgeOptions {
  endpoint: string;
  model: string;
  temperature: number;
  maxTokens: number;
  prompt: string;
  output: string;
  rubric: string;
  debug?: DebugLogger;
}

export type OllamaJudgeResult = ParsedJudgment & {
  raw: string;
  timings: OllamaStreamSummary | null;
};

interface OllamaStreamChunk {
  message?: { content?: string };
  done?: boolean;
  error?: string;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
  total_duration?: number;
}

export async function judgeWithOllama(opts: OllamaJudgeOptions): Promise<OllamaJudgeResult> {
  const debug = opts.debug ?? noopDebug();
  const body = {
    model: opts.model,
    stream: true,
    options: { temperature: opts.temperature, num_predict: opts.maxTokens },
    messages: [{ role: 'user', content: buildJudgePrompt(opts) }],
    format: 'json',
  };
  const url = `${opts.endpoint.replace(/\/+$/, '')}/api/chat`;

  let raw = '';
  let timings: OllamaStreamSummary | null = null;
  let streamErr: string | null = null;

  const onLine = (line: string): void => {
    let chunk: OllamaStreamChunk;
    try {
      chunk = JSON.parse(line) as OllamaStreamChunk;
    } catch {
      // Skip non-JSON keep-alives or partial frames; the next line resumes.
      return;
    }
    if (chunk.error) {
      streamErr = chunk.error;
      return;
    }
    if (chunk.message?.content) raw += chunk.message.content;
    if (chunk.done) {
      timings = {
        promptEvalCount: chunk.prompt_eval_count ?? 0,
        promptEvalMs: nsToMs(chunk.prompt_eval_duration),
        evalCount: chunk.eval_count ?? 0,
        evalMs: nsToMs(chunk.eval_duration),
        totalMs: nsToMs(chunk.total_duration),
      };
    }
  };

  const init = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    dispatcher: ollamaDispatcher,
  } as unknown as RequestInit;
  const { res, bodyText } = await debug.fetch(url, init, {
    onStreamLine: onLine,
    expectStream: true,
  });

  if (!res.ok) {
    throw new Error(`ollama: HTTP ${res.status} ${bodyText}`);
  }
  if (streamErr) {
    throw new Error(`ollama: ${streamErr}`);
  }
  const parsed = parseJudgeResponse(raw);
  return { ...parsed, raw, timings };
}

function nsToMs(ns: number | undefined): number {
  return typeof ns === 'number' ? Math.round(ns / 1_000_000) : 0;
}

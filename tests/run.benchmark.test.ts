import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer, type Server } from 'node:http';
import { runBenchmark } from '../src/run.js';
import type { Config, PromptSpec, Snapshot } from '../src/types.js';

let server: Server;
let judgeUrl = '';
let judgeMode: 'ok' | 'fail' = 'ok';

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (judgeMode === 'fail') {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('boom');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          message: { content: '{"score": 4, "rationale": "ok"}' },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (typeof addr === 'object' && addr) judgeUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const fakeClaude = resolve('tests/fixtures/fake-claude.js');
chmodSync(fakeClaude, 0o755);

const prompts: PromptSpec[] = [{ id: 'p1', prompt: 'x', rubric: 'r' }];

function baseConfig(): Config {
  return {
    plugin: { path: '/tmp/plugin', gitRoot: '/tmp/plugin' },
    provider: {
      command: 'node',
      extraArgs: [fakeClaude],
      timeout: 30,
      model: null,
      allowedTools: null,
    },
    judge: {
      provider: 'ollama',
      model: 'q',
      endpoint: judgeUrl,
      apiKeyEnv: null,
      temperature: 0,
      maxTokens: 256,
    },
    runs: { samples: 2, parallel: 2 },
    snapshots: { dir: '/tmp/snaps' },
  };
}

describe('runBenchmark', () => {
  it('runs the full matrix and judges each output', async () => {
    judgeMode = 'ok';
    const snap = await runBenchmark({
      config: baseConfig(),
      prompts,
      baselinePluginDir: '/tmp/a',
      currentPluginDir: '/tmp/b',
      baselineRef: 'v1',
      baselineSha: 'abc',
      currentRef: 'HEAD',
      currentSha: 'def',
      name: 'test',
    });
    expect(snap.runs).toHaveLength(4);
    expect(snap.judgments).toHaveLength(4);
    expect(snap.judgments.every((j) => j.score === 4)).toBe(true);
    expect(snap.summary.baseline.n).toBe(2);
    expect(snap.summary.current.n).toBe(2);
    expect(snap.complete).toBe(true);
  });

  it('records score 0 when judge throws and still completes the batch', async () => {
    judgeMode = 'fail';
    const snap = await runBenchmark({
      config: baseConfig(),
      prompts,
      baselinePluginDir: '/tmp/a',
      currentPluginDir: '/tmp/b',
      baselineRef: 'v1',
      baselineSha: 'abc',
      currentRef: 'HEAD',
      currentSha: 'def',
      name: 'test-judge-fail',
    });
    judgeMode = 'ok';
    expect(snap.runs).toHaveLength(4);
    expect(snap.judgments).toHaveLength(4);
    expect(snap.judgments.every((j) => j.score === 0)).toBe(true);
    expect(snap.judgments.every((j) => j.rationale.startsWith('judge failed:'))).toBe(true);
    expect(snap.judgments.every((j) => typeof j.error === 'string')).toBe(true);
    expect(snap.complete).toBe(true);
  });

  it('on resume, re-judges only failed judgments without re-invoking Claude', async () => {
    judgeMode = 'fail';
    const failed = await runBenchmark({
      config: baseConfig(),
      prompts,
      baselinePluginDir: '/tmp/a',
      currentPluginDir: '/tmp/b',
      baselineRef: 'v1',
      baselineSha: 'abc',
      currentRef: 'HEAD',
      currentSha: 'def',
      name: 'test-rejudge',
    });
    expect(failed.judgments.every((j) => j.error !== null)).toBe(true);

    judgeMode = 'ok';
    let runStarts = 0;
    let judgeStarts = 0;
    const recovered = await runBenchmark({
      config: baseConfig(),
      prompts,
      baselinePluginDir: '/tmp/a',
      currentPluginDir: '/tmp/b',
      baselineRef: 'v1',
      baselineSha: 'abc',
      currentRef: 'HEAD',
      currentSha: 'def',
      name: 'test-rejudge',
      resume: failed,
      onProgress: (ev) => {
        if (ev.kind === 'run-start') runStarts++;
        if (ev.kind === 'judge-start') judgeStarts++;
      },
    });
    expect(runStarts).toBe(0);
    expect(judgeStarts).toBe(4);
    expect(recovered.judgments).toHaveLength(4);
    expect(recovered.judgments.every((j) => j.error === null)).toBe(true);
    expect(recovered.judgments.every((j) => j.score === 4)).toBe(true);
  });

  it('checkpoints partial state after each row', async () => {
    judgeMode = 'ok';
    const partials: Snapshot[] = [];
    const snap = await runBenchmark({
      config: baseConfig(),
      prompts,
      baselinePluginDir: '/tmp/a',
      currentPluginDir: '/tmp/b',
      baselineRef: 'v1',
      baselineSha: 'abc',
      currentRef: 'HEAD',
      currentSha: 'def',
      name: 'test-ckpt',
      onCheckpoint: async (p) => {
        partials.push(p);
      },
    });
    expect(partials).toHaveLength(4);
    expect(partials.every((p) => p.complete === false)).toBe(true);
    expect(partials.at(-1)!.runs).toHaveLength(4);
    expect(snap.complete).toBe(true);
  });

  it('skips already-completed rows when resuming', async () => {
    judgeMode = 'ok';
    const first = await runBenchmark({
      config: baseConfig(),
      prompts,
      baselinePluginDir: '/tmp/a',
      currentPluginDir: '/tmp/b',
      baselineRef: 'v1',
      baselineSha: 'abc',
      currentRef: 'HEAD',
      currentSha: 'def',
      name: 'test-resume',
    });
    let invocations = 0;
    const second = await runBenchmark({
      config: baseConfig(),
      prompts,
      baselinePluginDir: '/tmp/a',
      currentPluginDir: '/tmp/b',
      baselineRef: 'v1',
      baselineSha: 'abc',
      currentRef: 'HEAD',
      currentSha: 'def',
      name: 'test-resume',
      resume: first,
      onProgress: (ev) => {
        if (ev.kind === 'run-start') invocations++;
      },
    });
    expect(invocations).toBe(0);
    expect(second.runs).toHaveLength(4);
    expect(second.judgments).toHaveLength(4);
    expect(second.complete).toBe(true);
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { execa } from 'execa';
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { pruneFailedRuns } from '../src/snapshot.js';
import type { Snapshot } from '../src/types.js';

let server: Server;
let judgeUrl = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: { content: '{"score":4,"rationale":"ok"}' } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (typeof addr === 'object' && addr) judgeUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

async function makeRepo(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'ef-retry-'));
  await execa('git', ['init', '-q', '-b', 'main'], { cwd: root });
  await execa('git', ['config', 'user.email', 't@t'], { cwd: root });
  await execa('git', ['config', 'user.name', 't'], { cwd: root });
  writeFileSync(join(root, 'f'), '1');
  await execa('git', ['add', '.'], { cwd: root });
  await execa('git', ['commit', '-m', 'v1', '-q'], { cwd: root });
  await execa('git', ['tag', 'v1'], { cwd: root });
  writeFileSync(join(root, 'f'), '2');
  await execa('git', ['commit', '-am', 'v2', '-q'], { cwd: root });
  const fakeClaude = resolve('tests/fixtures/fake-claude.js');
  chmodSync(fakeClaude, 0o755);
  writeFileSync(
    join(root, 'eval-bench.yaml'),
    `plugin:\n  path: ./\nprovider:\n  command: node\n  extraArgs: ['${fakeClaude}']\n  timeout: 10\njudge:\n  provider: ollama\n  model: q\n  endpoint: ${judgeUrl}\nruns:\n  samples: 1\n  parallel: 1\nsnapshots:\n  dir: ./snaps\n`,
  );
  writeFileSync(
    join(root, 'prompts.yaml'),
    `- id: p1\n  prompt: ok\n  rubric: r\n- id: p2\n  prompt: bad\n  rubric: r\n`,
  );
  return root;
}

const cliPath = resolve('src/cli/index.ts');
const sharedArgs = ['--config', 'eval-bench.yaml', '--prompts', 'prompts.yaml'];

function writeSnapshotWithOneFailure(repo: string, name: string): void {
  const snap: Snapshot = {
    schemaVersion: 1,
    name,
    createdAt: '2026-04-29T00:00:00Z',
    plugin: { path: './', baselineRef: '', baselineSha: '', currentRef: 'HEAD', currentSha: 'a'.repeat(40) },
    config: {
      plugin: { path: './', gitRoot: repo },
      provider: { command: 'node', extraArgs: [], timeout: 10, model: null, allowedTools: null },
      judge: { provider: 'ollama', model: 'q', endpoint: judgeUrl, apiKeyEnv: null, temperature: 0, maxTokens: 256 },
      runs: { samples: 1, parallel: 1 },
      snapshots: { dir: './snaps' },
    },
    judge: { provider: 'ollama', model: 'q' },
    prompts: [
      { id: 'p1', prompt: 'ok', rubric: 'r' },
      { id: 'p2', prompt: 'bad', rubric: 'r' },
    ],
    runs: [
      {
        id: 'p1::current::1',
        promptId: 'p1',
        variant: 'current',
        sample: 1,
        output: 'pre-existing-good-output',
        durationMs: 100,
        exitCode: 0,
        error: null,
        usage: null,
      },
      {
        id: 'p2::current::1',
        promptId: 'p2',
        variant: 'current',
        sample: 1,
        output: '',
        durationMs: 100,
        exitCode: 1,
        error: 'timed out',
        usage: null,
      },
    ],
    judgments: [
      {
        runId: 'p1::current::1',
        score: 4,
        rationale: 'ok',
        rubricHash: 'h',
        judgeProvider: 'ollama',
        judgeModel: 'q',
        raw: '{"score":4,"rationale":"ok"}',
        error: null,
      },
      {
        runId: 'p2::current::1',
        score: 0,
        rationale: 'run failed: timed out',
        rubricHash: '',
        judgeProvider: 'ollama',
        judgeModel: 'q',
        raw: '',
        error: 'run failed',
      },
    ],
    summary: {
      baseline: { n: 0, mean: 0, median: 0, variance: 0 },
      current: { n: 2, mean: 2, median: 2, variance: 4 },
      delta: 2,
    },
    complete: true,
  };
  const dir = join(repo, 'snaps', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'snapshot.json'), JSON.stringify(snap, null, 2));
}

describe('pruneFailedRuns', () => {
  it('drops runs with error and their judgments, marks complete=false', () => {
    const seed: Snapshot = {
      schemaVersion: 1,
      name: 't',
      createdAt: '',
      plugin: { path: '', baselineRef: '', baselineSha: '', currentRef: '', currentSha: '' },
      config: {} as never,
      judge: { provider: 'ollama', model: 'q' },
      prompts: [],
      runs: [
        { id: 'a', promptId: 'a', variant: 'current', sample: 1, output: 'x', durationMs: 0, exitCode: 0, error: null, usage: null },
        { id: 'b', promptId: 'b', variant: 'current', sample: 1, output: '', durationMs: 0, exitCode: 1, error: 'boom', usage: null },
      ],
      judgments: [
        { runId: 'a', score: 4, rationale: '', rubricHash: '', judgeProvider: 'ollama', judgeModel: 'q', raw: '', error: null },
        { runId: 'b', score: 0, rationale: '', rubricHash: '', judgeProvider: 'ollama', judgeModel: 'q', raw: '', error: 'run failed' },
      ],
      summary: { baseline: { n: 0, mean: 0, median: 0, variance: 0 }, current: { n: 0, mean: 0, median: 0, variance: 0 }, delta: 0 },
      complete: true,
    };
    const out = pruneFailedRuns(seed);
    expect(out.prunedRuns).toBe(1);
    expect(out.prunedJudgments).toBe(1);
    expect(out.prunedFailedJudgmentsOnly).toBe(0);
    expect(out.snap.complete).toBe(false);
    expect(out.snap.runs.map((r) => r.id)).toEqual(['a']);
    expect(out.snap.judgments.map((j) => j.runId)).toEqual(['a']);
  });

  it('drops judgments-only failures (run succeeded, judge errored) without dropping the run', () => {
    const seed: Snapshot = {
      schemaVersion: 1,
      name: 't',
      createdAt: '',
      plugin: { path: '', baselineRef: '', baselineSha: '', currentRef: '', currentSha: '' },
      config: {} as never,
      judge: { provider: 'ollama', model: 'q' },
      prompts: [],
      runs: [
        { id: 'a', promptId: 'a', variant: 'current', sample: 1, output: 'good', durationMs: 0, exitCode: 0, error: null, usage: null },
        { id: 'b', promptId: 'b', variant: 'current', sample: 1, output: 'also good', durationMs: 0, exitCode: 0, error: null, usage: null },
      ],
      judgments: [
        { runId: 'a', score: 4, rationale: '', rubricHash: '', judgeProvider: 'ollama', judgeModel: 'q', raw: '', error: null },
        { runId: 'b', score: 0, rationale: 'judge failed: parse error', rubricHash: '', judgeProvider: 'ollama', judgeModel: 'q', raw: 'c4 rather…', error: 'judge response: could not parse JSON' },
      ],
      summary: { baseline: { n: 0, mean: 0, median: 0, variance: 0 }, current: { n: 0, mean: 0, median: 0, variance: 0 }, delta: 0 },
      complete: true,
    };
    const out = pruneFailedRuns(seed);
    expect(out.prunedRuns).toBe(0);
    expect(out.prunedFailedJudgmentsOnly).toBe(1);
    expect(out.prunedJudgments).toBe(1);
    expect(out.snap.complete).toBe(false);
    // Both runs survive; the bad judgment is gone so the matrix dedup will
    // re-judge that row on resume.
    expect(out.snap.runs.map((r) => r.id).sort()).toEqual(['a', 'b']);
    expect(out.snap.judgments.map((j) => j.runId)).toEqual(['a']);
  });
});

describe('--retry-failed', () => {
  it('eb eval --retry-failed re-runs only failed rows and preserves successful ones', async () => {
    const repo = await makeRepo();
    writeSnapshotWithOneFailure(repo, 'baseline');

    const { exitCode, stdout, stderr } = await execa(
      'npx',
      ['tsx', cliPath, 'eval', '--save-as', 'baseline', '--retry-failed', ...sharedArgs],
      { cwd: repo, reject: false },
    );
    expect(exitCode, `stderr:\n${stderr}\nstdout:\n${stdout}`).toBe(0);
    expect(stdout).toMatch(/Retrying 1 failed run/);

    const snap: Snapshot = JSON.parse(
      await readFile(join(repo, 'snaps', 'baseline', 'snapshot.json'), 'utf8'),
    );
    expect(snap.complete).toBe(true);
    const p1 = snap.runs.find((r) => r.promptId === 'p1');
    const p2 = snap.runs.find((r) => r.promptId === 'p2');
    // Successful pre-existing run is preserved verbatim.
    expect(p1?.output).toBe('pre-existing-good-output');
    expect(p1?.error).toBeNull();
    // Failed run was re-executed; new output present, no error.
    expect(p2?.error).toBeNull();
    expect(p2?.output.length).toBeGreaterThan(0);
    expect(p2?.output).not.toBe('');
  }, 30_000);

  it('eb run --retry-failed errors when both --retry-failed and --force are passed', async () => {
    const repo = await makeRepo();
    writeSnapshotWithOneFailure(repo, 'baseline');
    const { exitCode, stderr, stdout } = await execa(
      'npx',
      [
        'tsx',
        cliPath,
        'run',
        '--baseline',
        'v1',
        '--save-as',
        'baseline',
        '--retry-failed',
        '--force',
        ...sharedArgs,
      ],
      { cwd: repo, reject: false },
    );
    expect(exitCode).toBe(1);
    expect(stderr + stdout).toMatch(/mutually exclusive/);
  }, 15_000);

  it('--retry-failed on a snapshot with no failures short-circuits with a clear log', async () => {
    const repo = await makeRepo();
    // Seed with a clean snapshot first.
    const seed = await execa(
      'npx',
      ['tsx', cliPath, 'eval', '--save-as', 'clean', ...sharedArgs],
      { cwd: repo, reject: false },
    );
    expect(seed.exitCode).toBe(0);
    const { exitCode, stdout } = await execa(
      'npx',
      ['tsx', cliPath, 'eval', '--save-as', 'clean', '--retry-failed', ...sharedArgs],
      { cwd: repo, reject: false },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/No failed runs or judgments to retry/);
  }, 30_000);

  it('eb run --retry-failed retries judgment-only failures without re-running Claude', async () => {
    const repo = await makeRepo();

    // Build a clean snapshot with both runs and judgments populated.
    const seed = await execa(
      'npx',
      [
        'tsx',
        cliPath,
        'run',
        '--baseline',
        'v1',
        '--save-as',
        'mixed',
        ...sharedArgs,
      ],
      { cwd: repo, reject: false },
    );
    expect(seed.exitCode).toBe(0);

    const path = join(repo, 'snaps', 'mixed', 'snapshot.json');
    const seedSnap: Snapshot = JSON.parse(await readFile(path, 'utf8'));
    // Corrupt one judgment so it looks like a parse failure (run kept clean).
    seedSnap.judgments[0].error = 'judge response: could not parse JSON (Unexpected token...)';
    seedSnap.judgments[0].score = 0;
    seedSnap.judgments[0].rationale = 'judge failed: …';
    writeFileSync(path, JSON.stringify(seedSnap));

    const { exitCode, stdout } = await execa(
      'npx',
      [
        'tsx',
        cliPath,
        'run',
        '--baseline',
        'v1',
        '--save-as',
        'mixed',
        '--retry-failed',
        ...sharedArgs,
      ],
      { cwd: repo, reject: false },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Retrying 1 failed judgment/);
    expect(stdout).not.toMatch(/Retrying \d+ failed run/);

    const after: Snapshot = JSON.parse(await readFile(path, 'utf8'));
    // Run output is preserved verbatim from seed.
    const seedRun = seedSnap.runs.find((r) => r.id === seedSnap.judgments[0].runId);
    const afterRun = after.runs.find((r) => r.id === seedSnap.judgments[0].runId);
    expect(afterRun?.output).toBe(seedRun?.output);
    // Judgment is fresh and successful.
    const fresh = after.judgments.find((j) => j.runId === seedSnap.judgments[0].runId);
    expect(fresh?.error).toBeNull();
    expect(fresh?.score).toBeGreaterThan(0);
  }, 60_000);

  it('--retry-failed on a non-existent snapshot errors clearly', async () => {
    const repo = await makeRepo();
    const { exitCode, stderr, stdout } = await execa(
      'npx',
      ['tsx', cliPath, 'eval', '--save-as', 'nope', '--retry-failed', ...sharedArgs],
      { cwd: repo, reject: false },
    );
    expect(exitCode).toBe(1);
    expect(stderr + stdout).toMatch(/nothing to retry/);
  }, 15_000);
});

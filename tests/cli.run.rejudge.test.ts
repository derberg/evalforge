import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { execa } from 'execa';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

let server: Server;
let judgeUrl = '';
let judgeScore = 4;
let judgeCalls = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      judgeCalls += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ message: { content: `{"score":${judgeScore},"rationale":"ok"}` } }),
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

async function makeRepo(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'ef-rj-'));
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
    `plugin:\n  path: ./\nprovider:\n  command: node\n  extraArgs: ['${fakeClaude}']\n  timeout: 10\njudge:\n  provider: ollama\n  model: q\n  endpoint: ${judgeUrl}\nruns:\n  samples: 2\n  parallel: 1\nsnapshots:\n  dir: ./snaps\n`,
  );
  writeFileSync(join(root, 'prompts.yaml'), `- id: p1\n  prompt: hello\n  rubric: score 0-5\n`);
  return root;
}

const cliPath = resolve('src/cli/index.ts');
const sharedArgs = ['--config', 'eval-bench.yaml', '--prompts', 'prompts.yaml'];

describe('eb run --rejudge', () => {
  it('re-judges cached runs without re-invoking Claude', async () => {
    const repo = await makeRepo();
    judgeScore = 4;

    // Seed: run baseline=v1 vs current=HEAD with judge returning 4.
    const seed = await execa(
      'npx',
      ['tsx', cliPath, 'run', '--baseline', 'v1', '--save-as', 'iter', ...sharedArgs],
      { cwd: repo, reject: false },
    );
    expect(seed.exitCode).toBe(0);
    const seedSnap = JSON.parse(
      await readFile(join(repo, 'snaps', 'iter', 'snapshot.json'), 'utf8'),
    );
    expect(seedSnap.runs).toHaveLength(4);
    expect(seedSnap.judgments.every((j: { score: number }) => j.score === 4)).toBe(true);

    // Flip the judge to score 2 and re-judge — Claude must NOT be invoked.
    judgeScore = 2;
    const callsBefore = judgeCalls;
    const { exitCode, stdout } = await execa(
      'npx',
      ['tsx', cliPath, 'run', '--baseline', 'v1', '--save-as', 'iter', '--rejudge', ...sharedArgs],
      { cwd: repo, reject: false },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Re-judging 4 cached runs/);
    expect(judgeCalls - callsBefore).toBe(4);

    const reSnap = JSON.parse(
      await readFile(join(repo, 'snaps', 'iter', 'snapshot.json'), 'utf8'),
    );
    expect(reSnap.runs).toHaveLength(4);
    // Claude outputs must be byte-identical to the seed.
    const seedOutputs = seedSnap.runs.map((r: { output: string }) => r.output).sort();
    const reOutputs = reSnap.runs.map((r: { output: string }) => r.output).sort();
    expect(reOutputs).toEqual(seedOutputs);
    // All judgments now reflect the new judge.
    expect(reSnap.judgments.every((j: { score: number }) => j.score === 2)).toBe(true);
    expect(reSnap.complete).toBe(true);
  }, 60_000);

  it('combines with --baseline-from and --current-from to re-judge a stitched snapshot', async () => {
    const repo = await makeRepo();
    judgeScore = 4;

    // Seed two single-variant snapshots.
    const seedBase = await execa(
      'npx',
      ['tsx', cliPath, 'eval', '--save-as', 'base', '--ref', 'v1', ...sharedArgs],
      { cwd: repo, reject: false },
    );
    expect(seedBase.exitCode).toBe(0);
    const seedCur = await execa(
      'npx',
      ['tsx', cliPath, 'eval', '--save-as', 'cur', ...sharedArgs],
      { cwd: repo, reject: false },
    );
    expect(seedCur.exitCode).toBe(0);

    // Stitch with --rejudge: zero Claude calls, fresh judgments at score 2.
    judgeScore = 2;
    const callsBefore = judgeCalls;
    const { exitCode } = await execa(
      'npx',
      [
        'tsx',
        cliPath,
        'run',
        '--baseline-from',
        'base',
        '--current-from',
        'cur',
        '--rejudge',
        '--save-as',
        'merged',
        ...sharedArgs,
      ],
      { cwd: repo, reject: false },
    );
    expect(exitCode).toBe(0);
    expect(judgeCalls - callsBefore).toBe(4);

    const mergedSnap = JSON.parse(
      await readFile(join(repo, 'snaps', 'merged', 'snapshot.json'), 'utf8'),
    );
    expect(mergedSnap.runs).toHaveLength(4);
    expect(mergedSnap.judgments).toHaveLength(4);
    expect(mergedSnap.judgments.every((j: { score: number }) => j.score === 2)).toBe(true);
  }, 60_000);

  it('rejects --rejudge with --force', async () => {
    const repo = await makeRepo();
    const { exitCode, stderr, stdout } = await execa(
      'npx',
      ['tsx', cliPath, 'run', '--rejudge', '--force', '--save-as', 'x', ...sharedArgs],
      { cwd: repo, reject: false },
    );
    expect(exitCode).toBe(1);
    expect(stderr + stdout).toMatch(/--rejudge and --force are mutually exclusive/);
  }, 30_000);

  it('rejects --rejudge with --retry-failed', async () => {
    const repo = await makeRepo();
    const { exitCode, stderr, stdout } = await execa(
      'npx',
      [
        'tsx',
        cliPath,
        'run',
        '--rejudge',
        '--retry-failed',
        '--save-as',
        'x',
        ...sharedArgs,
      ],
      { cwd: repo, reject: false },
    );
    expect(exitCode).toBe(1);
    expect(stderr + stdout).toMatch(/--rejudge and --retry-failed are mutually exclusive/);
  }, 30_000);
});

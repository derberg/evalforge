import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { execa } from 'execa';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

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
  const root = mkdtempSync(join(tmpdir(), 'ef-bf-'));
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

describe('eb run --baseline-from', () => {
  it('reuses baseline runs from a saved snapshot and only runs current side', async () => {
    const repo = await makeRepo();
    // Seed: eval at v1.
    const seed = await execa(
      'npx',
      ['tsx', cliPath, 'eval', '--save-as', 'baseline', '--ref', 'v1', ...sharedArgs],
      { cwd: repo, reject: false },
    );
    expect(seed.exitCode).toBe(0);

    const seedSnap = JSON.parse(
      await readFile(join(repo, 'snaps', 'baseline', 'snapshot.json'), 'utf8'),
    );
    expect(seedSnap.runs.every((r: { variant: string }) => r.variant === 'current')).toBe(true);

    // Run with --baseline-from baseline.
    const { exitCode, stdout } = await execa(
      'npx',
      [
        'tsx',
        cliPath,
        'run',
        '--baseline-from',
        'baseline',
        '--save-as',
        'iter',
        ...sharedArgs,
      ],
      { cwd: repo, reject: false },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/cached from snapshot "baseline"/);
    expect(stdout).toMatch(/2 runs reused/);

    const iterSnap = JSON.parse(
      await readFile(join(repo, 'snaps', 'iter', 'snapshot.json'), 'utf8'),
    );
    // 1 prompt × 2 samples × 2 variants = 4 runs total
    expect(iterSnap.runs).toHaveLength(4);
    const baselineRuns = iterSnap.runs.filter((r: { variant: string }) => r.variant === 'baseline');
    const currentRuns = iterSnap.runs.filter((r: { variant: string }) => r.variant === 'current');
    expect(baselineRuns).toHaveLength(2);
    expect(currentRuns).toHaveLength(2);
    // Reused baseline runs carry the original outputs verbatim.
    const seedOutputs = seedSnap.runs.map((r: { output: string }) => r.output).sort();
    const reusedOutputs = baselineRuns.map((r: { output: string }) => r.output).sort();
    expect(reusedOutputs).toEqual(seedOutputs);
    // Baseline ref/sha are inherited from the cached snapshot.
    expect(iterSnap.plugin.baselineRef).toBe(seedSnap.plugin.currentRef);
    expect(iterSnap.plugin.baselineSha).toBe(seedSnap.plugin.currentSha);
  }, 60_000);

  it('rejects --baseline and --baseline-from together', async () => {
    const repo = await makeRepo();
    const { exitCode, stderr, stdout } = await execa(
      'npx',
      [
        'tsx',
        cliPath,
        'run',
        '--baseline',
        'v1',
        '--baseline-from',
        'baseline',
        '--save-as',
        'x',
        ...sharedArgs,
      ],
      { cwd: repo, reject: false },
    );
    expect(exitCode).toBe(1);
    expect(stderr + stdout).toMatch(/mutually exclusive/);
  }, 30_000);
});

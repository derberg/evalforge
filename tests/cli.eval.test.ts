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
  const root = mkdtempSync(join(tmpdir(), 'ef-eval-'));
  await execa('git', ['init', '-q', '-b', 'main'], { cwd: root });
  await execa('git', ['config', 'user.email', 't@t'], { cwd: root });
  await execa('git', ['config', 'user.name', 't'], { cwd: root });
  writeFileSync(join(root, 'f'), '1');
  await execa('git', ['add', '.'], { cwd: root });
  await execa('git', ['commit', '-m', 'v1', '-q'], { cwd: root });
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
const baseArgs = ['--save-as', 'snap1', '--config', 'eval-bench.yaml', '--prompts', 'prompts.yaml'];

describe('eb eval', () => {
  it('runs only the current variant and saves a snapshot', async () => {
    const repo = await makeRepo();
    const { exitCode, stdout } = await execa(
      'npx',
      ['tsx', cliPath, 'eval', ...baseArgs],
      { cwd: repo, reject: false },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Snapshot saved/);
    const snap = JSON.parse(await readFile(join(repo, 'snaps', 'snap1', 'snapshot.json'), 'utf8'));
    // 1 prompt × 2 samples × 1 variant
    expect(snap.runs).toHaveLength(2);
    expect(snap.runs.every((r: { variant: string }) => r.variant === 'current')).toBe(true);
    expect(snap.summary.baseline.n).toBe(0);
    expect(snap.summary.current.n).toBe(2);
    expect(snap.plugin.baselineRef).toBe('');
    expect(snap.plugin.baselineSha).toBe('');
  }, 30_000);

  it('refuses to overwrite a complete snapshot without --force', async () => {
    const repo = await makeRepo();
    const run = (): Promise<{ exitCode: number | undefined; stderr: string; stdout: string }> =>
      execa('npx', ['tsx', cliPath, 'eval', ...baseArgs], { cwd: repo, reject: false });
    const first = await run();
    expect(first.exitCode).toBe(0);
    const second = await run();
    expect(second.exitCode).toBe(1);
    expect(second.stderr + second.stdout).toMatch(/--force/);
    const third = await execa(
      'npx',
      ['tsx', cliPath, 'eval', ...baseArgs, '--force'],
      { cwd: repo, reject: false },
    );
    expect(third.exitCode).toBe(0);
  }, 60_000);
});

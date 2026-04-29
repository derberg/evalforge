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
  const root = mkdtempSync(join(tmpdir(), 'ef-only-'));
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
    `- id: p1\n  prompt: hello-1\n  rubric: r\n- id: p2\n  prompt: hello-2\n  rubric: r\n- id: p3\n  prompt: hello-3\n  rubric: r\n`,
  );
  return root;
}

const cliPath = resolve('src/cli/index.ts');
const sharedArgs = ['--config', 'eval-bench.yaml', '--prompts', 'prompts.yaml'];

describe('--only', () => {
  it('eb eval --only restricts the matrix to the named prompts', async () => {
    const repo = await makeRepo();
    const { exitCode, stdout } = await execa(
      'npx',
      ['tsx', cliPath, 'eval', '--save-as', 's1', '--only', 'p1,p3', ...sharedArgs],
      { cwd: repo, reject: false },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Prompts:\s+2\/3/);
    const snap = JSON.parse(await readFile(join(repo, 'snaps', 's1', 'snapshot.json'), 'utf8'));
    expect(snap.prompts.map((p: { id: string }) => p.id).sort()).toEqual(['p1', 'p3']);
    expect(snap.runs).toHaveLength(2);
    expect(snap.runs.every((r: { promptId: string }) => ['p1', 'p3'].includes(r.promptId))).toBe(true);
  }, 30_000);

  it('eb eval --only repeated flag accumulates ids', async () => {
    const repo = await makeRepo();
    const { exitCode } = await execa(
      'npx',
      ['tsx', cliPath, 'eval', '--save-as', 's2', '--only', 'p1', '--only', 'p2', ...sharedArgs],
      { cwd: repo, reject: false },
    );
    expect(exitCode).toBe(0);
    const snap = JSON.parse(await readFile(join(repo, 'snaps', 's2', 'snapshot.json'), 'utf8'));
    expect(snap.prompts.map((p: { id: string }) => p.id).sort()).toEqual(['p1', 'p2']);
  }, 30_000);

  it('errors clearly when an --only id does not exist', async () => {
    const repo = await makeRepo();
    const { exitCode, stderr, stdout } = await execa(
      'npx',
      ['tsx', cliPath, 'eval', '--save-as', 's3', '--only', 'nope', ...sharedArgs],
      { cwd: repo, reject: false },
    );
    expect(exitCode).not.toBe(0);
    expect(stderr + stdout).toMatch(/unknown prompt id\(s\): nope/);
  }, 15_000);

  it('eb run --only --baseline-from filters cached baseline runs to the same prompt set', async () => {
    const repo = await makeRepo();
    // Seed full baseline (3 prompts).
    const seed = await execa(
      'npx',
      ['tsx', cliPath, 'eval', '--save-as', 'base', '--ref', 'v1', ...sharedArgs],
      { cwd: repo, reject: false },
    );
    expect(seed.exitCode).toBe(0);

    // Run filtered to p2 only.
    const { exitCode } = await execa(
      'npx',
      [
        'tsx',
        cliPath,
        'run',
        '--baseline-from',
        'base',
        '--save-as',
        'iter',
        '--only',
        'p2',
        ...sharedArgs,
      ],
      { cwd: repo, reject: false },
    );
    expect(exitCode).toBe(0);
    const snap = JSON.parse(await readFile(join(repo, 'snaps', 'iter', 'snapshot.json'), 'utf8'));
    expect(snap.prompts.map((p: { id: string }) => p.id)).toEqual(['p2']);
    // Both variants but only for p2: 2 runs total.
    expect(snap.runs).toHaveLength(2);
    expect(snap.runs.every((r: { promptId: string }) => r.promptId === 'p2')).toBe(true);
    const variants = snap.runs.map((r: { variant: string }) => r.variant).sort();
    expect(variants).toEqual(['baseline', 'current']);
  }, 60_000);
});

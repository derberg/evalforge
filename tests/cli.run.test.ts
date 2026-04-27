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

async function makeGitRepo(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'ef-run-'));
  await execa('git', ['init', '-q', '-b', 'main'], { cwd: root });
  await execa('git', ['config', 'user.email', 't@t'], { cwd: root });
  await execa('git', ['config', 'user.name', 't'], { cwd: root });
  writeFileSync(join(root, 'f'), '1');
  await execa('git', ['add', '.'], { cwd: root });
  await execa('git', ['commit', '-m', 'v1', '-q'], { cwd: root });
  await execa('git', ['tag', 'v1'], { cwd: root });
  writeFileSync(join(root, 'f'), '2');
  await execa('git', ['commit', '-am', 'v2', '-q'], { cwd: root });
  return root;
}

describe('ef run', () => {
  it('runs end-to-end and saves a snapshot', async () => {
    const repo = await makeGitRepo();
    const fakeClaude = resolve('tests/fixtures/fake-claude.js');
    chmodSync(fakeClaude, 0o755);
    writeFileSync(
      join(repo, 'eval-bench.yaml'),
      `plugin:\n  path: ./\nprovider:\n  command: node\n  extraArgs: ['${fakeClaude}']\n  timeout: 10\njudge:\n  provider: ollama\n  model: q\n  endpoint: ${judgeUrl}\nruns:\n  samples: 1\n  parallel: 1\nsnapshots:\n  dir: ./snaps\n`,
    );
    writeFileSync(join(repo, 'prompts.yaml'), `- id: p1\n  prompt: hello\n  rubric: score 0-5\n`);
    const cliPath = resolve('src/cli/index.ts');
    const { exitCode, stdout } = await execa(
      'npx',
      ['tsx', cliPath, 'run', '--baseline', 'v1', '--save-as', 'r1'],
      { cwd: repo, reject: false },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Snapshot saved/);
    const snapPath = join(repo, 'snaps', 'r1', 'snapshot.json');
    const snap = JSON.parse(await readFile(snapPath, 'utf8'));
    expect(snap.runs).toHaveLength(2);
    expect(snap.judgments).toHaveLength(2);
  }, 30_000);
});

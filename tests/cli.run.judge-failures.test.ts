import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { execa } from 'execa';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

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
        res.end('judge upstream broken');
        return;
      }
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
  const root = mkdtempSync(join(tmpdir(), 'ef-jf-'));
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

describe('eb run judgment failures', () => {
  it('prints FAIL on the progress line when the judge errors and exits 1 when every judgment failed', async () => {
    const repo = await makeRepo();
    judgeMode = 'fail';

    const { exitCode, stdout, stderr } = await execa(
      'npx',
      ['tsx', cliPath, 'run', '--baseline', 'v1', '--save-as', 'broken', ...sharedArgs],
      { cwd: repo, reject: false },
    );

    // Bug 1: progress line for an errored judgment must say FAIL, not OK.
    const progressLines = stdout.split('\n').filter((l) => /\[\d+\/\d+\]/.test(l));
    const okTerminalLines = progressLines.filter((l) => /\bOK\b/.test(l));
    const failTerminalLines = progressLines.filter((l) => /\bFAIL\b/.test(l));
    expect(failTerminalLines.length).toBeGreaterThan(0);
    expect(okTerminalLines.length).toBe(0);

    // Bug 2: warn surfaces total failed count + first error sample.
    expect(stdout).toMatch(/judgments failed — first error/);
    // Bug 2: exit non-zero when nothing was actually judged.
    expect(exitCode).toBe(1);
    expect(stderr + stdout).toMatch(/All \d+ judgments failed/);

    // The snapshot itself should still have been written so the user can
    // inspect the failure rationales.
    const snap = JSON.parse(await readFile(join(repo, 'snaps', 'broken', 'snapshot.json'), 'utf8'));
    expect(snap.runs).toHaveLength(4);
    expect(snap.judgments).toHaveLength(4);
    expect(snap.judgments.every((j: { error: string | null }) => j.error !== null)).toBe(true);
  }, 60_000);

  it('exits 0 when only some judgments failed (partial failure is recoverable via --rejudge or --retry-failed)', async () => {
    const repo = await makeRepo();
    judgeMode = 'ok';

    // First, build a clean snapshot.
    const seed = await execa(
      'npx',
      ['tsx', cliPath, 'run', '--baseline', 'v1', '--save-as', 'mixed', ...sharedArgs],
      { cwd: repo, reject: false },
    );
    expect(seed.exitCode).toBe(0);

    // Manually corrupt one judgment so it looks failed, then resume — the
    // dedup logic will re-judge that one row only. Judge stays healthy this
    // time, so the partial failure heals.
    const path = join(repo, 'snaps', 'mixed', 'snapshot.json');
    const snap = JSON.parse(await readFile(path, 'utf8'));
    snap.judgments[0].error = 'simulated transient failure';
    snap.judgments[0].score = 0;
    snap.complete = false;
    writeFileSync(path, JSON.stringify(snap));

    const { exitCode, stdout } = await execa(
      'npx',
      ['tsx', cliPath, 'run', '--baseline', 'v1', '--save-as', 'mixed', ...sharedArgs],
      { cwd: repo, reject: false },
    );
    expect(exitCode).toBe(0);
    // After resume + heal, no failure summary should be printed.
    expect(stdout).not.toMatch(/judgments failed — first error/);
  }, 60_000);
});

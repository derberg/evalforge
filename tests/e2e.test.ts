import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { execa } from 'execa';
import { mkdtempSync, cpSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let server: Server;
let judgeUrl = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      // Score based on output length so deltas appear when fake-claude prints longer text.
      const reqBody = JSON.parse(body);
      const content: string = reqBody.messages[0].content;
      const m = content.match(/OUTPUT:\s*([\s\S]*?)-----\nRUBRIC/);
      const output = m ? m[1].trim() : '';
      const score = Math.min(5, output.length / 10);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          message: { content: `{"score":${score},"rationale":"len-based"}` },
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

describe('e2e', () => {
  it('init → run baseline → edit → run with compare', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'ef-e2e-'));
    cpSync('tests/e2e/toy-plugin', repo, { recursive: true });
    await execa('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    await execa('git', ['config', 'user.email', 't@t'], { cwd: repo });
    await execa('git', ['config', 'user.name', 't'], { cwd: repo });
    await execa('git', ['add', '.'], { cwd: repo });
    await execa('git', ['commit', '-m', 'v1', '-q'], { cwd: repo });

    const cli = resolve('src/cli/index.ts');
    const cfg = readFileSync(join(repo, 'eval-bench.yaml'), 'utf8').replace('JUDGE_URL', judgeUrl);
    writeFileSync(join(repo, 'eval-bench.yaml'), cfg);

    const r1 = await execa(
      'npx',
      ['tsx', cli, 'run', '--baseline', 'HEAD', '--save-as', 'v1-baseline'],
      { cwd: repo, reject: false },
    );
    expect(r1.exitCode).toBe(0);

    // Make current produce LONGER output than baseline by editing the fixture.
    writeFileSync(
      join(repo, 'fake-claude.js'),
      readFileSync(join(repo, 'fake-claude.js'), 'utf8').replace(
        'PLUGIN=',
        'PLUGIN_VERSION_TWO_MUCH_LONGER_OUTPUT=',
      ),
    );
    await execa('git', ['commit', '-am', 'v2', '-q'], { cwd: repo });

    const r2 = await execa(
      'npx',
      [
        'tsx',
        cli,
        'run',
        '--baseline',
        'HEAD~1',
        '--save-as',
        'v2',
        '--compare',
        'v1-baseline',
      ],
      { cwd: repo, reject: false },
    );
    expect(r2.exitCode).toBe(0);
    expect(r2.stdout).toMatch(/improved|stable|regressed/);
  }, 60_000);
});

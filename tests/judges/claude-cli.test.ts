import { describe, it, expect } from 'vitest';
import { chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { judgeWithClaudeCli } from '../../src/judges/claude-cli.js';

const fakeJudge = resolve('tests/fixtures/fake-claude-judge.js');
chmodSync(fakeJudge, 0o755);

describe('judgeWithClaudeCli', () => {
  it('spawns the command, parses JSON from stdout', async () => {
    const r = await judgeWithClaudeCli({
      command: 'node',
      extraArgs: [fakeJudge],
      model: null,
      timeoutMs: 5000,
      prompt: 'p',
      output: 'o',
      rubric: 'r',
    });
    expect(r.score).toBe(4);
    expect(r.rationale).toBe('looks fine');
  });

  it('throws on timeout', async () => {
    const hang = resolve('tests/fixtures/hang.js');
    await expect(
      judgeWithClaudeCli({
        command: 'node',
        extraArgs: [hang],
        model: null,
        timeoutMs: 200,
        prompt: 'p',
        output: 'o',
        rubric: 'r',
      }),
    ).rejects.toThrow(/timed out|killed|SIGTERM/i);
  });

  it('throws on non-zero exit', async () => {
    const exiter = resolve('tests/fixtures/exit-with-code.js');
    chmodSync(exiter, 0o755);
    await expect(
      judgeWithClaudeCli({
        command: 'node',
        extraArgs: [exiter, '7'],
        model: null,
        timeoutMs: 5000,
        prompt: 'p',
        output: 'o',
        rubric: 'r',
      }),
    ).rejects.toThrow(/exit 7/);
  });

  it('does not pipe stdin to the judge process — child sees EOF immediately', async () => {
    // Real claude CLI warns + exits non-zero when stdin is left open as a
    // pipe with no data ("Warning: no stdin data received in 3s, proceeding
    // without it"). The fixture mirrors that contract: it succeeds only when
    // stdin closes promptly.
    const stdinDetect = resolve('tests/fixtures/fake-claude-stdin-detect.js');
    chmodSync(stdinDetect, 0o755);
    const r = await judgeWithClaudeCli({
      command: 'node',
      extraArgs: [stdinDetect],
      model: null,
      timeoutMs: 5000,
      prompt: 'p',
      output: 'o',
      rubric: 'r',
    });
    expect(r.score).toBe(4);
    expect(r.rationale).toBe('stdin-eof-received');
  });
});

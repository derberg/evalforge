import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { readInlinePrompt } from '../src/cli/prompt-inline.js';

// Drive readInlinePrompt with synthetic streams instead of a real TTY. We
// flag the input as `isTTY` because the function refuses non-TTY streams to
// keep the contract honest (the docs promise interactive use only).
function ttyPair(): { input: PassThrough & { isTTY?: boolean }; output: PassThrough; written: () => string } {
  const input = new PassThrough() as PassThrough & { isTTY?: boolean };
  input.isTTY = true;
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on('data', (c) => chunks.push(c));
  return { input, output, written: () => Buffer.concat(chunks).toString('utf8') };
}

describe('readInlinePrompt', () => {
  it('reads id, prompt, and rubric, terminating multi-line fields on a "." line', async () => {
    const { input, output } = ttyPair();
    const result = readInlinePrompt(input, output);
    // Drain the synchronous prompt write before sending answers.
    await new Promise((r) => setImmediate(r));
    input.write('my-prompt\n');
    input.write('first prompt line\n');
    input.write('second prompt line\n');
    input.write('.\n');
    input.write('rubric line one\n');
    input.write('rubric line two\n');
    input.write('.\n');
    const spec = await result;
    expect(spec.id).toBe('my-prompt');
    expect(spec.prompt).toBe('first prompt line\nsecond prompt line');
    expect(spec.rubric).toBe('rubric line one\nrubric line two');
  });

  it('defaults the id to "adhoc" when the user just hits enter', async () => {
    const { input, output } = ttyPair();
    const result = readInlinePrompt(input, output);
    await new Promise((r) => setImmediate(r));
    input.write('\n');
    input.write('a prompt\n');
    input.write('.\n');
    input.write('a rubric\n');
    input.write('.\n');
    const spec = await result;
    expect(spec.id).toBe('adhoc');
  });

  it('rejects an id that is not kebab-case and re-asks', async () => {
    const { input, output, written } = ttyPair();
    const result = readInlinePrompt(input, output);
    await new Promise((r) => setImmediate(r));
    input.write('Bad ID!\n');
    input.write('good-id\n');
    input.write('p\n.\n');
    input.write('r\n.\n');
    const spec = await result;
    expect(spec.id).toBe('good-id');
    expect(written()).toMatch(/id must match/);
  });

  it('rejects an empty prompt body and asks again', async () => {
    const { input, output, written } = ttyPair();
    const result = readInlinePrompt(input, output);
    await new Promise((r) => setImmediate(r));
    input.write('id\n');
    // Empty prompt: send "." right away.
    input.write('.\n');
    // Now a real one.
    input.write('hello\n');
    input.write('.\n');
    input.write('rubric\n');
    input.write('.\n');
    const spec = await result;
    expect(spec.prompt).toBe('hello');
    expect(written()).toMatch(/prompt body cannot be empty/);
  });

  it('rejects non-TTY input so piped or redirected stdin produces a clear error', async () => {
    const input = new PassThrough() as PassThrough & { isTTY?: boolean };
    input.isTTY = false;
    const output = new PassThrough();
    output.on('data', () => {});
    await expect(readInlinePrompt(input, output)).rejects.toThrow(/TTY/);
  });
});

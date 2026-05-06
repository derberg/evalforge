import { createInterface } from 'node:readline';
import type { PromptSpec } from '../types.js';

// Read one prompt + rubric interactively from the terminal so the user can
// iterate on a single rubric without committing to prompts.yaml. Multi-line
// fields are terminated by a line containing only "." — pragmatic choice over
// EOF (which is harder for users to find on different shells/keyboards) and
// over a fixed delimiter string (which can collide with rubric content).
//
// The prompt id must match the kebab-case shape that prompts.yaml's loader
// requires; we validate locally so the error message points at the input
// instead of bubbling up from zod inside loadPrompts.
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

// Event-based rather than `for await (const line of rl)` because readline's
// async-iterator protocol doesn't compose well with re-entering iteration
// after a break — once you stop iterating, the listener is detached and any
// already-emitted lines are dropped. A single persistent 'line' listener
// driven by a phase machine is the only shape that's reliable across Node
// versions.
export function readInlinePrompt(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<PromptSpec> {
  if ('isTTY' in input && !(input as NodeJS.ReadStream).isTTY) {
    return Promise.reject(
      new Error(
        '--prompt-inline requires an interactive terminal (TTY). Piped or redirected stdin is not supported — use --prompts <file> instead.',
      ),
    );
  }
  return new Promise<PromptSpec>((resolve, reject) => {
    const rl = createInterface({ input, output, terminal: true });
    let phase: 'id' | 'prompt' | 'rubric' = 'id';
    let id: string | null = null;
    const promptLines: string[] = [];
    const rubricLines: string[] = [];
    let resolved = false;

    output.write('\n--- inline prompt ---\n');
    output.write('Prompt id [adhoc]: ');

    rl.on('line', (line) => {
      if (phase === 'id') {
        const raw = line.trim();
        const candidate = raw === '' ? 'adhoc' : raw;
        if (!ID_RE.test(candidate)) {
          output.write(`  ✗ id must match ${ID_RE} — try again\n`);
          output.write('Prompt id [adhoc]: ');
          return;
        }
        id = candidate;
        phase = 'prompt';
        output.write('Prompt body — finish with a line containing only "." :\n');
        return;
      }
      if (phase === 'prompt') {
        if (line === '.') {
          if (!promptLines.join('\n').trim()) {
            output.write('  ✗ prompt body cannot be empty — keep typing\n');
            return;
          }
          phase = 'rubric';
          output.write('Rubric — finish with a line containing only "." :\n');
          return;
        }
        promptLines.push(line);
        return;
      }
      if (phase === 'rubric') {
        if (line === '.') {
          if (!rubricLines.join('\n').trim()) {
            output.write('  ✗ rubric cannot be empty — keep typing\n');
            return;
          }
          resolved = true;
          rl.close();
          output.write('--- running ---\n\n');
          resolve({ id: id!, prompt: promptLines.join('\n'), rubric: rubricLines.join('\n') });
          return;
        }
        rubricLines.push(line);
        return;
      }
    });

    rl.on('close', () => {
      if (!resolved) {
        reject(new Error('inline prompt input was aborted before completion'));
      }
    });
  });
}

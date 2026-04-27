import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../src/cli/init.js';

describe('ef init', () => {
  it('writes eval-bench.yaml, prompts.yaml, snapshots/.gitkeep', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ef-init-'));
    await runInit({ cwd: dir, ci: false });
    expect(existsSync(join(dir, '.eval-bench', 'eval-bench.yaml'))).toBe(true);
    expect(existsSync(join(dir, '.eval-bench', 'prompts.yaml'))).toBe(true);
    expect(existsSync(join(dir, '.eval-bench', 'snapshots', '.gitkeep'))).toBe(true);
    expect(readFileSync(join(dir, '.eval-bench', 'eval-bench.yaml'), 'utf8')).toContain('judge:');
  });

  it('emits GH Actions workflow with --ci', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ef-init-'));
    await runInit({ cwd: dir, ci: true });
    expect(existsSync(join(dir, '.github', 'workflows', 'eval-bench.yml'))).toBe(true);
  });

  it('does not overwrite existing files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ef-init-'));
    mkdirSync(join(dir, '.eval-bench'), { recursive: true });
    writeFileSync(join(dir, '.eval-bench', 'eval-bench.yaml'), 'custom');
    await runInit({ cwd: dir, ci: false });
    expect(readFileSync(join(dir, '.eval-bench', 'eval-bench.yaml'), 'utf8')).toBe('custom');
  });
});

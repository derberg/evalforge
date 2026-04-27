import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

function writeTempYaml(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ef-test-'));
  const path = join(dir, 'eval-bench.yaml');
  writeFileSync(path, content);
  return path;
}

describe('loadConfig', () => {
  it('applies defaults for a minimal config', () => {
    const path = writeTempYaml(`
judge:
  provider: ollama
  model: qwen2.5:14b
  endpoint: http://localhost:11434
`);
    const cfg = loadConfig(path);
    expect(cfg.plugin.path).toBe('./');
    expect(cfg.runs.samples).toBe(3);
    expect(cfg.runs.parallel).toBe(2);
    expect(cfg.judge.temperature).toBe(0);
    expect(cfg.snapshots.dir).toBe('./.eval-bench/snapshots');
  });

  it('rejects invalid judge provider', () => {
    const path = writeTempYaml(`
judge:
  provider: bogus
  model: x
`);
    expect(() => loadConfig(path)).toThrow();
  });

  it('requires endpoint for ollama', () => {
    const path = writeTempYaml(`
judge:
  provider: ollama
  model: qwen2.5:14b
`);
    expect(() => loadConfig(path)).toThrow(/endpoint/);
  });

  it('requires endpoint for openai-compatible', () => {
    const path = writeTempYaml(`
judge:
  provider: openai-compatible
  model: mistral
`);
    expect(() => loadConfig(path)).toThrow(/endpoint/);
  });

  it('does not require endpoint for anthropic', () => {
    const path = writeTempYaml(`
judge:
  provider: anthropic
  model: claude-opus-4-7
`);
    const cfg = loadConfig(path);
    expect(cfg.judge.provider).toBe('anthropic');
  });
});

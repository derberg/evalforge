import { describe, it, expect } from 'vitest';
import { execa } from 'execa';

describe('cli', () => {
  it('prints help with --help', async () => {
    const result = await execa('npx', ['tsx', 'src/cli/index.ts', '--help']);
    expect(result.stdout).toMatch(/Usage: eval-bench/);
    expect(result.stdout).toMatch(/init/);
    expect(result.stdout).toMatch(/run/);
    expect(result.stdout).toMatch(/compare/);
  });

  it('prints version with --version', async () => {
    const result = await execa('npx', ['tsx', 'src/cli/index.ts', '--version']);
    expect(result.stdout.trim()).toBe('0.2.0');
  });
});

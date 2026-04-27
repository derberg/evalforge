import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('release metadata', () => {
  it('package.json has repository, bugs, homepage', () => {
    const p = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(p.repository).toBeTruthy();
    expect(p.bugs).toBeTruthy();
    expect(p.homepage).toBeTruthy();
  });
  it('CHANGELOG exists with v0.2.0 entry', () => {
    const text = readFileSync('CHANGELOG.md', 'utf8');
    expect(text).toMatch(/0\.2\.0/);
  });
});

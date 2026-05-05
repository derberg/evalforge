import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { viewCommand } from '../src/cli/view.js';

function seed(dir: string, name: string) {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(
    join(dir, name, 'snapshot.json'),
    JSON.stringify({
      schemaVersion: 1,
      name,
      createdAt: '2026-04-23T00:00:00Z',
      plugin: { path: '', baselineRef: '', baselineSha: '', currentRef: '', currentSha: '' },
      config: {},
      judge: { provider: 'ollama', model: 'q' },
      prompts: [{ id: 'p1', prompt: 'x', rubric: 'r' }],
      runs: [
        {
          id: 'p1::baseline::1',
          promptId: 'p1',
          variant: 'baseline',
          sample: 1,
          output: 'hi',
          durationMs: 1,
          exitCode: 0,
          error: null,
        },
      ],
      judgments: [
        {
          runId: 'p1::baseline::1',
          score: 4,
          rationale: 'ok',
          rubricHash: '',
          judgeProvider: 'ollama',
          judgeModel: 'q',
          raw: '',
        },
      ],
      summary: {
        baseline: { n: 1, mean: 4, median: 4, variance: 0 },
        current: { n: 0, mean: 0, median: 0, variance: 0 },
        delta: -4,
      },
    }),
  );
}

describe('ef view', () => {
  it('generates an HTML file under snapshot dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ef-view-'));
    seed(dir, 'a');
    const html = await viewCommand({ dir, name: 'a', writeHtml: true, open: false });
    expect(existsSync(join(dir, 'a', 'view.html'))).toBe(true);
    expect(html).toContain('<html');
    expect(html).toContain('p1');
    expect(html).toContain('score 4');
  });

  it('renders ref + short SHA so two HEADs at different commits are visually distinct', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ef-view-'));
    mkdirSync(join(dir, 'merged'), { recursive: true });
    writeFileSync(
      join(dir, 'merged', 'snapshot.json'),
      JSON.stringify({
        schemaVersion: 1,
        name: 'merged',
        createdAt: '2026-05-05T00:00:00Z',
        plugin: {
          path: '',
          // Both refs are HEAD (typical of --baseline-from/--current-from
          // stitches inheriting the source snapshots' currentRef).
          baselineRef: 'HEAD',
          baselineSha: '6ee8e7dfb0142d2701e03d5587f50425cf4880ec',
          currentRef: 'HEAD',
          currentSha: '5a438cb85e71c9a72534e2afa8bb2157da54b032',
        },
        config: {},
        judge: { provider: 'claude-cli', model: 'claude-sonnet-4-6' },
        prompts: [{ id: 'p1', prompt: 'x', rubric: 'r' }],
        runs: [],
        judgments: [],
        summary: {
          baseline: { n: 0, mean: 0, median: 0, variance: 0 },
          current: { n: 0, mean: 0, median: 0, variance: 0 },
          delta: 0,
        },
      }),
    );
    const html = await viewCommand({ dir, name: 'merged', writeHtml: true, open: false });
    expect(html).toContain('HEAD@6ee8e7d');
    expect(html).toContain('HEAD@5a438cb');
    // Pre-fix output rendered both as bare "HEAD" — confirm we're past that.
    expect(html).not.toMatch(/base <b>HEAD<\/b>\s*→\s*curr <b>HEAD<\/b>/);
  });

  it('emits CSS that lets paired cells stretch to the taller of the pair (no fixed height)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ef-view-'));
    seed(dir, 'a');
    const html = await viewCommand({ dir, name: 'a', writeHtml: true, open: false });
    // The .variants grid must use auto-rows + stretch so each row sizes to
    // its tallest cell and shorter cells fill the row.
    expect(html).toContain('display:grid');
    expect(html).toMatch(/\.variants\{[^}]*grid-template-columns:1fr 1fr[^}]*\}/);
    expect(html).toMatch(/\.variants\{[^}]*align-items:stretch[^}]*\}/);
    // The .cell must be a 3-row grid with the body row taking 1fr so the
    // rationale stays pinned to the bottom even when the cell is stretched
    // to match a taller paired cell.
    expect(html).toMatch(/\.cell\{[^}]*display:grid[^}]*\}/);
    expect(html).toMatch(/\.cell\{[^}]*grid-template-rows:auto 1fr auto[^}]*\}/);
    // Must NOT use any pixel-fixed height that would override the row stretch.
    expect(html).not.toMatch(/\.cell\{[^}]*height:\d+px/);
    expect(html).not.toMatch(/\.cell\{[^}]*max-height/);
  });

  it('uses just the short SHA when no ref label is recorded (legacy snapshots)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ef-view-'));
    mkdirSync(join(dir, 'legacy'), { recursive: true });
    writeFileSync(
      join(dir, 'legacy', 'snapshot.json'),
      JSON.stringify({
        schemaVersion: 1,
        name: 'legacy',
        createdAt: '',
        plugin: {
          path: '',
          baselineRef: '',
          baselineSha: 'aaaaaaa1111111111111111111111111111aaaa',
          currentRef: '',
          currentSha: 'bbbbbbb2222222222222222222222222222bbbb',
        },
        config: {},
        judge: { provider: 'ollama', model: 'q' },
        prompts: [],
        runs: [],
        judgments: [],
        summary: {
          baseline: { n: 0, mean: 0, median: 0, variance: 0 },
          current: { n: 0, mean: 0, median: 0, variance: 0 },
          delta: 0,
        },
      }),
    );
    const html = await viewCommand({ dir, name: 'legacy', writeHtml: true, open: false });
    expect(html).toContain('base <b>aaaaaaa</b>');
    expect(html).toContain('curr <b>bbbbbbb</b>');
  });
});

import { describe, it, expect } from 'vitest';
import { compareSnapshots, formatComparisonMarkdown } from '../src/compare.js';
import type { Snapshot, Judgment, RunResult, PromptSpec, Comparison } from '../src/types.js';

function mkJudgment(runId: string, score: number): Judgment {
  return {
    runId,
    score,
    rationale: 'x',
    rubricHash: 'h',
    judgeProvider: 'ollama',
    judgeModel: 'q',
    raw: '',
  };
}

function mkRun(
  id: string,
  promptId: string,
  variant: 'baseline' | 'current',
  sample: number,
): RunResult {
  return {
    id,
    promptId,
    variant,
    sample,
    output: '',
    durationMs: 1,
    exitCode: 0,
    error: null,
    usage: null,
  };
}

function mkSnap(
  name: string,
  perPromptBaseline: Record<string, number[]>,
  perPromptCurrent: Record<string, number[]>,
): Snapshot {
  const prompts: PromptSpec[] = Object.keys(perPromptBaseline).map((id) => ({
    id,
    prompt: 'x',
    rubric: 'r',
  }));
  const runs: RunResult[] = [];
  const judgments: Judgment[] = [];
  for (const pid of Object.keys(perPromptBaseline)) {
    perPromptBaseline[pid].forEach((s, i) => {
      const runId = `${pid}::baseline::${i + 1}`;
      runs.push(mkRun(runId, pid, 'baseline', i + 1));
      judgments.push(mkJudgment(runId, s));
    });
    perPromptCurrent[pid].forEach((s, i) => {
      const runId = `${pid}::current::${i + 1}`;
      runs.push(mkRun(runId, pid, 'current', i + 1));
      judgments.push(mkJudgment(runId, s));
    });
  }
  return {
    schemaVersion: 1,
    name,
    createdAt: '2026-04-23T00:00:00Z',
    plugin: { path: '/x', baselineRef: 'a', baselineSha: 'a', currentRef: 'b', currentSha: 'b' },
    config: {} as Snapshot['config'],
    judge: { provider: 'ollama', model: 'q' },
    prompts,
    runs,
    judgments,
    summary: {
      baseline: { n: 0, mean: 0, median: 0, variance: 0 },
      current: { n: 0, mean: 0, median: 0, variance: 0 },
      delta: 0,
    },
  };
}

describe('compareSnapshots', () => {
  it('computes per-prompt delta and categorizes verdicts', () => {
    const a = mkSnap('a', { p1: [3, 3], p2: [4, 4] }, { p1: [3, 3], p2: [4, 4] });
    const b = mkSnap('b', { p1: [3, 3], p2: [4, 4] }, { p1: [4, 4], p2: [4, 4] });
    const cmp = compareSnapshots(a, b);
    expect(cmp.from).toBe('a');
    expect(cmp.to).toBe('b');
    expect(cmp.perPrompt).toHaveLength(2);
    const p1 = cmp.perPrompt.find((d) => d.promptId === 'p1');
    expect(p1!.delta).toBeCloseTo(1.0);
    expect(p1!.verdict).toBe('improved');
    expect(cmp.improvements).toHaveLength(1);
    expect(cmp.regressions).toHaveLength(0);
    expect(cmp.netDelta).toBeCloseTo(0.5);
  });
});

describe('formatComparisonMarkdown', () => {
  it('renders table and section header', () => {
    const cmp: Comparison = {
      from: 'a',
      to: 'b',
      netDelta: 0.5,
      perPrompt: [
        { promptId: 'p1', baselineMean: 3, currentMean: 4, delta: 1, verdict: 'improved' },
        { promptId: 'p2', baselineMean: 4, currentMean: 4, delta: 0, verdict: 'stable' },
        { promptId: 'p3', baselineMean: 4, currentMean: 3.5, delta: -0.5, verdict: 'regressed' },
      ],
      improvements: [],
      stable: [],
      regressions: [],
    };
    const md = formatComparisonMarkdown(cmp);
    expect(md).toContain('# Benchmark comparison: `a` → `b`');
    expect(md).toContain('**Net delta:** +0.50');
    expect(md).toContain('| p1 |');
    expect(md).toMatch(/improved/);
    expect(md).toMatch(/regressed/);
    expect(md).toMatch(/stable/);
  });
});

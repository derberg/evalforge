import type {
  PromptSpec,
  Variant,
  Config,
  RunResult,
  Judgment,
  Snapshot,
  SummaryStats,
} from './types.js';
import { invokeClaude } from './provider.js';
import { judge, judgeConfigFromConfig, type JudgeConfig } from './judges/index.js';
import { hashRubric } from './judges/rubric.js';

export interface MatrixRow {
  id: string;
  promptId: string;
  prompt: string;
  rubric: string;
  variant: Variant;
  sample: number;
}

export function expandMatrix(prompts: PromptSpec[], samples: number): MatrixRow[] {
  const rows: MatrixRow[] = [];
  const variants: Variant[] = ['baseline', 'current'];
  for (const p of prompts) {
    for (const v of variants) {
      for (let s = 1; s <= samples; s++) {
        rows.push({
          id: `${p.id}::${v}::${s}`,
          promptId: p.id,
          prompt: p.prompt,
          rubric: p.rubric,
          variant: v,
          sample: s,
        });
      }
    }
  }
  return rows;
}

export interface RunBenchmarkOptions {
  config: Config;
  prompts: PromptSpec[];
  baselinePluginDir: string;
  currentPluginDir: string;
  baselineRef: string;
  baselineSha: string;
  currentRef: string;
  currentSha: string;
  name: string;
  resume?: Snapshot | null;
  onCheckpoint?: (partial: Snapshot) => Promise<void>;
  onProgress?: (ev: ProgressEvent) => void;
}

export type ProgressEvent =
  | { kind: 'run-start'; rowId: string }
  | { kind: 'run-end'; rowId: string; durationMs: number; error: string | null }
  | { kind: 'judge-start'; runId: string }
  | { kind: 'judge-end'; runId: string; score: number };

async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

function stats(xs: number[]): SummaryStats {
  if (xs.length === 0) return { n: 0, mean: 0, median: 0, variance: 0 };
  const sorted = [...xs].sort((a, b) => a - b);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
  return { n: xs.length, mean, median, variance };
}

function buildSnapshot(
  opts: RunBenchmarkOptions,
  runs: RunResult[],
  judgments: Judgment[],
  complete: boolean,
): Snapshot {
  const scoreOf = (runId: string): number =>
    judgments.find((j) => j.runId === runId)?.score ?? 0;
  const baselineScores = runs
    .filter((r) => r.variant === 'baseline')
    .map((r) => scoreOf(r.id));
  const currentScores = runs.filter((r) => r.variant === 'current').map((r) => scoreOf(r.id));
  const baseline = stats(baselineScores);
  const current = stats(currentScores);
  return {
    schemaVersion: 1,
    name: opts.name,
    createdAt: new Date().toISOString(),
    plugin: {
      path: opts.config.plugin.path,
      baselineRef: opts.baselineRef,
      baselineSha: opts.baselineSha,
      currentRef: opts.currentRef,
      currentSha: opts.currentSha,
    },
    config: opts.config,
    judge: { provider: opts.config.judge.provider, model: opts.config.judge.model },
    prompts: opts.prompts,
    runs,
    judgments,
    summary: { baseline, current, delta: current.mean - baseline.mean },
    complete,
  };
}

async function judgeRun(
  row: MatrixRow,
  run: RunResult,
  judgeCfg: JudgeConfig,
  onProgress: RunBenchmarkOptions['onProgress'],
): Promise<Judgment> {
  onProgress?.({ kind: 'judge-start', runId: row.id });
  let judgment: Judgment;
  if (run.error || run.output.length === 0) {
    judgment = {
      runId: run.id,
      score: 0,
      rationale: `run failed: ${run.error ?? 'empty output'}`,
      rubricHash: '',
      judgeProvider: judgeCfg.provider,
      judgeModel: judgeCfg.model,
      raw: '',
      error: 'run failed',
    };
  } else {
    try {
      const j = await judge(judgeCfg, {
        prompt: row.prompt,
        output: run.output,
        rubric: row.rubric,
      });
      judgment = { runId: run.id, ...j, error: null };
    } catch (e) {
      judgment = {
        runId: run.id,
        score: 0,
        rationale: `judge failed: ${(e as Error).message}`,
        rubricHash: hashRubric(row.rubric),
        judgeProvider: judgeCfg.provider,
        judgeModel: judgeCfg.model,
        raw: '',
        error: (e as Error).message,
      };
    }
  }
  onProgress?.({ kind: 'judge-end', runId: run.id, score: judgment.score });
  return judgment;
}

async function runAndJudge(
  row: MatrixRow,
  opts: RunBenchmarkOptions,
  judgeCfg: JudgeConfig,
): Promise<{ run: RunResult; judgment: Judgment }> {
  opts.onProgress?.({ kind: 'run-start', rowId: row.id });
  const pluginDir =
    row.variant === 'baseline' ? opts.baselinePluginDir : opts.currentPluginDir;
  const r = await invokeClaude({
    command: opts.config.provider.command,
    extraArgs: opts.config.provider.extraArgs,
    prompt: row.prompt,
    pluginDir,
    timeoutMs: opts.config.provider.timeout * 1000,
    model: opts.config.provider.model,
    allowedTools: opts.config.provider.allowedTools,
  });
  opts.onProgress?.({
    kind: 'run-end',
    rowId: row.id,
    durationMs: r.durationMs,
    error: r.error,
  });
  const run: RunResult = {
    id: row.id,
    promptId: row.promptId,
    variant: row.variant,
    sample: row.sample,
    output: r.output,
    durationMs: r.durationMs,
    exitCode: r.exitCode,
    error: r.error,
  };
  const judgment = await judgeRun(row, run, judgeCfg, opts.onProgress);
  return { run, judgment };
}

export async function runBenchmark(opts: RunBenchmarkOptions): Promise<Snapshot> {
  const matrix = expandMatrix(opts.prompts, opts.config.runs.samples);
  const judgeCfg = judgeConfigFromConfig(opts.config);

  const runs: RunResult[] = opts.resume?.runs ? [...opts.resume.runs] : [];
  const judgments: Judgment[] = opts.resume?.judgments ? [...opts.resume.judgments] : [];
  const runsById = new Map(runs.map((r) => [r.id, r]));
  const judgmentById = new Map(judgments.map((j) => [j.runId, j]));

  const fresh: MatrixRow[] = [];
  const rejudge: MatrixRow[] = [];
  for (const row of matrix) {
    const existingRun = runsById.get(row.id);
    const existingJudgment = judgmentById.get(row.id);
    if (!existingRun) {
      fresh.push(row);
    } else if (
      existingJudgment &&
      typeof existingJudgment.error === 'string' &&
      existingJudgment.error !== 'run failed' &&
      existingRun.error === null &&
      existingRun.output.length > 0
    ) {
      // Run succeeded, judge errored — retry only the judge.
      rejudge.push(row);
    }
    // else: row is fully done (or run itself failed) — skip.
  }

  // Serialize checkpoint writes so concurrent rows don't corrupt the file.
  let writeChain: Promise<void> = Promise.resolve();
  const checkpoint = async (): Promise<void> => {
    if (!opts.onCheckpoint) return;
    const snap = buildSnapshot(opts, runs, judgments, false);
    writeChain = writeChain.then(() => opts.onCheckpoint!(snap));
    await writeChain;
  };

  // Re-judge first: cheap, no Claude invocations.
  await mapWithConcurrency(rejudge, opts.config.runs.parallel, async (row) => {
    const cachedRun = runsById.get(row.id)!;
    const newJudgment = await judgeRun(row, cachedRun, judgeCfg, opts.onProgress);
    const idx = judgments.findIndex((j) => j.runId === row.id);
    if (idx >= 0) judgments[idx] = newJudgment;
    else judgments.push(newJudgment);
    await checkpoint();
  });

  await mapWithConcurrency(fresh, opts.config.runs.parallel, async (row) => {
    const { run, judgment } = await runAndJudge(row, opts, judgeCfg);
    runs.push(run);
    judgments.push(judgment);
    await checkpoint();
  });

  return buildSnapshot(opts, runs, judgments, true);
}

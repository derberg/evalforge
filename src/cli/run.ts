import { loadConfig } from '../config.js';
import { loadPrompts, filterPrompts } from '../prompts.js';
import { runBenchmark } from '../run.js';
import { saveSnapshot, loadSnapshot, pruneFailedRuns } from '../snapshot.js';
import { createWorktree, resolveSha } from '../swap.js';
import { compareSnapshots, formatComparisonMarkdown } from '../compare.js';
import { info, ok, warn, err, progress, step } from '../logger.js';
import { initDebug, noopDebug, type DebugLogger } from '../debug.js';
import type { Config, Snapshot, RunResult, Judgment } from '../types.js';

export interface RunOptions {
  cwd: string;
  plugin?: string;
  baseline?: string;
  baselineFrom?: string;
  current?: string;
  currentFrom?: string;
  prompts?: string;
  config?: string;
  samples?: number;
  only?: string[];
  judge?: string;
  saveAs?: string;
  compare?: string;
  failOnRegression?: number;
  force?: boolean;
  retryFailed?: boolean;
  rejudge?: boolean;
  dryRun?: boolean;
  debug?: boolean;
  verbose?: boolean;
}

function applyOverrides(cfg: Config, opts: RunOptions): Config {
  if (opts.samples) cfg.runs.samples = opts.samples;
  if (opts.judge) {
    const [provider, ...rest] = opts.judge.split(':');
    cfg.judge.provider = provider as Config['judge']['provider'];
    if (rest.length) cfg.judge.model = rest.join(':');
  }
  if (opts.plugin) {
    cfg.plugin.path = opts.plugin;
    cfg.plugin.gitRoot = opts.plugin;
  }
  return cfg;
}

export async function runCommand(opts: RunOptions): Promise<number> {
  if (opts.baselineFrom && opts.baseline) {
    err('--baseline-from and --baseline are mutually exclusive');
    return 1;
  }
  if (opts.currentFrom && opts.current) {
    err('--current-from and --current are mutually exclusive');
    return 1;
  }
  if (opts.retryFailed && opts.force) {
    err('--retry-failed and --force are mutually exclusive');
    return 1;
  }
  if (opts.rejudge && opts.force) {
    err('--rejudge and --force are mutually exclusive');
    return 1;
  }
  if (opts.rejudge && opts.retryFailed) {
    err('--rejudge and --retry-failed are mutually exclusive');
    return 1;
  }
  const configPath = opts.config ?? '.eval-bench/eval-bench.yaml';
  const promptsPath = opts.prompts ?? '.eval-bench/prompts.yaml';
  const cfg = applyOverrides(loadConfig(configPath), opts);
  const allPrompts = loadPrompts(promptsPath);
  const prompts = opts.only?.length ? filterPrompts(allPrompts, opts.only) : allPrompts;
  const gitRoot = cfg.plugin.gitRoot;
  const name = opts.saveAs ?? new Date().toISOString().replace(/[:.]/g, '-');
  const wantPromptIds = new Set(prompts.map((p) => p.id));

  let baselineRef: string;
  let baselineSha: string;
  let currentRef: string;
  let currentSha: string;
  let cachedBaseline: {
    runs: RunResult[];
    judgments: Judgment[];
    sourceName: string;
  } | null = null;
  let cachedCurrent: {
    runs: RunResult[];
    judgments: Judgment[];
    sourceName: string;
  } | null = null;

  if (opts.baselineFrom) {
    const cached = await loadSnapshot(cfg.snapshots.dir, opts.baselineFrom);
    baselineRef = cached.plugin.currentRef || cached.plugin.baselineRef;
    baselineSha = cached.plugin.currentSha || cached.plugin.baselineSha;
    // Pull successful current-variant runs within the requested sample budget,
    // restricted to the prompts we'll actually evaluate this run.
    const sourceRuns = cached.runs.filter(
      (r) =>
        r.variant === 'current' &&
        wantPromptIds.has(r.promptId) &&
        r.sample <= cfg.runs.samples &&
        r.error === null &&
        r.output.length > 0,
    );
    const sourceRunIds = new Set(sourceRuns.map((r) => r.id));
    const sourceJudgments = cached.judgments.filter((j) => sourceRunIds.has(j.runId));
    const idMap = new Map<string, string>();
    const runs: RunResult[] = sourceRuns.map((r) => {
      const newId = `${r.promptId}::baseline::${r.sample}`;
      idMap.set(r.id, newId);
      return { ...r, id: newId, variant: 'baseline' };
    });
    const judgments: Judgment[] = sourceJudgments.map((j) => ({
      ...j,
      runId: idMap.get(j.runId) ?? j.runId,
    }));
    cachedBaseline = { runs, judgments, sourceName: opts.baselineFrom };
  } else {
    baselineRef = opts.baseline ?? 'HEAD~1';
    baselineSha = await resolveSha(gitRoot, baselineRef);
  }

  if (opts.currentFrom) {
    const cached = await loadSnapshot(cfg.snapshots.dir, opts.currentFrom);
    currentRef = cached.plugin.currentRef || cached.plugin.baselineRef;
    currentSha = cached.plugin.currentSha || cached.plugin.baselineSha;
    // Same filter as baseline-from, but no variant remap: current-variant runs
    // stay current, and their IDs already match the format the new matrix
    // would generate (`${promptId}::current::${sample}`).
    const sourceRuns = cached.runs.filter(
      (r) =>
        r.variant === 'current' &&
        wantPromptIds.has(r.promptId) &&
        r.sample <= cfg.runs.samples &&
        r.error === null &&
        r.output.length > 0,
    );
    const sourceRunIds = new Set(sourceRuns.map((r) => r.id));
    const sourceJudgments = cached.judgments.filter((j) => sourceRunIds.has(j.runId));
    cachedCurrent = {
      runs: sourceRuns.map((r) => ({ ...r })),
      judgments: sourceJudgments.map((j) => ({ ...j })),
      sourceName: opts.currentFrom,
    };
  } else {
    currentRef = opts.current ?? 'HEAD';
    currentSha = await resolveSha(gitRoot, currentRef);
  }

  info(`Plugin:   ${cfg.plugin.path}`);
  if (opts.only?.length) {
    info(`Prompts:  ${prompts.length}/${allPrompts.length} (filtered: ${prompts.map((p) => p.id).join(', ')})`);
  }
  if (cachedBaseline) {
    info(
      `Baseline: ${baselineRef} (cached from snapshot "${cachedBaseline.sourceName}", sha=${baselineSha.slice(0, 8)}, ${cachedBaseline.runs.length} runs reused)`,
    );
  } else {
    info(`Baseline: ${baselineRef}`);
  }
  if (cachedCurrent) {
    info(
      `Current:  ${currentRef} (cached from snapshot "${cachedCurrent.sourceName}", sha=${currentSha.slice(0, 8)}, ${cachedCurrent.runs.length} runs reused)`,
    );
  } else {
    info(`Current:  ${currentRef}`);
  }
  info(`Judge:    ${cfg.judge.provider}/${cfg.judge.model}`);
  info(
    `Matrix:   ${prompts.length} prompts × ${cfg.runs.samples} samples × 2 variants = ${prompts.length * cfg.runs.samples * 2} runs`,
  );
  if (opts.dryRun) return 0;

  let resume: Snapshot | null = null;
  let existing: Snapshot | null = null;
  try {
    existing = await loadSnapshot(cfg.snapshots.dir, name);
  } catch {
    // no existing snapshot — fresh run
  }
  if (existing) {
    if (opts.retryFailed) {
      const pruned = pruneFailedRuns(existing);
      if (pruned.prunedRuns === 0 && pruned.prunedFailedJudgmentsOnly === 0) {
        info(`No failed runs or judgments to retry in snapshot "${name}" — nothing to do`);
        return 0;
      }
      resume = pruned.snap;
      const parts: string[] = [];
      if (pruned.prunedRuns > 0)
        parts.push(`${pruned.prunedRuns} failed run${pruned.prunedRuns === 1 ? '' : 's'}`);
      if (pruned.prunedFailedJudgmentsOnly > 0)
        parts.push(
          `${pruned.prunedFailedJudgmentsOnly} failed judgment${pruned.prunedFailedJudgmentsOnly === 1 ? '' : 's'}`,
        );
      info(
        `Retrying ${parts.join(' and ')} in snapshot "${name}" (${pruned.snap.runs.length} successful runs preserved)`,
      );
    } else if (opts.rejudge) {
      if (existing.runs.length === 0) {
        err(`Snapshot "${name}" has no cached runs to re-judge.`);
        return 1;
      }
      resume = { ...existing, judgments: [], complete: false };
      info(
        `Re-judging ${existing.runs.length} cached run${existing.runs.length === 1 ? '' : 's'} in snapshot "${name}" with ${cfg.judge.provider}/${cfg.judge.model}`,
      );
    } else if (existing.complete === false) {
      resume = existing;
      info(
        `Resuming from partial snapshot: ${existing.runs.length} runs, ${existing.judgments.length} judgments already done`,
      );
    } else if (!opts.force) {
      err(
        `Snapshot "${name}" already exists. Re-run with --force to overwrite, --retry-failed to re-run only failed rows, --rejudge to re-judge cached runs, or use a different --save-as name.`,
      );
      return 1;
    } else {
      warn(`Overwriting existing snapshot "${name}" (--force)`);
    }
  } else if (opts.retryFailed) {
    err(`No snapshot named "${name}" — nothing to retry.`);
    return 1;
  }

  if (cachedBaseline || cachedCurrent) {
    // Inject cached runs/judgments into the resume bag — runBenchmark dedups
    // by row ID, so they're skipped instead of re-executed. With --rejudge,
    // drop the source judgments so the dedup re-routes the rows through the
    // judge with the configured provider; the Claude outputs stay cached.
    const cachedRuns = [...(cachedBaseline?.runs ?? []), ...(cachedCurrent?.runs ?? [])];
    const cachedJudgments = opts.rejudge
      ? []
      : [...(cachedBaseline?.judgments ?? []), ...(cachedCurrent?.judgments ?? [])];
    if (resume) {
      // Only add cached runs whose IDs aren't already in resume — and pair
      // each fresh run with its cached judgment. We deliberately do NOT fill
      // judgment gaps for runs that were already in resume: those gaps were
      // intentional (--retry-failed pruning a bad judgment, or --rejudge
      // stripping all), and re-adding the cached judgment would silently
      // restore the very judgment we wanted to retry.
      const haveRunIds = new Set(resume.runs.map((r) => r.id));
      const newCachedRuns = cachedRuns.filter((r) => !haveRunIds.has(r.id));
      const newRunIds = new Set(newCachedRuns.map((r) => r.id));
      resume = {
        ...resume,
        runs: [...resume.runs, ...newCachedRuns],
        judgments: [
          ...resume.judgments,
          ...cachedJudgments.filter((j) => newRunIds.has(j.runId)),
        ],
      };
    } else {
      resume = {
        schemaVersion: 1,
        name,
        createdAt: new Date().toISOString(),
        plugin: {
          path: cfg.plugin.path,
          baselineRef,
          baselineSha,
          currentRef,
          currentSha,
        },
        config: cfg,
        judge: { provider: cfg.judge.provider, model: cfg.judge.model },
        prompts,
        runs: cachedRuns,
        judgments: cachedJudgments,
        summary: {
          baseline: { n: 0, mean: 0, median: 0, variance: 0 },
          current: { n: 0, mean: 0, median: 0, variance: 0 },
          delta: 0,
        },
        complete: false,
      };
    }
  }

  const baselineWt = cachedBaseline ? null : await createWorktree(gitRoot, baselineRef);

  let debug: DebugLogger = noopDebug();
  if (opts.debug) {
    try {
      debug = await initDebug({ snapshotDir: cfg.snapshots.dir, name });
      info(`Debug log: ${debug.logFile}`);
      debug.event('config-loaded', {
        configPath,
        promptsPath,
        judgeProvider: cfg.judge.provider,
        judgeModel: cfg.judge.model,
        judgeMaxTokens: cfg.judge.maxTokens,
        judgeTemperature: cfg.judge.temperature,
        runsParallel: cfg.runs.parallel,
        runsSamples: cfg.runs.samples,
      });
      debug.event('prompts-loaded', {
        path: promptsPath,
        count: prompts.length,
        ids: prompts.map((p) => p.id),
      });
      if (resume) {
        debug.event('resume-loaded', {
          name,
          runsKept: resume.runs.length,
          judgmentsKept: resume.judgments.length,
        });
      }
    } catch (e) {
      warn(`Could not initialize debug log: ${(e as Error).message}`);
      debug = noopDebug();
    }
  }

  try {
    let total = prompts.length * cfg.runs.samples * 2;
    let runIdx = resume?.runs.length ?? 0;
    const runDurations = new Map<string, number>();
    const snap = await runBenchmark({
      config: cfg,
      prompts,
      baselinePluginDir: baselineWt?.path ?? '',
      currentPluginDir: cachedCurrent ? '' : gitRoot,
      baselineRef,
      baselineSha,
      currentRef,
      currentSha,
      name,
      resume,
      debug,
      onCheckpoint: async (partial) => {
        await saveSnapshot(partial, cfg.snapshots.dir);
      },
      onProgress: (ev) => {
        // Reframe the progress denominator around the work this invocation
        // actually has to do (fresh runs + judge retries), so resumes don't
        // print misleading [N+1/N] lines.
        if (ev.kind === 'matrix-built') {
          total = ev.freshRows + ev.reJudgeRows;
          runIdx = 0;
        } else if (ev.kind === 'run-start') {
          step(runIdx + 1, total, ev.rowId, 'running claude…');
        } else if (ev.kind === 'judge-start') {
          step(runIdx + 1, total, ev.runId, 'judging…');
        } else if (ev.kind === 'run-end') {
          // Stash the run leg duration; `judge-end` always fires next (even
          // for failed runs, where the judgment's error is set to 'run
          // failed') and is the single terminal signal that prints status
          // and increments the counter. This ensures the printed status
          // reflects the full row outcome (run + judge) without double-
          // counting.
          runDurations.set(ev.rowId, ev.durationMs);
        } else if (ev.kind === 'judge-end') {
          runIdx++;
          const status = ev.error ? 'FAIL' : 'OK';
          const runLeg = runDurations.get(ev.runId) ?? 0;
          runDurations.delete(ev.runId);
          progress(runIdx, total, ev.runId, status, runLeg + ev.durationMs);
        }
      },
    });
    const path = await saveSnapshot(snap, cfg.snapshots.dir);
    debug.event('snapshot-saved', {
      path,
      runs: snap.runs.length,
      judgments: snap.judgments.length,
      complete: true,
    });
    ok(`Snapshot saved: ${path}`);
    info(`  baseline mean ${snap.summary.baseline.mean.toFixed(2)} (n=${snap.summary.baseline.n})`);
    info(`  current  mean ${snap.summary.current.mean.toFixed(2)} (n=${snap.summary.current.n})`);
    info(`  delta    ${snap.summary.delta >= 0 ? '+' : ''}${snap.summary.delta.toFixed(2)}`);
    const failedJudgments = snap.judgments.filter((j) => j.error !== null);
    const allJudgmentsFailed =
      snap.judgments.length > 0 && failedJudgments.length === snap.judgments.length;
    if (failedJudgments.length > 0) {
      const sample = failedJudgments[0].error ?? 'unknown';
      warn(
        `${failedJudgments.length}/${snap.judgments.length} judgments failed — first error: ${sample}`,
      );
    }
    if (snap.summary.tokens) {
      const t = snap.summary.tokens;
      const fmtTok = (n: number): string => n.toLocaleString('en-US');
      const fmtCost = (n: number): string => `$${n.toFixed(4)}`;
      const sign = t.costDelta >= 0 ? '+' : '';
      info(
        `  baseline tokens in/out ${fmtTok(t.baseline.inputTokens)}/${fmtTok(t.baseline.outputTokens)} cache_read ${fmtTok(t.baseline.cacheReadInputTokens)} cache_create ${fmtTok(t.baseline.cacheCreationInputTokens)} cost ${fmtCost(t.baseline.totalCostUsd)} (n=${t.baseline.reportedRuns})`,
      );
      info(
        `  current  tokens in/out ${fmtTok(t.current.inputTokens)}/${fmtTok(t.current.outputTokens)} cache_read ${fmtTok(t.current.cacheReadInputTokens)} cache_create ${fmtTok(t.current.cacheCreationInputTokens)} cost ${fmtCost(t.current.totalCostUsd)} (n=${t.current.reportedRuns})`,
      );
      info(`  cost Δ   ${sign}${fmtCost(t.costDelta)}`);
    }
    if (opts.compare) {
      const base = await loadSnapshot(cfg.snapshots.dir, opts.compare);
      const cmp = compareSnapshots(base, snap);
      info('');
      info(formatComparisonMarkdown(cmp));
      if (opts.failOnRegression !== undefined && cmp.netDelta < -opts.failOnRegression) {
        err(`Regression exceeds threshold (${cmp.netDelta.toFixed(2)} < -${opts.failOnRegression})`);
        return 1;
      }
    }
    if (allJudgmentsFailed) {
      err(`All ${snap.judgments.length} judgments failed — snapshot has no usable scores.`);
      return 1;
    }
    return 0;
  } finally {
    if (baselineWt) await baselineWt.cleanup();
    await debug.close();
  }
}

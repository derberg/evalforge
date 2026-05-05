import { loadConfig } from '../config.js';
import { loadPrompts, filterPrompts } from '../prompts.js';
import { runBenchmark } from '../run.js';
import { saveSnapshot, loadSnapshot, pruneFailedRuns } from '../snapshot.js';
import { resolveSha } from '../swap.js';
import { info, ok, warn, err, progress, step } from '../logger.js';
import { initDebug, noopDebug, type DebugLogger } from '../debug.js';
import type { Config, Snapshot } from '../types.js';

export interface EvalOptions {
  cwd: string;
  plugin?: string;
  ref?: string;
  prompts?: string;
  config?: string;
  judge?: string;
  saveAs: string;
  force?: boolean;
  retryFailed?: boolean;
  only?: string[];
  dryRun?: boolean;
  debug?: boolean;
}

function applyOverrides(cfg: Config, opts: EvalOptions): Config {
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

export async function evalCommand(opts: EvalOptions): Promise<number> {
  if (opts.retryFailed && opts.force) {
    err('--retry-failed and --force are mutually exclusive');
    return 1;
  }
  const configPath = opts.config ?? '.eval-bench/eval-bench.yaml';
  const promptsPath = opts.prompts ?? '.eval-bench/prompts.yaml';
  const cfg = applyOverrides(loadConfig(configPath), opts);
  const allPrompts = loadPrompts(promptsPath);
  const prompts = opts.only?.length ? filterPrompts(allPrompts, opts.only) : allPrompts;
  const gitRoot = cfg.plugin.gitRoot;
  const ref = opts.ref ?? 'HEAD';
  const name = opts.saveAs;

  info(`Plugin:   ${cfg.plugin.path}`);
  if (opts.only?.length) {
    info(`Prompts:  ${prompts.length}/${allPrompts.length} (filtered: ${prompts.map((p) => p.id).join(', ')})`);
  }
  info(`Ref:      ${ref}`);
  info(`Judge:    ${cfg.judge.provider}/${cfg.judge.model}`);
  info(`Matrix:   ${prompts.length} prompts × ${cfg.runs.samples} samples = ${prompts.length * cfg.runs.samples} runs`);
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
      if (pruned.prunedRuns === 0) {
        info(`No failed runs to retry in snapshot "${name}" — nothing to do`);
        return 0;
      }
      resume = pruned.snap;
      info(
        `Retrying ${pruned.prunedRuns} failed run${pruned.prunedRuns === 1 ? '' : 's'} in snapshot "${name}" (${pruned.snap.runs.length} successful runs preserved)`,
      );
    } else if (existing.complete === false) {
      resume = existing;
      info(
        `Resuming from partial snapshot: ${existing.runs.length} runs, ${existing.judgments.length} judgments already done`,
      );
    } else if (!opts.force) {
      err(
        `Snapshot "${name}" already exists. Re-run with --force to overwrite, --retry-failed to re-run only failed rows, or use a different --save-as name.`,
      );
      return 1;
    } else {
      warn(`Overwriting existing snapshot "${name}" (--force)`);
    }
  } else if (opts.retryFailed) {
    err(`No snapshot named "${name}" — nothing to retry.`);
    return 1;
  }

  const sha = await resolveSha(gitRoot, ref);
  let total = prompts.length * cfg.runs.samples;
  let runIdx = resume?.runs.length ?? 0;
  const runDurations = new Map<string, number>();

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
    const snap = await runBenchmark({
      config: cfg,
      prompts,
      baselinePluginDir: '',
      currentPluginDir: gitRoot,
      baselineRef: '',
      baselineSha: '',
      currentRef: ref,
      currentSha: sha,
      name,
      variants: ['current'],
      resume,
      debug,
      onCheckpoint: async (partial) => {
        await saveSnapshot(partial, cfg.snapshots.dir);
      },
      onProgress: (ev) => {
        // See cli/run.ts for the rationale: align the displayed denominator
        // with what this invocation actually has to do.
        if (ev.kind === 'matrix-built') {
          total = ev.freshRows + ev.reJudgeRows;
          runIdx = 0;
        } else if (ev.kind === 'run-start') {
          step(runIdx + 1, total, ev.rowId, 'running claude…');
        } else if (ev.kind === 'judge-start') {
          step(runIdx + 1, total, ev.runId, 'judging…');
        } else if (ev.kind === 'run-end') {
          // See cli/run.ts — judge-end is the single terminal signal. The
          // run leg duration is stashed here and combined with the judge
          // leg so the printed time reflects the full row wall-clock.
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
    info(`  mean ${snap.summary.current.mean.toFixed(2)} (n=${snap.summary.current.n})`);
    if (snap.summary.tokens) {
      const t = snap.summary.tokens.current;
      const fmtTok = (n: number): string => n.toLocaleString('en-US');
      info(
        `  tokens in/out ${fmtTok(t.inputTokens)}/${fmtTok(t.outputTokens)} cache_read ${fmtTok(t.cacheReadInputTokens)} cache_create ${fmtTok(t.cacheCreationInputTokens)} cost $${t.totalCostUsd.toFixed(4)} (n=${t.reportedRuns})`,
      );
    }
    const failedJudgments = snap.judgments.filter((j) => j.error !== null);
    if (failedJudgments.length > 0) {
      const sample = failedJudgments[0].error ?? 'unknown';
      warn(
        `${failedJudgments.length}/${snap.judgments.length} judgments failed — first error: ${sample}`,
      );
    }
    if (snap.judgments.length > 0 && failedJudgments.length === snap.judgments.length) {
      err(`All ${snap.judgments.length} judgments failed — snapshot has no usable scores.`);
      return 1;
    }
    return 0;
  } finally {
    await debug.close();
  }
}

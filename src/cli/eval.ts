import { loadConfig } from '../config.js';
import { loadPrompts, filterPrompts } from '../prompts.js';
import { runBenchmark } from '../run.js';
import { saveSnapshot, loadSnapshot, pruneFailedRuns } from '../snapshot.js';
import { resolveSha } from '../swap.js';
import { info, ok, warn, err, progress, step } from '../logger.js';
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
  const total = prompts.length * cfg.runs.samples;
  let runIdx = resume?.runs.length ?? 0;
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
    onCheckpoint: async (partial) => {
      await saveSnapshot(partial, cfg.snapshots.dir);
    },
    onProgress: (ev) => {
      if (ev.kind === 'run-start') {
        step(runIdx + 1, total, ev.rowId, 'running claude…');
      } else if (ev.kind === 'judge-start') {
        step(runIdx + 1, total, ev.runId, 'judging…');
      } else if (ev.kind === 'run-end') {
        runIdx++;
        const status = ev.error ? 'FAIL' : 'OK';
        progress(runIdx, total, ev.rowId, status, ev.durationMs);
      }
    },
  });
  const path = await saveSnapshot(snap, cfg.snapshots.dir);
  ok(`Snapshot saved: ${path}`);
  info(`  mean ${snap.summary.current.mean.toFixed(2)} (n=${snap.summary.current.n})`);
  if (snap.summary.tokens) {
    const t = snap.summary.tokens.current;
    const fmtTok = (n: number): string => n.toLocaleString('en-US');
    info(
      `  tokens in/out ${fmtTok(t.inputTokens)}/${fmtTok(t.outputTokens)} cache_read ${fmtTok(t.cacheReadInputTokens)} cache_create ${fmtTok(t.cacheCreationInputTokens)} cost $${t.totalCostUsd.toFixed(4)} (n=${t.reportedRuns})`,
    );
  }
  return 0;
}

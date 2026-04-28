import { loadConfig } from '../config.js';
import { loadPrompts } from '../prompts.js';
import { runBenchmark } from '../run.js';
import { saveSnapshot, loadSnapshot } from '../snapshot.js';
import { createWorktree, resolveSha } from '../swap.js';
import { compareSnapshots, formatComparisonMarkdown } from '../compare.js';
import { info, ok, warn, err, progress } from '../logger.js';
import type { Config, Snapshot } from '../types.js';

export interface RunOptions {
  cwd: string;
  plugin?: string;
  baseline?: string;
  current?: string;
  prompts?: string;
  config?: string;
  samples?: number;
  judge?: string;
  saveAs?: string;
  compare?: string;
  failOnRegression?: number;
  dryRun?: boolean;
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
  const configPath = opts.config ?? '.eval-bench/eval-bench.yaml';
  const promptsPath = opts.prompts ?? '.eval-bench/prompts.yaml';
  const cfg = applyOverrides(loadConfig(configPath), opts);
  const prompts = loadPrompts(promptsPath);
  const gitRoot = cfg.plugin.gitRoot;
  const baselineRef = opts.baseline ?? 'HEAD~1';
  const currentRef = opts.current ?? 'HEAD';
  const name = opts.saveAs ?? new Date().toISOString().replace(/[:.]/g, '-');

  info(`Plugin:   ${cfg.plugin.path}`);
  info(`Baseline: ${baselineRef}`);
  info(`Current:  ${currentRef}`);
  info(`Judge:    ${cfg.judge.provider}/${cfg.judge.model}`);
  info(
    `Matrix:   ${prompts.length} prompts × ${cfg.runs.samples} samples × 2 variants = ${prompts.length * cfg.runs.samples * 2} runs`,
  );
  if (opts.dryRun) return 0;

  const baselineSha = await resolveSha(gitRoot, baselineRef);
  const currentSha = await resolveSha(gitRoot, currentRef);

  let resume: Snapshot | null = null;
  try {
    const existing = await loadSnapshot(cfg.snapshots.dir, name);
    if (existing.complete === false) {
      resume = existing;
      info(
        `Resuming from partial snapshot: ${existing.runs.length} runs, ${existing.judgments.length} judgments already done`,
      );
    } else {
      warn(`Snapshot "${name}" already exists and is complete; will overwrite`);
    }
  } catch {
    // no existing snapshot — fresh run
  }

  const baselineWt = await createWorktree(gitRoot, baselineRef);

  try {
    const total = prompts.length * cfg.runs.samples * 2;
    let runIdx = resume?.runs.length ?? 0;
    const snap = await runBenchmark({
      config: cfg,
      prompts,
      baselinePluginDir: baselineWt.path,
      currentPluginDir: gitRoot,
      baselineRef,
      baselineSha,
      currentRef,
      currentSha,
      name,
      resume,
      onCheckpoint: async (partial) => {
        await saveSnapshot(partial, cfg.snapshots.dir);
      },
      onProgress: (ev) => {
        if (ev.kind === 'run-end') {
          runIdx++;
          const status = ev.error ? 'FAIL' : 'OK';
          progress(runIdx, total, ev.rowId, status, ev.durationMs);
        }
      },
    });
    const path = await saveSnapshot(snap, cfg.snapshots.dir);
    ok(`Snapshot saved: ${path}`);
    info(`  baseline mean ${snap.summary.baseline.mean.toFixed(2)} (n=${snap.summary.baseline.n})`);
    info(`  current  mean ${snap.summary.current.mean.toFixed(2)} (n=${snap.summary.current.n})`);
    info(`  delta    ${snap.summary.delta >= 0 ? '+' : ''}${snap.summary.delta.toFixed(2)}`);
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
    return 0;
  } finally {
    await baselineWt.cleanup();
  }
}

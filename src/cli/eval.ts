import { loadConfig } from '../config.js';
import { loadPrompts, filterPrompts } from '../prompts.js';
import { runBenchmark } from '../run.js';
import { saveSnapshot, loadSnapshot } from '../snapshot.js';
import { resolveSha } from '../swap.js';
import { info, ok, warn, err, progress } from '../logger.js';
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
  try {
    const existing = await loadSnapshot(cfg.snapshots.dir, name);
    if (existing.complete === false) {
      resume = existing;
      info(
        `Resuming from partial snapshot: ${existing.runs.length} runs, ${existing.judgments.length} judgments already done`,
      );
    } else if (!opts.force) {
      err(`Snapshot "${name}" already exists. Re-run with --force to overwrite.`);
      return 1;
    } else {
      warn(`Overwriting existing snapshot "${name}" (--force)`);
    }
  } catch {
    // no existing snapshot — fresh run
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
      if (ev.kind === 'run-end') {
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

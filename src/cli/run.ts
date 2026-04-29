import { loadConfig } from '../config.js';
import { loadPrompts, filterPrompts } from '../prompts.js';
import { runBenchmark } from '../run.js';
import { saveSnapshot, loadSnapshot } from '../snapshot.js';
import { createWorktree, resolveSha } from '../swap.js';
import { compareSnapshots, formatComparisonMarkdown } from '../compare.js';
import { info, ok, warn, err, progress } from '../logger.js';
import type { Config, Snapshot, RunResult, Judgment } from '../types.js';

export interface RunOptions {
  cwd: string;
  plugin?: string;
  baseline?: string;
  baselineFrom?: string;
  current?: string;
  prompts?: string;
  config?: string;
  samples?: number;
  only?: string[];
  judge?: string;
  saveAs?: string;
  compare?: string;
  failOnRegression?: number;
  force?: boolean;
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
  if (opts.baselineFrom && opts.baseline) {
    err('--baseline-from and --baseline are mutually exclusive');
    return 1;
  }
  const configPath = opts.config ?? '.eval-bench/eval-bench.yaml';
  const promptsPath = opts.prompts ?? '.eval-bench/prompts.yaml';
  const cfg = applyOverrides(loadConfig(configPath), opts);
  const allPrompts = loadPrompts(promptsPath);
  const prompts = opts.only?.length ? filterPrompts(allPrompts, opts.only) : allPrompts;
  const gitRoot = cfg.plugin.gitRoot;
  const currentRef = opts.current ?? 'HEAD';
  const name = opts.saveAs ?? new Date().toISOString().replace(/[:.]/g, '-');

  let baselineRef: string;
  let baselineSha: string;
  let cachedBaseline: {
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
    const wantPromptIds = new Set(prompts.map((p) => p.id));
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
  const currentSha = await resolveSha(gitRoot, currentRef);

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
  info(`Current:  ${currentRef}`);
  info(`Judge:    ${cfg.judge.provider}/${cfg.judge.model}`);
  info(
    `Matrix:   ${prompts.length} prompts × ${cfg.runs.samples} samples × 2 variants = ${prompts.length * cfg.runs.samples * 2} runs`,
  );
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
      err(
        `Snapshot "${name}" already exists. Re-run with --force to overwrite, or use a different --save-as name. To retry failed rows from a complete snapshot, delete it first: eb snapshot rm ${name}`,
      );
      return 1;
    } else {
      warn(`Overwriting existing snapshot "${name}" (--force)`);
    }
  } catch {
    // no existing snapshot — fresh run
  }

  if (cachedBaseline) {
    // Inject cached baseline runs/judgments into the resume bag — runBenchmark
    // dedups by row ID, so they're skipped instead of re-executed.
    if (resume) {
      const haveRunIds = new Set(resume.runs.map((r) => r.id));
      const haveJudgmentRunIds = new Set(resume.judgments.map((j) => j.runId));
      resume = {
        ...resume,
        runs: [...resume.runs, ...cachedBaseline.runs.filter((r) => !haveRunIds.has(r.id))],
        judgments: [
          ...resume.judgments,
          ...cachedBaseline.judgments.filter((j) => !haveJudgmentRunIds.has(j.runId)),
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
        runs: cachedBaseline.runs,
        judgments: cachedBaseline.judgments,
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

  try {
    const total = prompts.length * cfg.runs.samples * 2;
    let runIdx = resume?.runs.length ?? 0;
    const snap = await runBenchmark({
      config: cfg,
      prompts,
      baselinePluginDir: baselineWt?.path ?? '',
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
    return 0;
  } finally {
    if (baselineWt) await baselineWt.cleanup();
  }
}

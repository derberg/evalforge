import { mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Snapshot } from './types.js';

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;

function validateName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(`invalid snapshot name: ${name} (must match ${NAME_RE})`);
  }
}

export async function saveSnapshot(snap: Snapshot, dir: string): Promise<string> {
  validateName(snap.name);
  const target = join(dir, snap.name);
  await mkdir(target, { recursive: true });
  const path = join(target, 'snapshot.json');
  await writeFile(path, JSON.stringify(snap, null, 2));
  return path;
}

export async function loadSnapshot(dir: string, name: string): Promise<Snapshot> {
  validateName(name);
  const path = join(dir, name, 'snapshot.json');
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw) as Snapshot;
}

export async function listSnapshots(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && NAME_RE.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

// Drop runs whose underlying call failed (plus their judgments) so the resume
// path can re-execute exactly those rows. Other judge-only failures are left
// alone — runBenchmark already retries those automatically on resume.
export function pruneFailedRuns(snap: Snapshot): {
  snap: Snapshot;
  prunedRuns: number;
  prunedJudgments: number;
  prunedFailedJudgmentsOnly: number;
} {
  const failedRunIds = new Set(snap.runs.filter((r) => r.error !== null).map((r) => r.id));
  // Also drop genuine judge failures (run succeeded, judgment errored with a
  // real judge error like a parse failure or 5xx). The matrix dedup will
  // re-judge those rows on resume without re-invoking Claude. 'run failed'
  // judgments are tied to runs we already prune above, so exclude them.
  const judgeOnlyFailureRunIds = new Set(
    snap.judgments
      .filter(
        (j) => j.error !== null && j.error !== 'run failed' && !failedRunIds.has(j.runId),
      )
      .map((j) => j.runId),
  );
  if (failedRunIds.size === 0 && judgeOnlyFailureRunIds.size === 0) {
    return { snap, prunedRuns: 0, prunedJudgments: 0, prunedFailedJudgmentsOnly: 0 };
  }
  const dropJudgmentRunIds = new Set([...failedRunIds, ...judgeOnlyFailureRunIds]);
  const keptRuns = snap.runs.filter((r) => !failedRunIds.has(r.id));
  const keptJudgments = snap.judgments.filter((j) => !dropJudgmentRunIds.has(j.runId));
  return {
    snap: { ...snap, runs: keptRuns, judgments: keptJudgments, complete: false },
    prunedRuns: snap.runs.length - keptRuns.length,
    prunedJudgments: snap.judgments.length - keptJudgments.length,
    prunedFailedJudgmentsOnly: judgeOnlyFailureRunIds.size,
  };
}

export async function removeSnapshot(dir: string, name: string): Promise<void> {
  validateName(name);
  const target = resolve(dir, name);
  if (!target.startsWith(resolve(dir))) {
    throw new Error('refusing to remove outside snapshots dir');
  }
  await rm(target, { recursive: true, force: true });
}

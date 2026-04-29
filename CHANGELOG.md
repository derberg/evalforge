# Changelog

All notable changes to this project will be documented in this file.

## 0.5.3 — 2026-04-29

**Fixes:**

- **Live progress logging.** `eb run` and `eb eval` previously logged only on row completion (`run-end`), so a 4-row retry-failed against a slow judge (e.g. `qwen2.5:72b-instruct-q4_0`) sat silent for many minutes between "Retrying N failed runs…" and the first "OK" line. Now also logs `running claude…` on `run-start` and `judging…` on `judge-start`, so you see exactly which row is in flight and what phase it's in. Same data, no behavior change — just stops the run from looking frozen when the judge is slow.

## 0.5.2 — 2026-04-29

**Features:**

- **`--retry-failed` on `eb run` and `eb eval`.** Re-runs only the rows whose underlying Claude call errored in an existing snapshot (`run.error !== null`); successful rows are kept verbatim. Resolves the "I lost a few runs to a judge timeout yesterday — how do I top up without redoing all 30?" case. Mutually exclusive with `--force`. Errors clearly if the snapshot doesn't exist or has no failures (the latter short-circuits with exit 0).

**Internals:**

- `pruneFailedRuns(snap)` exported from `src/snapshot.ts` — drops failed runs and their judgments, sets `complete: false`, returns counts. The CLI feeds the result to the existing resume path, which already knows how to re-execute the now-missing rows.

## 0.5.1 — 2026-04-29

**Fixes:**

- **`eb run` no longer silently overwrites a complete snapshot.** Previously it warned ("Snapshot 'X' already exists and is complete; will overwrite") and ran the full matrix from scratch, draining tokens and clobbering an existing snapshot in place via the incremental writes. Now it errors out and tells you to pass `--force`, use a different `--save-as` name, or `eb snapshot rm <name>` to retry failed rows. `eb eval` already had this behavior; the asymmetry is gone.
- New `--force` flag on `eb run` for the explicit-overwrite case.

## 0.5.0 — 2026-04-29

**Features:**

- **`eb eval` — single-variant snapshots.** Runs the eval matrix at one git ref and saves a snapshot. Use it to freeze a reference point ("baseline") without paying for a redundant second variant. Refuses to overwrite a complete snapshot of the same name unless `--force` is passed; the error message tells you which flag to add. `--ref` defaults to `HEAD`. Samples come from your config (no override).
- **`eb run --baseline-from <snapshot>`.** Reuses the runs and judgments from a saved snapshot for the baseline side instead of re-executing the baseline ref. Re-labels the cached snapshot's `current`-variant rows as `baseline`-variant in the new snapshot, then only the current ref actually runs. Logs `Baseline: <ref> (cached from snapshot "<name>", sha=<sha>, <N> runs reused)` on hit. Mutually exclusive with `--baseline <ref>`; passing both is a hard error.
- **`--only <ids>` on `eb run` and `eb eval`.** Restrict the matrix to a subset of prompts by id. Comma-separated and repeatable (`--only p1,p2 --only p3`). Unknown ids fail loudly. With `--baseline-from`, cached baseline runs are filtered to the same prompt set so the saved snapshot stays internally consistent.

**Workflow shift:**

- Iteration loop is now `eb eval` once → `eb run --baseline-from <name>` per change. The original two-ref `eb run --baseline <ref> --current <ref>` is still the right shape for one-shot comparisons (e.g. CI gating two refs in one command).

**Schema:**

- No schema bump. Single-variant snapshots reuse the existing schema with `summary.baseline.n === 0` and empty `plugin.baselineRef`/`baselineSha`. Old readers (compare, view) keep working unchanged.

## 0.4.0 — 2026-04-28

**Features:**

- **Per-run token & cost tracking** — `eb run` now captures `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, and `total_cost_usd` for every Claude invocation by auto-injecting `--output-format json`. Each `RunResult` carries a `usage` block, and `Snapshot.summary.tokens` aggregates baseline vs current totals plus a `costDelta` so you can see how much a plugin/skill change costs in tokens, not just in scores.
- **Token totals in run summary & HTML view** — The end-of-run summary prints baseline/current input·output·cache·cost lines and a `cost Δ`. The `eb view` HTML shows per-cell `in / out / $cost` under each score and a totals line in the header.

**Schema:**

- `RunResult.usage: RunUsage | null` — populated when the provider returns a Claude `--output-format json` envelope; `null` for custom commands or older transcripts. New `RunUsage` interface exported from `types.ts`.
- `Snapshot.summary.tokens?: { baseline: TokenTotals; current: TokenTotals; costDelta: number }` — absent when no run reported usage (e.g. all runs used a non-Claude provider). Old snapshots load unchanged.

**Compatibility:**

- If `provider.extraArgs` already specifies `--output-format`, the user's choice is respected and usage capture is skipped for that run.
- Non-JSON stdout falls back to the previous behavior (raw stdout becomes `output`, `usage` is `null`) — custom provider commands keep working.

## 0.3.0 — 2026-04-28

**Features:**

- **Incremental snapshots & resume** — `eb run` now writes the snapshot to disk after every prompt × judge pair instead of only at the end. If the process crashes mid-run (judge timeout, ^C, OOM), all completed work is preserved. Re-running `eb run --save-as <name>` with the same name picks up where it left off; finished rows are skipped.
- **Judge errors no longer kill the batch** — A throwing judge for one prompt used to abort the whole run via `Promise.all` and lose every prior result. Now the failure is caught, recorded as `score: 0` with `rationale: "judge failed: ..."`, and the rest of the matrix continues.
- **Smart resume retries failed judgments only** — On resume, rows whose Claude run succeeded but whose judge errored are re-judged using the cached run output (cheap, no Claude re-invocation). Successful rows are skipped; rows where the Claude run itself failed are also skipped (re-running is expensive and likely to fail again — delete the snapshot to force a full retry).

**Schema:**

- `Snapshot.complete?: boolean` — `false` while a run is in progress, `true` once finished. Absent on legacy snapshots, treated as complete when loading.
- `Judgment.error: string | null` — `null` on success, error message when the judge threw, or `"run failed"` when the underlying Claude run produced no output. Used by resume to classify retry behavior.

## 0.2.3 — 2026-04-28

**Fixes:**

- `eb --version` now reports the correct version. Previously hardcoded in `src/index.ts` and went stale on 0.2.1 / 0.2.2 — now derived from `package.json` at runtime so it can never drift.

**Internal:**

- ESLint migrated to v9 flat config (`eslint.config.js`); `npm run lint` actually runs again.
- `tsconfig.json` pins `"types": ["node"]` so the IDE's TS server reliably loads node type definitions.

## 0.2.1 — 2026-04-28

**Fixes:**

- `eb run` no longer fails with `ENOENT: no such file or directory, open './eval-bench.yaml'` when invoked from a project root that has the scaffolded `.eval-bench/` directory. The `--config` and `--prompts` defaults now point at `./.eval-bench/eval-bench.yaml` and `./.eval-bench/prompts.yaml` to match what `eb init` writes.

**Docs:**

- README quickstart commands annotated with what each step does and where its output lands.

## 0.2.0 — 2026-04-27

**Features:**

- **Standalone skill/agent support** — No need for `.claude-plugin/plugin.json` anymore. If you only have `skills/` or `agents/` directories, eval-bench automatically creates a temporary minimal plugin manifest during benchmark runs. This makes it easier to evaluate single skills or agents without full plugin boilerplate.

## 0.1.0 — 2026-04-27

Initial release of **eval-bench** - A CLI tool for benchmarking Claude Code plugins, skills, agents, and MCPs using A/B testing with LLM judging.

**Features:**

- `ef init` — scaffold `eval-bench.yaml`, `prompts.yaml`, `snapshots/`, and optional GitHub Actions workflow
- `ef run` — benchmark plugin by running each prompt × sample × variant via `claude -p`, judged by Ollama / Anthropic / OpenAI / OpenAI-compatible
- `ef snapshot list | show | rm` — manage stored snapshots
- `ef compare` — diff two snapshots, emit markdown or JSON
- `ef view` — render an HTML report for a snapshot
- Plugin-version swap via `git worktree`
- Docs: quickstart, concepts, config, rubrics, judges, CI, troubleshooting, promptfoo-comparison

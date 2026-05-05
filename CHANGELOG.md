# Changelog

All notable changes to this project will be documented in this file.

## 0.11.3 — 2026-05-05

**Fixes:**

- **`--retry-failed` (or `--rejudge`) combined with `--baseline-from`/`--current-from` now actually re-judges, instead of silently refilling pruned slots from cache.** When `--retry-failed` pruned a bad judgment, the subsequent `--baseline-from`/`--current-from` merge filled the gap with the cached judgment (which used the *old* judge), so the matrix dedup saw a complete row and skipped it: no `judging…` printed, the user saw "Retrying 1 failed judgment" but no actual judge work happened, and the snapshot ended up with one row scored by the old judge while the rest were scored by the new one. The merge now only adds cached judgments for runs being *newly* added in this merge step, never to fill gaps in runs that were already in resume — those gaps are intentional (the very thing `--retry-failed`/`--rejudge` exists to retry). Same logic also closes the analogous hole for `--rejudge` interactions in case someone wires up both.

## 0.11.2 — 2026-05-05

**Fixes:**

- **`--retry-failed` now also retries errored judgments, not just failed Claude runs.** A snapshot where a Claude run succeeded but the judge errored (HTTP 5xx, parse failure, rate limit) used to be untouched by `--retry-failed` because `pruneFailedRuns` only looked at `runs[].error`. The user's only recovery options were `--rejudge` (re-judges every row, throws away successful judgments) or hand-editing `snapshot.json`. Now `pruneFailedRuns` also drops judgments where `error !== null && error !== 'run failed'`, keeping the underlying run intact, and the matrix dedup re-judges those rows on resume. Failed Claude runs still get re-run as before. The new return field `prunedFailedJudgmentsOnly` distinguishes the two counts; the resume info line names them separately ("Retrying 1 failed run and 2 failed judgments…"). The "nothing to do" guard now considers both counters.
- **Raw judge response is preserved on parse failures.** When the judge returned a response that wouldn't JSON-parse (most often a capable model writing prose instead of `{...}`), the snapshot's `judgment.raw` was empty — `parseJudgeResponse` threw a generic `Error`, the body was discarded, and the user couldn't see what the model actually wrote, only the parser's complaint about the leading characters. `parseJudgeResponse` now throws `JudgeParseError` (a subclass of `Error`) carrying the original `raw` string, and `judgeRun` reads `e.raw` in its catch handler so it lands on `judgment.raw`. Same fix applies to all four judges (Anthropic, Ollama, OpenAI-compatible, Claude CLI) since they all share `parseJudgeResponse`. The schema is unchanged — `judgment.raw` was always a string field, it just used to be empty when it should have carried the response.

**Schema:**

- `pruneFailedRuns` now returns an additional `prunedFailedJudgmentsOnly: number` field. Existing callers that destructure only the previous fields are unaffected; consumers that care about the distinction can read it directly.

## 0.11.1 — 2026-05-05

**Fixes:**

- **Judge failures now print `FAIL` instead of `OK` on the progress line.** When a judge errored — wrong API key, HTTP 5xx, parse error — the CLI's per-row terminal print hardcoded `OK` because the `judge-end` ProgressEvent didn't carry the error. The user only learned anything went wrong by reading the snapshot file. The `judge-end` event now carries `{ error: string | null, durationMs: number }`, and the CLI uses these to color the row red when the judge failed. The displayed duration is also more accurate now: `judge-end` is the single terminal print for a row, and the run leg duration (stashed at `run-end`) is summed with the judge leg, so the printed `(N.Ns)` reflects the full row wall-clock instead of just one leg. Eliminates a double-print that happened when a Claude run failed (`run-end` printed FAIL then `judge-end` printed FAIL again with `error: 'run failed'` and a misleading `[N+1/N]` counter).
- **`eb run` and `eb eval` exit non-zero when every judgment failed.** A snapshot where every judgment errored — usually because of a misconfigured judge or an unset API key — has all-zero scores, so `summary.delta` is a meaningless `+0.00` and any downstream `--compare` / `--fail-on-regression` check would have approved a regression. The CLI now prints a `! N/M judgments failed — first error: <…>` warning whenever any judgment errors out, and exits 1 if N == M. Partial failures still exit 0 and stay recoverable via `--retry-failed` or `--rejudge`.

**Schema:**

- `ProgressEvent`'s `judge-end` variant adds `error: string | null` and `durationMs: number`. Existing consumers that only switch on `kind` ignore unknown fields and are unaffected.

## 0.11.0 — 2026-05-05

**Features:**

- **`--rejudge` on `eb run`.** Re-score every cached Claude output with the configured judge — keeps run outputs verbatim, drops existing judgments, fires no Claude invocations. Answers "did changing the judge change the verdict?" without paying for a full re-run. Composes with `--baseline-from` and `--current-from`: stitch two saved snapshots and re-judge in one command (`eb run --baseline-from base --current-from cur --rejudge --save-as merged` produces a dual-variant snapshot with zero Claude calls and fresh judgments on both sides). Mutually exclusive with `--force` (which wipes runs) and `--retry-failed` (which targets failed Claude rows, not successful judgments). On an existing complete snapshot, `--rejudge` resumes it instead of erroring "already exists."

**Fixes:**

- **Matrix dedup now re-judges rows where a Claude run succeeded but a judgment is missing.** The third dedup branch previously skipped these rows alongside fully-done ones, so manually editing `snapshot.json` to clear judgments left rows unscored. With this change, the same dedup naturally implements `--rejudge`: any row with a successful run and no (or errored) judgment is routed through the judge, and any row with a successful run and a successful judgment is still skipped. Behavior on snapshots produced by older versions is unchanged because `runBenchmark` always wrote a judgment for every successful run.

## 0.10.0 — 2026-05-04

**Features:**

- **`--current-from <snapshot>` on `eb run`.** Mirrors `--baseline-from`: reuse a saved snapshot's runs for the *current* side instead of re-executing them. Useful when you already have an `eb eval` snapshot at HEAD and want to pair it with a saved baseline without re-running the current ref. Combining `--baseline-from` and `--current-from` stitches two single-variant snapshots into a single dual-variant snapshot with zero fresh claude or judge calls — which is the snapshot shape `eb view` requires (`eb compare` already worked across single-variant snapshots, but `eb view` needs both variants in one snapshot file). `--current-from` is mutually exclusive with `--current`. The `--current` flag's commander default (`HEAD`) was moved into the runner so the mutual-exclusion check can distinguish "user passed --current" from "we defaulted it" — observable behavior is identical.

## 0.9.0 — 2026-04-30

**Features:**

- **Verdict legend in `eb view`.** The hero now carries a row of seven chips — `win`, `cost win`, `stable`, `mixed`, `regression`, `cost regression`, `partial` — each with a colored dot and a one-line definition (e.g. `cost win • same quality, lower cost`). The chip matching the snapshot's actual verdict highlights with the accent border, scales up, and its dot gets a glow halo in its own color, so first-time readers can place "where on the scale this run sits" without consulting docs. Wraps to a column on narrow viewports.
- **Brand mark in the topbar is now a bench icon** (matches the project name) instead of a pulsing green dot. Snapshot HTML `<title>` reads `<name> · eval-bench`.

**Fixes:**

- **Active legend chip's glow now matches its dot color.** The active state used `box-shadow: 0 0 12px currentColor` on the indicator, but `currentColor` resolved to the inherited foreground (cream/grey) instead of the chip's accent — so a `regression` chip had a dim cream halo instead of a red one. Indicator classes now set `color` (not `background`) and the dot draws from `currentColor`, so dot + glow always share the accent.
- **Removed dead `.brand-dot` CSS and `@keyframes pulse`** left behind after the brand mark switched to an SVG icon.

## 0.8.2 — 2026-04-29

**Features:**

- **Light/dark theme toggle in `eb view`.** Sun/moon icon button in the top bar; preference persists in `localStorage` (`ef-theme`) and respects `prefers-color-scheme` on first visit. An inline `<head>` script applies the saved theme before paint to avoid flashing the wrong palette. Light palette is a warm cream/bronze (paper-and-ink) read of the same instrument-panel design — color tokens are CSS variables now, so component styles cover both modes from one declaration. Translucent overlays moved to `color-mix()` so they re-derive from the active accent/bad colors.

## 0.8.1 — 2026-04-29

**Fixes:**

- **`eb view` cell rows align across baseline/current.** The 0.8.0 redesign rendered each variant as its own column, so cells in the left column (`baseline`) and right column (`current`) had independent heights — paired samples (baseline #1 vs current #1) wouldn't sit on the same horizontal line, making side-by-side reading awkward when outputs had different lengths. The variants now share a single 2-column CSS grid, so each row contains the paired baseline + current cell and both stretch to the height of the taller one. Cells flex internally so the judge rationale always sits at the bottom of the cell.

## 0.8.0 — 2026-04-29

**Features:**

- **Redesigned `eb view` HTML.** The snapshot view used to be a wall of identical-looking grey cells with a one-line summary that buried the actual finding ("baseline mean 4.90 · current mean 4.60 · delta -0.30"). Now leads with a verdict — `regression`, `win`, `mixed`, `cost win`, `cost regression`, `stable`, etc. — set in giant Instrument Serif italic, color-coded (green/red/amber), with a one-sentence hook that names the trade-off ("Cheaper, but worse. Trade-off you may not want.") and chip-style reasons that spell out exactly what moved (`▸ 1 run failed`, `▸ quality dropped 0.30 pts`, `▸ cost fell $5.46`). Below: three metric tiles (quality / cost / runs) with deltas vs baseline; a per-prompt breakdown with stacked baseline-vs-current bars, signed delta, and a red `!` flag on prompts that contain a failed run; run cells now have a color-graded left border by score (green ≥ 4.5, amber, red, dark-red for 0/empty), a `FAILED` corner badge on score-0 rows, and italic "no output" instead of a blank `<pre>` for empty outputs. Dark theme with a faint dot grid and JetBrains Mono / Instrument Serif typography. Same data, drastically more legible.
- **Progress denominator now matches the work this invocation actually does.** `eb run` and `eb eval` previously printed `[N/total]` against the *full* matrix, so a `--retry-failed` resume of 4 rows against a 60-row snapshot would print `[57/60]` then `[58/60]` instead of `[1/4]` … `[4/4]`. The runner now emits a `matrix-built` event with `{freshRows, reJudgeRows}` and the CLIs reframe their denominator off it. Re-judge-only rows (resumed snapshots where the run output is cached but the judgment failed) advance the counter on `judge-end` since no `run-end` fires for them.

**Schema:**

- `ProgressEvent` adds `{ kind: 'matrix-built'; freshRows: number; reJudgeRows: number }`. Existing consumers that switch on `kind` ignore unknown kinds and are unaffected.

## 0.7.1 — 2026-04-29

**Fixes:**

- **Ollama judge no longer hits the 5-minute headers timeout.** 0.7.0 switched to streaming on the assumption that `bodyTimeout` was the only undici default in the way. Real-world `--debug` logs proved otherwise: on a partially-CPU-offloaded large model (e.g. `qwen2.5:72b-instruct-q4_0`), the model can spend > 5 min in prompt prefill before sending a single byte, so undici's `headersTimeout: 300_000ms` cancelled the request before the first stream chunk could arrive. Fixed by routing Ollama calls through a custom `undici.Agent` with `headersTimeout: 0` and `bodyTimeout: 0`. Connect timeout still applies (30 s) so a misconfigured endpoint still fails fast. Added `undici` as a direct dep to ensure the dispatcher and fetch implementation come from the same package version (mixing Node's bundled fetch with a standalone-undici Agent throws `UND_ERR_INVALID_ARG` at request time).
- **Better failure messages.** Node's `fetch` wraps the underlying network error as the unhelpful `TypeError("fetch failed")` and stashes the actual reason on `.cause`. The judge-failure rationale and `judge-end` debug event now walk the cause chain, so a future timeout shows e.g. `fetch failed → Headers Timeout Error [UND_ERR_HEADERS_TIMEOUT]` instead of just `fetch failed`.

## 0.7.0 — 2026-04-29

**Features:**

- **`--debug` flag on `eb run` and `eb eval`.** Writes `debug-<ISO-timestamp>.log` under the snapshot dir (one file per invocation, never overwrites) and mirrors a colorized version to stderr. Logs every pipeline event (`config-loaded`, `prompts-loaded`, `matrix-built`, `run-start`/`run-end`, `judge-start`/`judge-end`, `checkpoint`, `snapshot-saved`), every HTTP exchange to the judge with full request/response bodies, and the subprocess command line for each Claude invocation. Sensitive headers (`Authorization`, `X-Api-Key`, `Anthropic-Api-Key`, `Openai-Api-Key`) are redacted. Stderr truncates bodies > 2KB; the file always has full bodies.
- **Ollama judge now streams (`/api/chat` with `stream: true`).** Each NDJSON chunk resets undici's `bodyTimeout`, so legitimately slow generation no longer hits the hard 5-minute headers timeout. The final chunk's diagnostic timing fields (`prompt_eval_count/duration`, `eval_count/duration`, `total_duration`) are surfaced on `judge-end` debug events, so a fast snapshot's debug log can be `diff`ed against a slow snapshot's to localize "is the prompt bigger or is generation slower per token". Heartbeat `http-chunk` events fire every 32 chunks during streaming.

## 0.6.0 — 2026-04-29

**Features:**

- **`provider.cwd` — per-sample working directory (default on).** Each Claude invocation now spawns in its own dir under the snapshot, so any files the model writes (`.likec4` diagrams, generated code, scratch outputs) land alongside `snapshot.json` instead of leaking into your repo working tree. Default template: `{{snapshots_dir}}/{{snapshot_name}}/{{variant}}/{{prompt_id}}/{{sample}}`. Override with any path string built from `{{snapshots_dir}}`, `{{snapshot_name}}`, `{{variant}}`, `{{prompt_id}}`, `{{sample}}`, `{{plugin_dir}}`. Set `cwd: null` to opt back into the legacy "inherit `eb`'s cwd" behavior.
- **`runs[].cwd` recorded in snapshots** — the resolved (canonical, post-`realpath`) absolute path for every run is stored on `RunResult.cwd`, so judges and post-hoc inspection can locate each row's artifacts.

**Schema:**

- `Config.provider.cwd: string | null` — path template; default colocates artifacts under the snapshot dir (see above).
- `RunResult.cwd: string | null` — null only when `provider.cwd` is explicitly null. Old snapshots load unchanged (treated as null).

**Compatibility:**

- Existing configs without `provider.cwd` opt into the new default automatically. If you'd been relying on Claude inheriting `eb`'s cwd (e.g. tests that assert artifacts at the project root), set `provider.cwd: null` in `eval-bench.yaml` to restore the old behavior.

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

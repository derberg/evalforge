# Changelog

All notable changes to this project will be documented in this file.

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

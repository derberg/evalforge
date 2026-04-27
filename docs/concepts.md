# Concepts

**Plugin** — the Claude Code plugin under test. A directory containing `.claude-plugin/plugin.json` and any combination of `skills/`, `agents/`, `commands/`, `hooks/`, and MCP server declarations. Must be in a git repo. If you only have standalone `skills/` or `agents/` directories without `plugin.json`, eval-bench will automatically create a temporary minimal manifest during benchmark runs.

**Skill** — a `SKILL.md` (plus optional resources) under `skills/<name>/`. Loaded into Claude Code's skill registry when the plugin is active.

**Subagent** — a specialized agent the plugin defines (typically under `agents/`) that other prompts can delegate to.

**MCP server** — a server declared in the plugin manifest. When the plugin loads, Claude Code starts the server and exposes its tools.

**Slash command** — a user-invocable command defined under `commands/<name>.md`.

**Hook** — a script that fires on a Claude Code lifecycle event (pre-tool, post-tool, session start/end). Can read and rewrite tool calls or prompts.

**Baseline** — the plugin version you are comparing *against*. Usually a tag or commit SHA (e.g. `v1.0.0`, `origin/main`). Resolved via `git rev-parse` and checked out into a temporary worktree.

**Current** — the plugin version you are comparing. Defaults to `HEAD` (your working tree).

**Variant** — either `baseline` or `current`. Each prompt is run against both.

**Sample** — one execution of one prompt against one variant. `samples: 3` means each prompt is run 3 times per variant so we can measure variance (noise) in the judge scoring.

**Judge** — an LLM that reads the prompt, the output, and the rubric, and returns a score 0–5 plus a rationale. Supported providers: `ollama`, `anthropic`, `openai`, `openai-compatible`.

**Rubric** — per-prompt grading criteria. Write a specific, checklist-style rubric; vague rubrics produce noisy judge scores. See [rubrics.md](rubrics.md).

**Snapshot** — the saved result of an `eb run`. JSON file at `.eval-bench/snapshots/<name>/snapshot.json`. Contains the prompts, every run's output, every judgment, and summary statistics. Commit them to git if you want a historical record.

**Comparison** — the diff between two snapshots. Per-prompt mean deltas, a net score, and lists of improvements / stable / regressions. Output as markdown or JSON.

# Quickstart

Get from zero to your first benchmark comparison in ten minutes.

## Prerequisites

- Node 20+
- `claude` CLI on PATH
- Your Claude Code plugin in a git repo
- Ollama installed locally (`curl -fsSL https://ollama.com/install.sh | sh`) — or an Anthropic/OpenAI API key

## 1. Install

```bash
npm i -g eval-bench
```

## 2. Pull a judge model (Ollama path)

```bash
ollama pull qwen2.5:14b
```

## 3. Scaffold

```bash
cd my-claude-plugin
eb init
```

This creates a `.eval-bench/` directory containing `eval-bench.yaml`, `prompts.yaml`, and a `snapshots/` subdirectory.

## 4. Write prompts

Edit `.eval-bench/prompts.yaml`. Three to five prompts that exercise your plugin's key capabilities. For each, write a specific rubric.

```yaml
- id: find-user-by-email
  prompt: |
    Find the user with email alice@example.com and show their last 5 orders.
  rubric: |
    Score 0-5:
    - Uses the correct tool (user-lookup) rather than guessing (0-2)
    - Returns exactly 5 orders in descending-date order (0-2)
    - No invented fields or order numbers (0-1)
```

## 5. Establish a baseline

```bash
eb eval --ref v1.0.0 --save-as v1-baseline
```

`eb eval` runs the matrix at a single ref and saves a single-variant snapshot. This is your fixed reference for later comparisons — and it doesn't waste cost on a redundant second variant.

## 6. Make a change

Edit your plugin — tweak a skill, add an MCP server, change a subagent prompt. Commit or just leave dirty in the working tree.

## 7. Re-run and compare

```bash
eb run --baseline-from v1-baseline --save-as wip --compare v1-baseline
```

`--baseline-from <name>` reuses the runs and judgments from the saved snapshot for the baseline side, so only your current ref actually executes. The cache hit is logged:

```
Baseline: v1.0.0 (cached from snapshot "v1-baseline", sha=abc12345, 6 runs reused)
```

You'll see per-prompt deltas and a net score. If the net is positive and no prompts regressed, your change is a win.

For one-shot A/B comparisons of two arbitrary refs (e.g. in CI), use the original two-ref form: `eb run --baseline origin/main --current HEAD --save-as pr-42 --fail-on-regression 0.1`. Both variants run from scratch.

If a run crashes (^C, judge timeout, OOM), re-running with the same `--save-as <name>` resumes — completed prompts are kept, only the unfinished ones run. See [troubleshooting.md](troubleshooting.md#mid-run-crash-c-or-judge-timeout--what-happens-when-i-re-run) for the full rules (which rows resume, which retry, when you need `--force`).

When iterating on a single prompt or rubric, restrict the matrix with `--only`:

```bash
eb eval --save-as wip --only find-user-by-email
eb run --baseline-from v1-baseline --save-as wip --only find-user-by-email,list-orders
```

`--only` accepts a comma-separated list and can be repeated. Unknown ids fail loudly. The resulting snapshot only contains the named prompts.

> **Caveat for `eb compare`:** comparing a filtered snapshot against a full baseline currently treats prompts missing from one side as score 0 — that produces fake regressions for the dropped prompts. For meaningful diffs, compare snapshots with matching prompt sets (e.g. `eb eval --save-as v1-baseline-p2 --ref v1.0.0 --only p2` then diff that against a `--only p2` iter).

## 8. Open the HTML view

```bash
eb view wip
```

Opens a local HTML page with baseline vs current outputs per prompt, judge scores, and rationale.

## Next

- [concepts.md](concepts.md) for terminology
- [rubrics.md](rubrics.md) for writing better rubrics (the single biggest lever on signal quality)
- [judges.md](judges.md) for picking between Ollama / Anthropic / OpenAI
- [ci.md](ci.md) for running this on every PR

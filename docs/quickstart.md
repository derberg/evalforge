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
eb run --baseline v1.0.0 --current v1.0.0 --save-as v1-baseline
```

Both baseline and current are v1.0.0 — this is your clean comparison point. The tool still runs both variants so you can measure judge noise.

## 6. Make a change

Edit your plugin — tweak a skill, add an MCP server, change a subagent prompt. Commit or just leave dirty in the working tree.

## 7. Re-run and compare

```bash
eb run --baseline v1.0.0 --save-as wip --compare v1-baseline
```

You'll see per-prompt deltas and a net score. If the net is positive and no prompts regressed, your change is a win.

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

# eval-bench vs raw Promptfoo

eval-bench is opinionated and narrowly scoped. Promptfoo is general-purpose and broad. They overlap; here's when to use each.

## Use eval-bench when

- You're benchmarking a **Claude Code plugin** end-to-end with real skills, MCP servers, subagents, slash commands, and hooks loaded.
- You want to compare **plugin versions via git refs** (`v1.0.0` vs `HEAD`).
- You want a turnkey A/B with LLM-as-judge and per-prompt rubrics, with no YAML learning curve beyond the config + prompts files.
- You want CI that fails the build on regression with one flag (`--fail-on-regression`).
- You want full local privacy (Ollama judge, no data leaves your machine).

## Use raw Promptfoo when

- You're benchmarking arbitrary **LLM prompts** (templates, chains) across multiple providers (OpenAI + Anthropic + Gemini side-by-side).
- You want **red-team testing** — Promptfoo has a mature red-team mode eval-bench doesn't have.
- You want **dataset-based evaluation** (HuggingFace datasets, custom CSV inputs).
- You need Promptfoo's **plugin/extension ecosystem** (custom assertions, scoring functions).
- You want **multi-provider matrix views** out of the box.

## Use both

A reasonable pattern: eval-bench for the Claude Code plugin regression loop on your repo, Promptfoo for one-off prompt engineering experiments outside that loop. They don't conflict; they don't even know about each other.

## Why not just generate a Promptfoo config?

eval-bench could (and may in the future) generate a Promptfoo config under the hood and shell out to `promptfoo eval`. The reason it doesn't today: Promptfoo's providers hit the API directly, so the full Claude Code plugin manifest (skills, MCPs, subagents, hooks) wouldn't load. The whole point of this tool is exercising that machinery, which means we have to drive `claude -p` ourselves.

If a future Promptfoo provider gains the ability to spawn `claude -p` with environment isolation, the right architecture is probably "eval-bench as a Promptfoo plugin." For now, eval-bench owns its own runner.

# Changelog

All notable changes to this project will be documented in this file.

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

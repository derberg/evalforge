# eval-bench — Specification

> Status: Draft v1 — 2026-04-23
> Target: standalone npm package, to live in a new repository (not yet created)

## 1. Goal

A local tool that benchmarks a **Claude Code plugin** by running a fixed set of evaluation prompts against two versions of the plugin, grading the outputs with an LLM judge, and producing a side-by-side comparison report. The tool must work locally on a single developer's machine and in CI, must invoke the real Claude Code harness (not bypass it via direct API calls), and must be configurable to use either a hosted judge (Anthropic / OpenAI) or a local judge (Ollama / any OpenAI-compatible endpoint).

### What counts as a "plugin"

A Claude Code plugin is a directory (typically with `.claude-plugin/plugin.json`) that can bundle **any combination** of:

- **Skills** (`skills/<name>/SKILL.md` + resources)
- **Subagents** (`agents/<name>.md` or referenced from skills)
- **MCP servers** (declared in the plugin manifest)
- **Slash commands** (`commands/<name>.md`)
- **Hooks** (pre-tool / post-tool / session lifecycle)

Benchmarking a plugin means exercising the **behavior** that emerges when Claude Code loads all of these at once — not just one component in isolation. A skill that delegates to a subagent, a command that invokes an MCP server, or a hook that rewrites prompts before a tool call are all in scope. The evaluation prompts should exercise the paths you care about: some prompts trigger skills, some trigger MCP tools, some delegate to subagents. The judge grades end-to-end outputs regardless of which internal path produced them.

This is why the tool drives the *real* `claude` CLI rather than calling the Anthropic API directly: only the CLI loads the full plugin manifest, starts MCP servers, registers subagents, and wires up hooks. Bypassing the CLI would reduce this to prompt-template benchmarking, which misses the point.

## 2. Non-goals

- **Not a general LLM evaluation framework.** Promptfoo already exists. This is a thin opinionated wrapper for the specific "did my plugin edit help or hurt?" workflow.
- **Not a replacement for unit/integration tests** of a plugin's code. It evaluates end-to-end behavior quality.
- **Not a dataset generator.** The user writes the prompts and rubrics.
- **Not a CI orchestrator.** It ships a sample GitHub Actions workflow; it does not install runners or manage secrets.
- **Does not bundle an inference runtime.** It calls existing tools (`claude`, `ollama`, hosted APIs) via their own interfaces.

## 3. User stories

**As a plugin author** I want to save a baseline of benchmark results before I change my plugin, so I can prove my change did not regress quality.

**As a plugin author** I want to A/B my plugin against itself (version X vs version Y) with the real Claude Code harness loaded, so results reflect what users will actually experience.

**As a plugin author on CI** I want every PR to run the benchmark against `main`, post a summary, and fail if quality drops beyond a threshold I choose.

**As a privacy-conscious developer** I want the option to use a local judge model (Ollama / HuggingFace GGUF) so no prompt or output leaves my machine.

**As a reviewer** I want a single HTML page that shows, per prompt: baseline output, current output, judge scores, judge rationale, and a clear verdict.

## 4. Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│ eval-bench CLI                                           │
│                                                                  │
│  config loader ─┐                                                │
│  prompts loader ┼─► orchestrator ─► runner ─► snapshot writer    │
│                 │                    │                           │
│                 │                    ├─► [baseline variant]      │
│                 │                    │       └─► Claude Code     │
│                 │                    │             (via claude   │
│                 │                    │              -p subproc)  │
│                 │                    │                           │
│                 │                    ├─► [current variant]       │
│                 │                    │       └─► Claude Code     │
│                 │                    │                           │
│                 │                    └─► judge(s)                │
│                 │                          │                     │
│                 │                          ├─► Anthropic API     │
│                 │                          ├─► OpenAI API        │
│                 │                          └─► Ollama / any      │
│                 │                              OpenAI-compatible │
│                 │                                                │
│                 └─► plugin-version swap (git worktree)           │
│                                                                  │
│  reporter ──► JSON snapshot + HTML view (Promptfoo)              │
│  compare  ──► JSON diff + markdown summary                       │
└──────────────────────────────────────────────────────────────────┘
```

### Data flow per run

1. User runs `ef run --baseline v1.2.0` in a plugin repo.
2. Tool resolves baseline ref to a commit SHA via `git rev-parse`.
3. Tool creates a temp git worktree at that SHA.
4. For each prompt × sample × variant:
   - Spawn `claude -p <prompt>` with `EVAL_BENCH_PLUGIN_DIR` pointing at the correct plugin path and a generated isolated `settings.json`.
   - Capture stdout + duration + any error.
5. For each captured output, send to the configured judge with the rubric; parse structured score.
6. Write a snapshot JSON file under `snapshots/<timestamp>/`.
7. If `--compare <snapshot-name>` is passed, also emit a comparison report.

### Why Promptfoo underneath

The runner, storage, diff UI, and LLM-judge primitives are solved by Promptfoo. This tool generates a Promptfoo config under the hood, invokes Promptfoo, then post-processes results into our snapshot format. Users don't need to know or touch Promptfoo — but they can drop to raw Promptfoo if they need power features.

### Why git worktrees for plugin swap

A git worktree at a different ref is physically isolated on disk, cannot accidentally contaminate the working tree, and cleans up with `git worktree remove`. Cleaner than stashing, branch-switching, or symlink tricks. Requires the plugin to be in a git repo; MVP refuses non-git plugins with a clear error.

## 5. CLI reference

### `ef init`

Scaffold a benchmark config in the current directory.

```
$ ef init
✓ Created eval-bench.yaml
✓ Created prompts.yaml (with 2 sample prompts)
✓ Created snapshots/.gitkeep
✓ Added snapshots/ to .gitignore (uncomment the line if you want to commit snapshots)

Next steps:
  1. Edit prompts.yaml — write 3-5 prompts that exercise your plugin
  2. Edit eval-bench.yaml — set judge provider and model
  3. Run: ef run --baseline <ref> --save-as v1-baseline
```

### `ef run`

Run a benchmark against the plugin.

```
Usage: ef run [options]

Options:
  --plugin <path>            Path to plugin (default: cwd)
  --baseline <ref>           Git ref for baseline (default: HEAD~1 if in git, required otherwise)
  --current <ref>            Git ref for current (default: HEAD, i.e. working tree)
  --prompts <file>           Prompts file (default: ./prompts.yaml)
  --config <file>            Config file (default: ./eval-bench.yaml)
  --samples <n>              Override config samples-per-prompt
  --judge <spec>             Override config judge, e.g. ollama:qwen2.5:14b
  --save-as <name>           Save snapshot under this name (default: timestamp)
  --compare <name>           After running, compare against this snapshot
  --fail-on-regression <n>   Exit nonzero if net score drops more than <n> (e.g. 0.05)
  --dry-run                  Print planned matrix without running
  -v, --verbose
  -h, --help
```

### `ef view`

Open the Promptfoo web UI on the most recent run (or a named snapshot).

```
Usage: ef view [snapshot-name]

Delegates to `promptfoo view` under the hood. Opens http://localhost:15500.
```

### `ef snapshot`

Manage saved snapshots.

```
Usage: ef snapshot <command>

Commands:
  list              List saved snapshots
  save <name>       Save the most recent run as a named snapshot
  rm <name>         Delete a snapshot
  show <name>       Print the snapshot summary to stdout
```

### `ef compare`

Compare two snapshots, emit a markdown summary + JSON diff.

```
Usage: ef compare <snapshot-a> <snapshot-b> [options]

Options:
  --format <fmt>      Output format: md | json | both (default: md)
  --out <path>        Write to file (default: stdout)
  --threshold <n>     Only show prompts where score delta > <n>
```

## 6. Config reference

### `eval-bench.yaml`

```yaml
# Plugin under test
plugin:
  path: ./              # directory containing .claude-plugin/ or skills/
  gitRoot: ./           # optional; default = plugin.path — where to create worktrees

# How to invoke Claude Code
provider:
  command: claude       # path to claude CLI; default picked up from PATH
  extraArgs: []         # appended to `claude -p <prompt>`
  timeout: 180          # seconds per prompt
  model: claude-opus-4-7  # passed via --model
  allowedTools: null    # null = default; or e.g. ['Read', 'Bash']

# LLM judge
judge:
  provider: ollama      # ollama | anthropic | openai | openai-compatible
  model: qwen2.5:14b    # model identifier for the provider
  endpoint: http://localhost:11434   # required for ollama and openai-compatible
  temperature: 0
  maxTokens: 1024

# Runs
runs:
  samples: 3            # repeats per prompt per variant (noise reduction)
  parallel: 2           # concurrent Claude invocations — keep low; API rate limits

# Output
snapshots:
  dir: ./snapshots      # where snapshots are written
```

### `prompts.yaml`

```yaml
# A skill-driven prompt — exercises a SKILL.md
- id: list-products-via-skill
  prompt: |
    List all products and give a one-line description of each.
  rubric: |
    Score 0-5 on:
    - Completeness (0-2): names every product currently in the docs
    - Accuracy (0-2): one-liners match the official documented purpose
    - Format (0-1): readable list, no padding or filler
    Penalty: -1 if it invents products that don't exist.

# An MCP-driven prompt — exercises a tool exposed by the plugin's MCP server
- id: query-database-via-mcp
  prompt: |
    Use the `db.query` tool to find the 5 most recent orders for user id 42.
    Return them as a markdown table.
  rubric: |
    Score 0-5 on:
    - Tool invocation (0-2): actually calls the db.query MCP tool; does not guess
    - Correctness (0-2): returns exactly 5 rows in descending date order
    - Formatting (0-1): valid markdown table with headers
    Penalty: -2 if it invents order data instead of calling the tool.

# An agent-driven prompt — exercises a subagent referenced by a skill
- id: code-review-via-subagent
  prompt: |
    Review the diff in PR #123 and identify any security issues.
  rubric: |
    Score 0-5 on:
    - Delegation (0-1): delegates to the security-review subagent
    - Coverage (0-2): checks auth, input validation, SQL/XSS, secret handling
    - Specificity (0-2): identifies concrete issues with file:line references; no generic advice

# A command-driven prompt — exercises a slash-command workflow
- id: slash-command-flow
  prompt: |
    Run /deploy-check for the staging environment and report the result.
  rubric: |
    Score 0-5 on:
    - Invocation (0-1): actually runs the /deploy-check command
    - Reporting (0-2): summarizes pass/fail per check in the output
    - Actionability (0-2): when failed, identifies the specific failing check
```

## 7. End-to-end walkthrough

### First run (establishing a baseline)

```
$ git checkout v1.2.0
$ ef init
✓ Created eval-bench.yaml, prompts.yaml

$ $EDITOR prompts.yaml   # write 3-5 prompts for your plugin

$ ef run --baseline v1.2.0 --current v1.2.0 --save-as v1.2.0-baseline
Using config: eval-bench.yaml
Plugin: /Users/me/my-plugin (v1.2.0)
Judge:  ollama/qwen2.5:14b @ http://localhost:11434
Matrix: 5 prompts × 3 samples × 2 variants = 30 runs

[1/30] list-cennso-products          baseline sample-1  OK   (14.2s)
[2/30] list-cennso-products          baseline sample-2  OK   (12.8s)
...
[30/30] tsr-install-steps            current  sample-3  OK   (22.1s)

Judging 30 outputs...
[1/30] list-cennso-products          baseline sample-1  score 4.2
...

Snapshot saved: snapshots/v1.2.0-baseline/

Summary:
  baseline (v1.2.0)  mean 3.84  median 4.00  variance 0.31
  current  (v1.2.0)  mean 3.81  median 4.00  variance 0.28
  delta: -0.03 (within noise)
```

### Second run (after editing the plugin)

```
$ $EDITOR skills/list-products/SKILL.md   # make some changes

$ ef run --baseline v1.2.0-baseline --save-as with-clarified-wording --compare v1.2.0-baseline
...
Snapshot saved: snapshots/with-clarified-wording/
Comparing with snapshots/v1.2.0-baseline/

Per-prompt deltas:
  list-cennso-products    +0.7   ✓ improved
  tsr-install-steps       +0.1   ~ stable
  ...

Net: +0.41 (improved)
Regressions: 0
Open the UI:  ef view with-clarified-wording
```

## 8. Sample GitHub Actions workflow

`.github/workflows/eval-bench.yml` (generated by `ef init --ci`):

```yaml
name: Skill Benchmark

on:
  pull_request:
    paths:
      - 'skills/**'
      - 'agents/**'
      - 'commands/**'
      - 'hooks/**'
      - 'mcp/**'
      - '.claude-plugin/**'

jobs:
  bench:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@<sha>  # pin to SHA per policy
        with:
          fetch-depth: 0

      - uses: actions/setup-node@<sha>
        with:
          node-version: '20'

      # Install Claude Code CLI
      - run: npm i -g @anthropic-ai/claude-code

      # Cache Ollama models
      - uses: actions/cache@<sha>
        with:
          path: ~/.ollama/models
          key: ollama-qwen2.5-14b-q4

      # Install + start Ollama
      - run: curl -fsSL https://ollama.com/install.sh | sh
      - run: ollama serve &
      - run: sleep 2 && ollama pull qwen2.5:14b

      # Run the benchmark
      - run: npx eval-bench run \
            --baseline origin/main \
            --current HEAD \
            --save-as pr-${{ github.event.pull_request.number }} \
            --compare main-baseline \
            --fail-on-regression 0.05
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}

      - uses: actions/upload-artifact@<sha>
        if: always()
        with:
          name: benchmark-results
          path: snapshots/

      - name: Post summary
        if: always()
        run: npx eval-bench compare main-baseline pr-${{ github.event.pull_request.number }} --format md >> $GITHUB_STEP_SUMMARY
```

## 9. Judge configuration reference

### Ollama (local, default for `ef init`)

```yaml
judge:
  provider: ollama
  model: qwen2.5:14b       # or llama3.1:8b-instruct, mistral:7b-instruct, phi4
  endpoint: http://localhost:11434
```

Recommended models by resource budget:
- 16 GB RAM, CPU only: `qwen2.5:7b-instruct` or `llama3.1:8b-instruct` (Q4)
- 32 GB RAM, CPU: `qwen2.5:14b` (Q4) — the default
- GPU available: `qwen2.5:32b` or better

### Anthropic

```yaml
judge:
  provider: anthropic
  model: claude-opus-4-7   # or claude-sonnet-4-6, claude-haiku-4-5
```

Reads `ANTHROPIC_API_KEY` from env. Reminder: using Claude to judge Claude has bias risk; document in README; recommend cross-model judging for release gates.

### OpenAI

```yaml
judge:
  provider: openai
  model: gpt-4o            # or gpt-4o-mini
```

Reads `OPENAI_API_KEY` from env.

### OpenAI-compatible (HuggingFace Inference Endpoints, Groq, Together, local vLLM, llama.cpp server, etc.)

```yaml
judge:
  provider: openai-compatible
  model: mistralai/Mistral-7B-Instruct-v0.3
  endpoint: https://<your-endpoint>.hf.space/v1
  apiKeyEnv: HF_TOKEN      # env var name to read the bearer token from
```

## 10. Output format reference

### Snapshot JSON schema (`snapshots/<name>/snapshot.json`)

```json
{
  "schemaVersion": 1,
  "name": "v1.2.0-baseline",
  "createdAt": "2026-04-23T10:14:22Z",
  "plugin": {
    "path": "/Users/me/my-plugin",
    "baselineRef": "v1.2.0",
    "baselineSha": "abc123...",
    "currentRef": "HEAD",
    "currentSha": "def456..."
  },
  "config": { /* resolved eval-bench.yaml */ },
  "judge": {
    "provider": "ollama",
    "model": "qwen2.5:14b",
    "modelDigest": "sha256:..."
  },
  "runs": [
    {
      "id": "list-cennso-products::baseline::1",
      "promptId": "list-cennso-products",
      "variant": "baseline",
      "sample": 1,
      "output": "...",
      "durationMs": 14210,
      "exitCode": 0
    }
  ],
  "judgments": [
    {
      "runId": "list-cennso-products::baseline::1",
      "score": 4.2,
      "rationale": "Lists 8 of the 9 products...",
      "rubricVersion": "sha256:..."
    }
  ],
  "summary": {
    "baseline": { "mean": 3.84, "median": 4.0, "variance": 0.31, "n": 15 },
    "current":  { "mean": 3.81, "median": 4.0, "variance": 0.28, "n": 15 },
    "delta": -0.03
  }
}
```

### Comparison markdown (`ef compare ... --format md`)

```markdown
## Benchmark comparison: `v1.2.0-baseline` → `with-clarified-wording`

**Net delta:** +0.41 (improved)
**Regressions (>= 0.2 drop):** 0
**Improvements (>= 0.2 gain):** 2

| Prompt | Baseline | Current | Δ | Verdict |
|---|---|---|---|---|
| list-cennso-products | 3.40 | 4.10 | +0.70 | ✓ improved |
| tsr-install-steps | 3.90 | 4.00 | +0.10 | ~ stable |
| ... | ... | ... | ... | ... |

### list-cennso-products (+0.70)

**Baseline output:** <truncated, see snapshot>
**Current output:** <truncated, see snapshot>
**Judge rationale (baseline):** Missed 2 products...
**Judge rationale (current):**  Lists all 9 products accurately...

### ... (one section per prompt with delta > threshold)
```

## 11. UI walkthrough

The tool reuses Promptfoo's web UI for the interactive view; the tool's value-add over raw Promptfoo is the comparison summary layer on top.

### `ef view <snapshot>` — Promptfoo-native view

- Left pane: prompt list
- Right pane: per-prompt grid with columns [baseline-1, baseline-2, baseline-3, current-1, current-2, current-3], each cell showing output + score badge
- Filter: "show only regressions", "show only prompts with delta > X"
- Click a cell: expand to full output + judge rationale

### Comparison summary (markdown, printed on completion or via `ef compare`)

See section 10.

### Terminal output during `ef run`

Structured progress: one line per `[n/total] <prompt-id> <variant> <sample> <status> (<duration>)`, with colored status (green OK, yellow TIMEOUT, red FAIL). Trailing summary block with mean/median/variance/delta.

## 12. Docs plan

Pages that ship with the repo:

1. **`README.md`** — problem framing, 60-second quickstart, link to full docs
2. **`docs/quickstart.md`** — from zero to first comparison (10 minutes)
3. **`docs/concepts.md`** — plugin (with its component types: skills, subagents, MCP servers, commands, hooks), baseline, current, variant, sample, judge, rubric, snapshot
4. **`docs/config.md`** — every field in `eval-bench.yaml` and `prompts.yaml`
5. **`docs/rubrics.md`** — how to write rubrics that produce reliable judge scores, with worked examples for each plugin component type (skill behavior, MCP tool invocation, subagent delegation, slash command flow, hook effect)
6. **`docs/judges.md`** — choosing a judge, local vs hosted tradeoff table, known-good models, bias warnings
7. **`docs/ci.md`** — sample workflows for GitHub Actions, GitLab CI, and a "self-hosted GPU runner" guide
8. **`docs/troubleshooting.md`** — common errors (no git repo, Claude CLI not found, Ollama not running, judge returning non-JSON)
9. **`docs/comparison-to-promptfoo.md`** — when to use this tool vs raw Promptfoo
10. **`CONTRIBUTING.md`** — how to add a new judge provider, how to add a new test, release process

## 13. Technology choices

| Choice | Decision | Rationale |
|---|---|---|
| Language | TypeScript | Promptfoo is TS/JS; `npx` install; no Python env problems in CI |
| Runtime | Node 20+ | Long-term support; `execa` and modern ESM |
| CLI framework | `commander` | Simpler than yargs for this surface |
| Config validation | `zod` | Parse-don't-validate; TypeScript-native |
| Config format | YAML | User-editable; comments survive |
| Subprocess | `execa` | Robust cross-platform; good streaming |
| Testing | `vitest` | Fast; ESM-native; Jest-compatible assertions |
| Packaging | npm, CJS + ESM | Broad compat; `npx eval-bench` works zero-install |
| Judge transport | OpenAI-compatible HTTP for all except Anthropic | One client for Ollama, OpenAI, HF endpoints, Groq, vLLM |
| Plugin swap | `git worktree` | Physical isolation; safe cleanup; MVP requires git |
| Storage | Local filesystem; JSON | Portable; committable; diffable |

## 14. MVP scope vs future

### MVP (shipped in v0.1)

- CLI: `init`, `run`, `view`, `snapshot list/save/rm/show`, `compare`
- Providers: the Claude Code `claude -p` subprocess shim
- Judges: Anthropic, Ollama, OpenAI, OpenAI-compatible
- Plugin swap: git worktree only
- Storage: local JSON snapshots
- View: delegated to `promptfoo view`
- Comparison: markdown + JSON
- Sample GitHub Actions workflow
- Core docs (README, quickstart, concepts, config, rubrics, judges, CI, troubleshooting)

### Explicitly deferred to v0.2+

- `--baseline-path` for non-git plugins
- Multi-judge aggregation with weights
- Custom HTML reporter (beyond Promptfoo's)
- Model-hash pinning / judge-reproducibility verification on `compare`
- Prompt datasets / fixture management (import HuggingFace datasets)
- Plugin marketplace integration (`ef run --plugin @anthropic/cookbook`)
- Token / cost accounting
- Cost-aware judge selection (e.g. "use cheap judge first, re-judge contested cases with heavier judge")
- Statistical significance testing beyond mean/median/variance

## 15. Risks and open questions

- **Bias in same-family judging.** Claude judging Claude will favor Claude patterns. Mitigation: default to Ollama; document clearly; recommend cross-model judging at release gates.
- **Judge output format flakiness.** Small judges sometimes fail to return parseable JSON. Mitigation: structured output via JSON mode where supported; aggressive parser with one retry; log+skip on repeated failure.
- **Claude Code plugin loading internals may change.** The tool depends on being able to point `claude` at a specific plugin directory. Mitigation: isolate this into one module (`provider.ts`) so the loading mechanism can be updated without touching the rest.
- **CI cost.** Running real Claude inference on every PR is paid API time. Mitigation: `--samples 1` mode for CI + smaller prompt set; recommend a cron job for the fuller matrix rather than per-PR.
- **Reproducibility across Claude model versions.** When Anthropic bumps a model revision, baselines may become invalid. Mitigation: record the `claude --model` value + CLI version in the snapshot; warn in `compare` if they differ.

## 16. Success criteria

The project ships v0.1 when:

1. A user can clone their plugin repo, run `npx eval-bench init`, edit prompts, run `ef run --baseline v1 --save-as v1-baseline`, and see results within 15 minutes on a 5-prompt / 3-sample / 2-variant matrix.
2. A second run with `--compare v1-baseline` produces a markdown comparison with per-prompt deltas and a net score.
3. The sample GitHub Actions workflow runs the benchmark end-to-end against a published sample plugin, using a cached Ollama judge, in under 10 minutes.
4. All core docs pages are written; README quickstart works copy-pasted.
5. Test coverage is high enough that swapping a judge provider or adjusting the config schema doesn't require manual smoke-testing to catch regressions.

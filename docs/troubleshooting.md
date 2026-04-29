# Troubleshooting

## "not a git repo"

eval-bench requires the plugin to be in a git repo because it uses `git worktree` to check out the baseline ref. Run `git init` in your plugin directory and commit at least once. Non-git plugin support is planned for v0.2.

## "claude CLI not found"

Install Claude Code: `npm i -g @anthropic-ai/claude-code`. Verify with `claude --version`. If you're using a custom path, set `provider.command` in `.eval-bench/eval-bench.yaml`.

## "Ollama: connection refused"

Ollama isn't running. Start it: `ollama serve`. Or if installed as a service, `systemctl start ollama` (Linux) — on macOS the installer usually starts it automatically.

Check the endpoint in `.eval-bench/eval-bench.yaml`. Default Ollama port is `11434`. If you've configured a non-standard port, update the config.

## "judge response: could not parse JSON"

The judge model returned something that doesn't have a parseable JSON `{score, rationale}`. Causes and fixes:

1. **Model is too small.** 3B-class models often fail at structured output. Use 7B+. The default `qwen2.5:14b` is fine.
2. **Rubric is too vague.** The judge invents prose instead of returning JSON. See [rubrics.md](rubrics.md) — make criteria specific and numbered.
3. **Output is empty or contains weird control characters.** Check the snapshot's `runs[].output` for the affected run. If `claude -p` is producing garbage, the issue is upstream.

The parser tries hard (extracts from fenced blocks, finds the first `{...}`), so persistent failures point at one of the above.

## "timed out"

A `claude -p` call exceeded `provider.timeout`. Defaults to 180 s. If your prompts genuinely take longer (large MCP tool chains, big subagent delegations), bump the timeout:

```yaml
provider:
  timeout: 600
```

For faster iteration on the dev loop, also reduce `samples` to 1.

## "API key not set"

For Anthropic / OpenAI judges, the key env var must be set:

```bash
export ANTHROPIC_API_KEY=sk-...
ef run ...
```

Or override which env var is used:

```yaml
judge:
  provider: anthropic
  apiKeyEnv: MY_CUSTOM_ANTHROPIC_VAR
```

## Mid-run crash, ^C, or judge timeout — what happens when I re-run?

`eb run` and `eb eval` write the snapshot to disk after every prompt × judge pair, so completed work survives a crash. The on-disk file carries a `complete: false` flag while a run is in progress.

**Re-run with the same `--save-as <name>`:** picks up where it left off. You'll see:

```
Resuming from partial snapshot: 12 runs, 12 judgments already done
```

The matrix is rebuilt and three things happen:

1. **Fully successful rows** (Claude run + judge both succeeded) — skipped.
2. **Run succeeded, judge errored** — re-judged using the cached run output (cheap, no Claude re-invocation). This is also how `eb run` recovers from a `judge response: could not parse JSON` failure on one prompt without re-running the others.
3. **Run itself failed** (timeout, non-zero exit, empty output) — *not* retried automatically. Re-running an expensive Claude call that already failed is rarely useful; if it was a transient blip, delete the partial snapshot first to force a full retry: `eb snapshot rm <name>`.

**Re-run against a different `--save-as <name>`:** starts fresh. The previous partial snapshot is left untouched on disk.

**`eb run` against an existing *complete* snapshot:** warns and overwrites in place.

**`eb eval` against an existing *complete* snapshot:** errors out and tells you to pass `--force`. Different default because an `eb eval` snapshot is usually a frozen reference (`v1-baseline` etc.) and silently clobbering one is a foot-gun.

**`eb run --baseline-from <name>`** loads `<name>`'s runs into the new snapshot's baseline slot at startup. If the new snapshot's name later resumes, those baseline rows are already on disk in the partial snapshot — the cache load is idempotent.

## Worktree cleanup left a directory in /tmp

If the tool crashes mid-run, the temp worktree may not get cleaned up. Run `git worktree prune` in your plugin repo and `rm -rf /tmp/ef-wt-*`.

## Snapshot directory blew up

If you've been running with `samples: 5` for weeks, snapshots add up. They're just JSON; commit the ones you care about, delete the rest with `ef snapshot rm <name>`.

## Tests pass locally but fail in CI

Most common: missing `claude` CLI in CI. Add `npm i -g @anthropic-ai/claude-code` to the workflow. Second most common: missing API keys (set them as repo secrets and inject via `env:`). Third: Ollama not running (start it as a background process before the bench step).

# CI

Run benchmarks on every PR, fail the build if quality regresses, post a markdown summary.

## GitHub Actions

`eb init --ci` generates `.github/workflows/eval-bench.yml`:

```yaml
name: eval-bench

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
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm i -g @anthropic-ai/claude-code
      - uses: actions/cache@v4
        with:
          path: ~/.ollama/models
          key: ollama-qwen2.5-14b
      - run: curl -fsSL https://ollama.com/install.sh | sh
      - run: |
          ollama serve &
          sleep 2
          ollama pull qwen2.5:14b
      - run: |
          npx eval-bench run \
            --baseline origin/main \
            --current HEAD \
            --save-as pr-${{ github.event.pull_request.number }} \
            --fail-on-regression 0.05
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: benchmark-results
          path: .eval-bench/snapshots/
```

Pin actions to a SHA in production per your security policy.

## Posting a markdown summary

Add a step that emits to `$GITHUB_STEP_SUMMARY`:

```yaml
- name: Post comparison summary
  if: always()
  run: |
    npx eval-bench compare main-baseline pr-${{ github.event.pull_request.number }} --format md >> $GITHUB_STEP_SUMMARY
```

This requires you to have published a `main-baseline` snapshot (e.g. via a nightly cron job) and committed it to git.

## Caching the Ollama judge model

Pulling a 14B Q4 model (~5 GB) every PR is wasteful. Use `actions/cache` with key tied to the model name. First run pulls and caches; subsequent runs are instant.

## GitLab CI

```yaml
bench:
  image: node:20
  script:
    - apt-get update && apt-get install -y curl
    - npm i -g @anthropic-ai/claude-code eval-bench
    - curl -fsSL https://ollama.com/install.sh | sh
    - ollama serve &
    - sleep 2 && ollama pull qwen2.5:14b
    - eval-bench run --baseline origin/main --current HEAD --save-as pr-$CI_MERGE_REQUEST_IID --fail-on-regression 0.05
  artifacts:
    paths:
      - .eval-bench/snapshots/
  cache:
    paths:
      - ~/.ollama/models
```

## Self-hosted GPU runner

CPU-only judging on standard runners is fine for small prompt sets but slow at 14B+. For larger eval suites, a self-hosted runner with a GPU and a pre-loaded Ollama model is 50–100x faster. Start Ollama as a service on the runner and skip the install/pull steps in the workflow.

## Choosing thresholds

`--fail-on-regression 0.05` means: fail if the *net* delta drops by more than 0.05 points (out of 5). With 5 prompts and `samples: 3`, that's tighter than judge noise; you'll see false positives. Realistic thresholds:
- Small eval set (3–5 prompts): `0.15`
- Medium (10–20 prompts): `0.10`
- Large (50+ prompts): `0.05`

Tune by running the same baseline twice and observing the no-change net delta — set the threshold above that floor.

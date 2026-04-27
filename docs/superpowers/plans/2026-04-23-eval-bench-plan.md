# eval-bench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `eval-bench` — an npm-distributed CLI that benchmarks a Claude Code **plugin** (any combination of skills, subagents, MCP servers, slash commands, and hooks) by running prompts against two plugin versions, grading outputs with a configurable LLM judge (local Ollama, Anthropic, OpenAI, or any OpenAI-compatible endpoint), and producing a comparison report. The tool drives the real `claude` CLI so the full plugin manifest loads — skills register, MCP servers start, subagents wire up, hooks fire — making the benchmark reflect actual end-to-end behavior, not isolated component tests.

**Architecture:** TypeScript monorepo-free package. CLI (commander) wraps a core library. Plugin versions are swapped by creating a git worktree at the baseline ref and invoking `claude -p` with the EVAL_BENCH_PLUGIN_DIR env var pointed at the right directory. Judges share a single OpenAI-compatible HTTP client; Anthropic has its own thin client. Results are stored as JSON snapshots; comparisons are markdown + JSON.

**Tech Stack:** Node 20+, TypeScript (ESM), commander, zod, yaml, execa, chalk, vitest, prettier, eslint. Dev dep: tsx. Packaging: npm (CJS + ESM dual).

**Companion spec:** `docs/superpowers/specs/2026-04-23-eval-bench-spec.md`

---

## File Structure

```
eval-bench/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── .eslintrc.cjs
├── .prettierrc
├── .gitignore
├── README.md
├── LICENSE
├── src/
│   ├── cli/
│   │   ├── index.ts              # bin entry; wires commander
│   │   ├── init.ts               # `ef init` handler
│   │   ├── run.ts                # `ef run` handler
│   │   ├── view.ts               # `ef view` handler
│   │   ├── snapshot.ts           # `ef snapshot` handler
│   │   └── compare.ts            # `ef compare` handler
│   ├── types.ts                  # shared type definitions
│   ├── config.ts                 # load/validate eval-bench.yaml
│   ├── prompts.ts                # load/validate prompts.yaml
│   ├── swap.ts                   # git worktree lifecycle
│   ├── provider.ts               # invoke `claude -p` subprocess
│   ├── judges/
│   │   ├── index.ts              # dispatch by provider name
│   │   ├── rubric.ts             # build judge prompt from rubric + output
│   │   ├── parse.ts              # parse judge response into {score, rationale}
│   │   ├── ollama.ts
│   │   ├── anthropic.ts
│   │   ├── openai.ts
│   │   └── openai-compatible.ts
│   ├── run.ts                    # orchestrate matrix, invoke provider+judge
│   ├── snapshot.ts               # read/write snapshot JSON
│   ├── compare.ts                # diff two snapshots, format markdown
│   └── logger.ts                 # chalk-colored progress output
├── templates/
│   ├── eval-bench.yaml          # scaffolded by `ef init`
│   ├── prompts.yaml              # scaffolded by `ef init`
│   └── github-action.yml         # scaffolded by `ef init --ci`
├── tests/
│   └── (mirrors src/)
└── docs/
    ├── quickstart.md
    ├── concepts.md
    ├── config.md
    ├── rubrics.md
    ├── judges.md
    ├── ci.md
    ├── troubleshooting.md
    └── comparison-to-promptfoo.md
```

Every task below lists **exact files to create or modify** and produces a **commit**. The cadence is TDD: red → green → commit. Each commit is expected to leave the tree in a working state (package builds, tests pass).

---

## Phase 1 — Scaffold

### Task 1: Initialize npm package with TypeScript + Vitest

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/index.ts`
- Create: `tests/smoke.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/smoke.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { version } from '../src/index.js';

describe('smoke', () => {
  it('exports a version string', () => {
    expect(typeof version).toBe('string');
    expect(version.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run`
Expected: FAIL — cannot find module `../src/index.js`.

- [ ] **Step 3: Create package scaffolding**

`package.json`:
```json
{
  "name": "eval-bench",
  "version": "0.1.0",
  "description": "Benchmark Claude Code plugins by A/B comparing plugin versions with LLM-judged evaluation prompts.",
  "license": "MIT",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "bin": {
    "eval-bench": "dist/cli/index.js",
    "ef": "dist/cli/index.js"
  },
  "files": ["dist", "templates", "README.md", "LICENSE"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint 'src/**/*.ts' 'tests/**/*.ts'",
    "format": "prettier --write 'src/**/*.ts' 'tests/**/*.ts'",
    "prepublishOnly": "npm run build"
  },
  "dependencies": {
    "commander": "^12.1.0",
    "zod": "^3.23.8",
    "yaml": "^2.5.0",
    "execa": "^9.4.0",
    "chalk": "^5.3.0",
    "tmp": "^0.2.3"
  },
  "devDependencies": {
    "typescript": "^5.5.4",
    "tsx": "^4.19.0",
    "vitest": "^2.0.5",
    "@types/node": "^20.14.14",
    "@types/tmp": "^0.2.6",
    "eslint": "^9.9.0",
    "@typescript-eslint/parser": "^8.1.0",
    "@typescript-eslint/eslint-plugin": "^8.1.0",
    "prettier": "^3.3.3"
  },
  "engines": {
    "node": ">=20"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "sourceMap": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

`vitest.config.ts`:
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
  },
});
```

`src/index.ts`:
```typescript
export const version = '0.1.0';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm install && npx vitest run`
Expected: PASS — 1 test.

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts src/index.ts tests/smoke.test.ts
git commit -m "chore: scaffold npm package with TypeScript and Vitest"
```

---

### Task 2: Add lint, format, and .gitignore

**Files:**
- Create: `.eslintrc.cjs`
- Create: `.prettierrc`
- Create: `.gitignore`
- Create: `README.md` (stub)
- Create: `LICENSE` (MIT)

- [ ] **Step 1: Write the failing test**

`tests/lint.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';

describe('project hygiene', () => {
  it('has a .gitignore that excludes dist and node_modules', () => {
    expect(existsSync('.gitignore')).toBe(true);
    const contents = readFileSync('.gitignore', 'utf8');
    expect(contents).toMatch(/node_modules/);
    expect(contents).toMatch(/dist/);
  });
  it('has a README', () => {
    expect(existsSync('README.md')).toBe(true);
  });
  it('has a LICENSE', () => {
    expect(existsSync('LICENSE')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lint.test.ts`
Expected: FAIL — files missing.

- [ ] **Step 3: Create the files**

`.gitignore`:
```
node_modules/
dist/
*.log
.DS_Store
snapshots/
```

`.eslintrc.cjs`:
```javascript
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: { node: true, es2022: true },
  ignorePatterns: ['dist', 'node_modules'],
  rules: {
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
  },
};
```

`.prettierrc`:
```json
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2
}
```

`README.md` (stub — full content in Task 25):
```markdown
# eval-bench

Benchmark Claude Code plugins by A/B comparing plugin versions with LLM-judged evaluation prompts.

Status: pre-alpha. See `docs/quickstart.md` for setup.
```

`LICENSE`:
```
MIT License

Copyright (c) 2026 <author>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/lint.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add .gitignore .eslintrc.cjs .prettierrc README.md LICENSE tests/lint.test.ts
git commit -m "chore: add lint, format, gitignore, readme stub, and license"
```

---

### Task 3: CLI entry point skeleton

**Files:**
- Create: `src/cli/index.ts`
- Create: `tests/cli.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/cli.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { execa } from 'execa';

describe('cli', () => {
  it('prints help with --help', async () => {
    const result = await execa('npx', ['tsx', 'src/cli/index.ts', '--help']);
    expect(result.stdout).toMatch(/Usage: eval-bench/);
    expect(result.stdout).toMatch(/init/);
    expect(result.stdout).toMatch(/run/);
    expect(result.stdout).toMatch(/compare/);
  });

  it('prints version with --version', async () => {
    const result = await execa('npx', ['tsx', 'src/cli/index.ts', '--version']);
    expect(result.stdout.trim()).toBe('0.1.0');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli.test.ts`
Expected: FAIL — cannot find `src/cli/index.ts`.

- [ ] **Step 3: Create the CLI entry**

`src/cli/index.ts`:
```typescript
#!/usr/bin/env node
import { Command } from 'commander';
import { version } from '../index.js';

const program = new Command();

program
  .name('eval-bench')
  .description('Benchmark Claude Code plugins by A/B comparing plugin versions with LLM judging.')
  .version(version);

program
  .command('init')
  .description('Scaffold a benchmark config in the current directory.')
  .option('--ci', 'Also emit a GitHub Actions workflow')
  .action(async (_opts) => {
    throw new Error('not implemented yet');
  });

program
  .command('run')
  .description('Run a benchmark against the plugin.')
  .option('--plugin <path>', 'Path to plugin')
  .option('--baseline <ref>', 'Git ref for baseline')
  .option('--current <ref>', 'Git ref for current', 'HEAD')
  .option('--prompts <file>', 'Prompts file', './prompts.yaml')
  .option('--config <file>', 'Config file', './eval-bench.yaml')
  .option('--samples <n>', 'Override samples-per-prompt', (v) => parseInt(v, 10))
  .option('--judge <spec>', 'Override judge, e.g. ollama:qwen2.5:14b')
  .option('--save-as <name>', 'Save snapshot under this name')
  .option('--compare <name>', 'After running, compare against this snapshot')
  .option('--fail-on-regression <n>', 'Exit nonzero if net score drops more than <n>', parseFloat)
  .option('--dry-run', 'Print planned matrix without running')
  .option('-v, --verbose')
  .action(async (_opts) => {
    throw new Error('not implemented yet');
  });

program
  .command('view [snapshot]')
  .description('Open the Promptfoo web UI on a snapshot.')
  .action(async (_snapshot) => {
    throw new Error('not implemented yet');
  });

const snapshot = program.command('snapshot').description('Manage saved snapshots.');
snapshot
  .command('list')
  .action(async () => {
    throw new Error('not implemented yet');
  });
snapshot
  .command('save <name>')
  .action(async (_name) => {
    throw new Error('not implemented yet');
  });
snapshot
  .command('rm <name>')
  .action(async (_name) => {
    throw new Error('not implemented yet');
  });
snapshot
  .command('show <name>')
  .action(async (_name) => {
    throw new Error('not implemented yet');
  });

program
  .command('compare <a> <b>')
  .description('Compare two snapshots.')
  .option('--format <fmt>', 'md | json | both', 'md')
  .option('--out <path>', 'Write to file (default: stdout)')
  .option('--threshold <n>', 'Only show prompts where score delta > <n>', parseFloat)
  .action(async (_a, _b, _opts) => {
    throw new Error('not implemented yet');
  });

program.parseAsync().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cli.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/cli/index.ts tests/cli.test.ts
git commit -m "feat(cli): add commander-based CLI skeleton with all subcommands"
```

---

## Phase 2 — Types, config, prompts

### Task 4: Define shared types

**Files:**
- Create: `src/types.ts`
- Create: `tests/types.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/types.test.ts`:
```typescript
import { describe, it, expectTypeOf } from 'vitest';
import type { Config, PromptSpec, RunResult, Judgment, Snapshot, Comparison } from '../src/types.js';

describe('types', () => {
  it('Config shape', () => {
    expectTypeOf<Config['plugin']['path']>().toBeString();
    expectTypeOf<Config['judge']['provider']>().toEqualTypeOf<
      'ollama' | 'anthropic' | 'openai' | 'openai-compatible'
    >();
    expectTypeOf<Config['runs']['samples']>().toBeNumber();
  });
  it('RunResult discriminated by variant', () => {
    expectTypeOf<RunResult['variant']>().toEqualTypeOf<'baseline' | 'current'>();
  });
  it('Snapshot contains runs and judgments', () => {
    expectTypeOf<Snapshot['runs']>().toEqualTypeOf<RunResult[]>();
    expectTypeOf<Snapshot['judgments']>().toEqualTypeOf<Judgment[]>();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/types.test.ts`
Expected: FAIL — cannot find `src/types.js`.

- [ ] **Step 3: Create the types**

`src/types.ts`:
```typescript
export type JudgeProvider = 'ollama' | 'anthropic' | 'openai' | 'openai-compatible';

export interface Config {
  plugin: {
    path: string;
    gitRoot: string;
  };
  provider: {
    command: string;
    extraArgs: string[];
    timeout: number;
    model: string | null;
    allowedTools: string[] | null;
  };
  judge: {
    provider: JudgeProvider;
    model: string;
    endpoint: string | null;
    apiKeyEnv: string | null;
    temperature: number;
    maxTokens: number;
  };
  runs: {
    samples: number;
    parallel: number;
  };
  snapshots: {
    dir: string;
  };
}

export interface PromptSpec {
  id: string;
  prompt: string;
  rubric: string;
}

export type Variant = 'baseline' | 'current';

export interface RunResult {
  id: string;
  promptId: string;
  variant: Variant;
  sample: number;
  output: string;
  durationMs: number;
  exitCode: number;
  error: string | null;
}

export interface Judgment {
  runId: string;
  score: number;
  rationale: string;
  rubricHash: string;
  judgeProvider: JudgeProvider;
  judgeModel: string;
  raw: string;
}

export interface SummaryStats {
  n: number;
  mean: number;
  median: number;
  variance: number;
}

export interface Snapshot {
  schemaVersion: 1;
  name: string;
  createdAt: string;
  plugin: {
    path: string;
    baselineRef: string;
    baselineSha: string;
    currentRef: string;
    currentSha: string;
  };
  config: Config;
  judge: {
    provider: JudgeProvider;
    model: string;
  };
  prompts: PromptSpec[];
  runs: RunResult[];
  judgments: Judgment[];
  summary: {
    baseline: SummaryStats;
    current: SummaryStats;
    delta: number;
  };
}

export interface PromptDelta {
  promptId: string;
  baselineMean: number;
  currentMean: number;
  delta: number;
  verdict: 'improved' | 'stable' | 'regressed';
}

export interface Comparison {
  from: string;
  to: string;
  netDelta: number;
  improvements: PromptDelta[];
  stable: PromptDelta[];
  regressions: PromptDelta[];
  perPrompt: PromptDelta[];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/types.test.ts && npm run build`
Expected: PASS + clean build.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts tests/types.test.ts
git commit -m "feat(types): define Config, PromptSpec, RunResult, Judgment, Snapshot, Comparison"
```

---

### Task 5: Config loader with zod

**Files:**
- Create: `src/config.ts`
- Create: `tests/config.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/config.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

function writeTempYaml(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ef-test-'));
  const path = join(dir, 'eval-bench.yaml');
  writeFileSync(path, content);
  return path;
}

describe('loadConfig', () => {
  it('applies defaults for a minimal config', () => {
    const path = writeTempYaml(`
judge:
  provider: ollama
  model: qwen2.5:14b
  endpoint: http://localhost:11434
`);
    const cfg = loadConfig(path);
    expect(cfg.plugin.path).toBe('./');
    expect(cfg.runs.samples).toBe(3);
    expect(cfg.runs.parallel).toBe(2);
    expect(cfg.judge.temperature).toBe(0);
    expect(cfg.snapshots.dir).toBe('./snapshots');
  });

  it('rejects invalid judge provider', () => {
    const path = writeTempYaml(`
judge:
  provider: bogus
  model: x
`);
    expect(() => loadConfig(path)).toThrow(/judge.provider/);
  });

  it('requires endpoint for ollama', () => {
    const path = writeTempYaml(`
judge:
  provider: ollama
  model: qwen2.5:14b
`);
    expect(() => loadConfig(path)).toThrow(/endpoint/);
  });

  it('requires endpoint for openai-compatible', () => {
    const path = writeTempYaml(`
judge:
  provider: openai-compatible
  model: mistral
`);
    expect(() => loadConfig(path)).toThrow(/endpoint/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — cannot find `src/config.js`.

- [ ] **Step 3: Implement the loader**

`src/config.ts`:
```typescript
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import type { Config } from './types.js';

const ConfigSchema = z
  .object({
    plugin: z
      .object({
        path: z.string().default('./'),
        gitRoot: z.string().optional(),
      })
      .default({}),
    provider: z
      .object({
        command: z.string().default('claude'),
        extraArgs: z.array(z.string()).default([]),
        timeout: z.number().int().positive().default(180),
        model: z.string().nullable().default(null),
        allowedTools: z.array(z.string()).nullable().default(null),
      })
      .default({}),
    judge: z.object({
      provider: z.enum(['ollama', 'anthropic', 'openai', 'openai-compatible']),
      model: z.string().min(1),
      endpoint: z.string().nullable().default(null),
      apiKeyEnv: z.string().nullable().default(null),
      temperature: z.number().default(0),
      maxTokens: z.number().int().positive().default(1024),
    }),
    runs: z
      .object({
        samples: z.number().int().positive().default(3),
        parallel: z.number().int().positive().default(2),
      })
      .default({}),
    snapshots: z
      .object({
        dir: z.string().default('./snapshots'),
      })
      .default({}),
  })
  .superRefine((cfg, ctx) => {
    if ((cfg.judge.provider === 'ollama' || cfg.judge.provider === 'openai-compatible') && !cfg.judge.endpoint) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['judge', 'endpoint'],
        message: `judge.endpoint is required when judge.provider is "${cfg.judge.provider}"`,
      });
    }
  });

export function loadConfig(path: string): Config {
  const raw = readFileSync(path, 'utf8');
  const data = parse(raw);
  const parsed = ConfigSchema.parse(data);
  return {
    ...parsed,
    plugin: {
      path: parsed.plugin.path,
      gitRoot: parsed.plugin.gitRoot ?? parsed.plugin.path,
    },
  } satisfies Config;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat(config): load and validate eval-bench.yaml with zod"
```

---

### Task 6: Prompts loader

**Files:**
- Create: `src/prompts.ts`
- Create: `tests/prompts.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/prompts.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPrompts } from '../src/prompts.js';

function writeTempYaml(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ef-test-'));
  const path = join(dir, 'prompts.yaml');
  writeFileSync(path, content);
  return path;
}

describe('loadPrompts', () => {
  it('parses a valid prompts file', () => {
    const path = writeTempYaml(`
- id: p1
  prompt: "Hello"
  rubric: "Score 0-5"
- id: p2
  prompt: "World"
  rubric: "Score 0-5"
`);
    const prompts = loadPrompts(path);
    expect(prompts).toHaveLength(2);
    expect(prompts[0].id).toBe('p1');
  });

  it('rejects duplicate ids', () => {
    const path = writeTempYaml(`
- id: p1
  prompt: "a"
  rubric: "r"
- id: p1
  prompt: "b"
  rubric: "r"
`);
    expect(() => loadPrompts(path)).toThrow(/duplicate prompt id: p1/);
  });

  it('rejects empty prompt', () => {
    const path = writeTempYaml(`
- id: p1
  prompt: ""
  rubric: "r"
`);
    expect(() => loadPrompts(path)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/prompts.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the loader**

`src/prompts.ts`:
```typescript
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import type { PromptSpec } from './types.js';

const PromptSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'prompt id must be kebab-case'),
  prompt: z.string().min(1),
  rubric: z.string().min(1),
});

const PromptsSchema = z.array(PromptSchema).min(1);

export function loadPrompts(path: string): PromptSpec[] {
  const raw = readFileSync(path, 'utf8');
  const data = parse(raw);
  const prompts = PromptsSchema.parse(data);
  const seen = new Set<string>();
  for (const p of prompts) {
    if (seen.has(p.id)) {
      throw new Error(`duplicate prompt id: ${p.id}`);
    }
    seen.add(p.id);
  }
  return prompts;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/prompts.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/prompts.ts tests/prompts.test.ts
git commit -m "feat(prompts): load and validate prompts.yaml; enforce unique kebab-case ids"
```

---

## Phase 3 — Plugin-version swap via git worktree

### Task 7: Git worktree helper

**Files:**
- Create: `src/swap.ts`
- Create: `tests/swap.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/swap.test.ts`:
```typescript
import { describe, it, expect, afterAll } from 'vitest';
import { execa } from 'execa';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorktree, resolveSha } from '../src/swap.js';

async function makeRepo(): Promise<{ root: string; sha1: string; sha2: string }> {
  const root = mkdtempSync(join(tmpdir(), 'ef-git-'));
  await execa('git', ['init', '-q'], { cwd: root });
  await execa('git', ['config', 'user.email', 't@t'], { cwd: root });
  await execa('git', ['config', 'user.name', 't'], { cwd: root });
  writeFileSync(join(root, 'a.txt'), 'v1');
  await execa('git', ['add', '.'], { cwd: root });
  await execa('git', ['commit', '-m', 'v1', '-q'], { cwd: root });
  const { stdout: sha1 } = await execa('git', ['rev-parse', 'HEAD'], { cwd: root });
  writeFileSync(join(root, 'a.txt'), 'v2');
  await execa('git', ['commit', '-am', 'v2', '-q'], { cwd: root });
  const { stdout: sha2 } = await execa('git', ['rev-parse', 'HEAD'], { cwd: root });
  return { root, sha1: sha1.trim(), sha2: sha2.trim() };
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const c of cleanups) await c();
});

describe('swap', () => {
  it('resolves a ref to a SHA', async () => {
    const { root, sha2 } = await makeRepo();
    expect(await resolveSha(root, 'HEAD')).toBe(sha2);
  });

  it('creates a worktree at a given ref and cleans up', async () => {
    const { root, sha1 } = await makeRepo();
    const wt = await createWorktree(root, sha1);
    cleanups.push(() => wt.cleanup());
    expect(existsSync(join(wt.path, 'a.txt'))).toBe(true);
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(join(wt.path, 'a.txt'), 'utf8')).toBe('v1');
    await wt.cleanup();
    expect(existsSync(wt.path)).toBe(false);
  });

  it('rejects a non-existent ref', async () => {
    const { root } = await makeRepo();
    await expect(createWorktree(root, 'does-not-exist')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/swap.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the helper**

`src/swap.ts`:
```typescript
import { execa } from 'execa';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Worktree {
  path: string;
  sha: string;
  cleanup: () => Promise<void>;
}

export async function resolveSha(gitRoot: string, ref: string): Promise<string> {
  const { stdout } = await execa('git', ['rev-parse', '--verify', ref], { cwd: gitRoot });
  return stdout.trim();
}

export async function createWorktree(gitRoot: string, ref: string): Promise<Worktree> {
  const sha = await resolveSha(gitRoot, ref);
  const wtPath = mkdtempSync(join(tmpdir(), 'ef-wt-'));
  await execa('git', ['worktree', 'add', '--detach', wtPath, sha], { cwd: gitRoot });
  return {
    path: wtPath,
    sha,
    cleanup: async () => {
      await execa('git', ['worktree', 'remove', '--force', wtPath], { cwd: gitRoot }).catch(() => {
        /* best effort */
      });
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/swap.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/swap.ts tests/swap.test.ts
git commit -m "feat(swap): create and clean up git worktrees for plugin-version isolation"
```

---

## Phase 4 — Claude provider

### Task 8: invokeClaude subprocess shim

**Files:**
- Create: `src/provider.ts`
- Create: `tests/provider.test.ts`
- Create: `tests/fixtures/fake-claude.js`

- [ ] **Step 1: Write the failing test**

`tests/fixtures/fake-claude.js`:
```javascript
#!/usr/bin/env node
// Minimal stand-in for `claude -p`: echoes the last arg, plus env-var marker.
const args = process.argv.slice(2);
const promptIdx = args.indexOf('-p');
const prompt = promptIdx >= 0 ? args[promptIdx + 1] : '';
console.log(`[PLUGIN_DIR=${process.env.EVAL_BENCH_PLUGIN_DIR ?? ''}] ${prompt}`);
process.exit(0);
```

`tests/provider.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { invokeClaude } from '../src/provider.js';

const fakeClaude = resolve('tests/fixtures/fake-claude.js');
chmodSync(fakeClaude, 0o755);

describe('invokeClaude', () => {
  it('captures stdout and succeeds with exit 0', async () => {
    const r = await invokeClaude({
      command: 'node',
      extraArgs: [fakeClaude],
      prompt: 'hello world',
      pluginDir: '/tmp/fake-plugin',
      timeoutMs: 5000,
      model: null,
      allowedTools: null,
    });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('hello world');
    expect(r.output).toContain('/tmp/fake-plugin');
    expect(r.error).toBeNull();
    expect(r.durationMs).toBeGreaterThan(0);
  });

  it('records error and non-zero exit on timeout', async () => {
    // Use `node -e 'setTimeout(()=>{},10000)'` to force a hang
    const r = await invokeClaude({
      command: 'node',
      extraArgs: ['-e', 'setTimeout(()=>{}, 10000)'],
      prompt: 'x',
      pluginDir: '/tmp/x',
      timeoutMs: 200,
      model: null,
      allowedTools: null,
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.error).toMatch(/timed out|killed|SIGTERM/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/provider.test.ts`
Expected: FAIL — cannot find `src/provider.js`.

- [ ] **Step 3: Implement**

`src/provider.ts`:
```typescript
import { execa } from 'execa';

export interface InvokeClaudeOptions {
  command: string;
  extraArgs: string[];
  prompt: string;
  pluginDir: string;
  timeoutMs: number;
  model: string | null;
  allowedTools: string[] | null;
}

export interface InvokeClaudeResult {
  output: string;
  exitCode: number;
  durationMs: number;
  error: string | null;
}

export async function invokeClaude(opts: InvokeClaudeOptions): Promise<InvokeClaudeResult> {
  const args = [...opts.extraArgs, '-p', opts.prompt];
  if (opts.model) {
    args.push('--model', opts.model);
  }
  if (opts.allowedTools && opts.allowedTools.length > 0) {
    args.push('--allowed-tools', opts.allowedTools.join(','));
  }
  const started = Date.now();
  try {
    const result = await execa(opts.command, args, {
      timeout: opts.timeoutMs,
      reject: false,
      env: {
        ...process.env,
        EVAL_BENCH_PLUGIN_DIR: opts.pluginDir,
      },
    });
    const durationMs = Date.now() - started;
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    if (result.timedOut) {
      return { output, exitCode: result.exitCode ?? -1, durationMs, error: 'timed out' };
    }
    if (result.exitCode !== 0) {
      return { output, exitCode: result.exitCode ?? -1, durationMs, error: result.stderr || 'non-zero exit' };
    }
    return { output, exitCode: 0, durationMs, error: null };
  } catch (err) {
    const durationMs = Date.now() - started;
    const msg = err instanceof Error ? err.message : String(err);
    return { output: '', exitCode: -1, durationMs, error: msg };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/provider.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/provider.ts tests/provider.test.ts tests/fixtures/fake-claude.js
git commit -m "feat(provider): invoke claude -p subprocess with plugin-dir env, timeout, and tool control"
```

---

## Phase 5 — Judges

### Task 9: Judge rubric prompt builder and response parser

**Files:**
- Create: `src/judges/rubric.ts`
- Create: `src/judges/parse.ts`
- Create: `tests/judges/rubric.test.ts`
- Create: `tests/judges/parse.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/judges/rubric.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { buildJudgePrompt, hashRubric } from '../../src/judges/rubric.js';

describe('buildJudgePrompt', () => {
  it('includes the original prompt, output, and rubric', () => {
    const p = buildJudgePrompt({
      prompt: 'List products',
      output: 'A, B, C',
      rubric: 'Score 0-5',
    });
    expect(p).toContain('List products');
    expect(p).toContain('A, B, C');
    expect(p).toContain('Score 0-5');
    expect(p).toMatch(/Return ONLY.*JSON/i);
  });
});

describe('hashRubric', () => {
  it('returns a stable sha256 hex string', () => {
    expect(hashRubric('foo')).toBe(hashRubric('foo'));
    expect(hashRubric('foo')).not.toBe(hashRubric('bar'));
    expect(hashRubric('foo')).toMatch(/^[a-f0-9]{64}$/);
  });
});
```

`tests/judges/parse.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { parseJudgeResponse } from '../../src/judges/parse.js';

describe('parseJudgeResponse', () => {
  it('parses a well-formed JSON response', () => {
    const { score, rationale } = parseJudgeResponse('{"score": 4.2, "rationale": "good"}');
    expect(score).toBe(4.2);
    expect(rationale).toBe('good');
  });

  it('extracts JSON from a ```json fenced block', () => {
    const input = 'Sure!\n```json\n{"score": 3, "rationale": "ok"}\n```\n';
    const { score } = parseJudgeResponse(input);
    expect(score).toBe(3);
  });

  it('throws on malformed output', () => {
    expect(() => parseJudgeResponse('not json')).toThrow(/parse/i);
  });

  it('clamps score to 0..5 range', () => {
    expect(parseJudgeResponse('{"score": 9, "rationale": "x"}').score).toBe(5);
    expect(parseJudgeResponse('{"score": -2, "rationale": "x"}').score).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/judges`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/judges/rubric.ts`:
```typescript
import { createHash } from 'node:crypto';

const TEMPLATE = `You are an impartial evaluator. You are given a PROMPT, an assistant's OUTPUT,
and a RUBRIC describing what a good output looks like. Grade the OUTPUT strictly by
the RUBRIC.

Return ONLY a JSON object on a single line with exactly these fields:
  "score":     number in [0, 5]  (can be fractional, e.g. 3.5)
  "rationale": string (1-3 sentences explaining the score)

Do not include any other text.

-----
PROMPT:
{{prompt}}
-----
OUTPUT:
{{output}}
-----
RUBRIC:
{{rubric}}
-----
`;

export function buildJudgePrompt(opts: { prompt: string; output: string; rubric: string }): string {
  return TEMPLATE.replace('{{prompt}}', opts.prompt)
    .replace('{{output}}', opts.output)
    .replace('{{rubric}}', opts.rubric);
}

export function hashRubric(rubric: string): string {
  return createHash('sha256').update(rubric).digest('hex');
}
```

`src/judges/parse.ts`:
```typescript
export interface ParsedJudgment {
  score: number;
  rationale: string;
}

const FENCE_RE = /```(?:json)?\s*([\s\S]*?)```/i;

export function parseJudgeResponse(raw: string): ParsedJudgment {
  let candidate = raw.trim();
  const fenceMatch = candidate.match(FENCE_RE);
  if (fenceMatch) {
    candidate = fenceMatch[1].trim();
  } else {
    // try to grab the first {...} block
    const firstBrace = candidate.indexOf('{');
    const lastBrace = candidate.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      candidate = candidate.slice(firstBrace, lastBrace + 1);
    }
  }
  let obj: unknown;
  try {
    obj = JSON.parse(candidate);
  } catch (err) {
    throw new Error(`judge response: could not parse JSON (${(err as Error).message})`);
  }
  if (typeof obj !== 'object' || obj === null) {
    throw new Error('judge response: JSON root must be an object');
  }
  const { score, rationale } = obj as { score?: unknown; rationale?: unknown };
  if (typeof score !== 'number' || Number.isNaN(score)) {
    throw new Error('judge response: missing or non-numeric "score"');
  }
  if (typeof rationale !== 'string') {
    throw new Error('judge response: missing string "rationale"');
  }
  const clamped = Math.max(0, Math.min(5, score));
  return { score: clamped, rationale };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/judges`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/judges/rubric.ts src/judges/parse.ts tests/judges/rubric.test.ts tests/judges/parse.test.ts
git commit -m "feat(judges): add rubric prompt template, stable rubric hash, and robust response parser"
```

---

### Task 10: Ollama judge

**Files:**
- Create: `src/judges/ollama.ts`
- Create: `tests/judges/ollama.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/judges/ollama.test.ts`:
```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { judgeWithOllama } from '../../src/judges/ollama.js';

let server: Server;
let baseUrl = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const reqJson = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          model: reqJson.model,
          message: {
            role: 'assistant',
            content: '{"score": 4.5, "rationale": "covers all points"}',
          },
          done: true,
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (typeof addr === 'object' && addr) baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('judgeWithOllama', () => {
  it('calls /api/chat and parses the response', async () => {
    const r = await judgeWithOllama({
      endpoint: baseUrl,
      model: 'qwen2.5:14b',
      temperature: 0,
      maxTokens: 256,
      prompt: 'list products',
      output: 'A, B, C',
      rubric: 'score 0-5',
    });
    expect(r.score).toBe(4.5);
    expect(r.rationale).toBe('covers all points');
    expect(r.raw).toContain('"score"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/judges/ollama.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/judges/ollama.ts`:
```typescript
import { buildJudgePrompt } from './rubric.js';
import { parseJudgeResponse, type ParsedJudgment } from './parse.js';

export interface OllamaJudgeOptions {
  endpoint: string;
  model: string;
  temperature: number;
  maxTokens: number;
  prompt: string;
  output: string;
  rubric: string;
}

export async function judgeWithOllama(
  opts: OllamaJudgeOptions,
): Promise<ParsedJudgment & { raw: string }> {
  const body = {
    model: opts.model,
    stream: false,
    options: { temperature: opts.temperature, num_predict: opts.maxTokens },
    messages: [
      { role: 'user', content: buildJudgePrompt(opts) },
    ],
    format: 'json',
  };
  const res = await fetch(`${opts.endpoint.replace(/\/+$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`ollama: HTTP ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { message?: { content?: string } };
  const raw = data.message?.content ?? '';
  const parsed = parseJudgeResponse(raw);
  return { ...parsed, raw };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/judges/ollama.test.ts`
Expected: PASS — 1 test.

- [ ] **Step 5: Commit**

```bash
git add src/judges/ollama.ts tests/judges/ollama.test.ts
git commit -m "feat(judges): add Ollama judge using /api/chat with JSON format"
```

---

### Task 11: Anthropic judge

**Files:**
- Create: `src/judges/anthropic.ts`
- Create: `tests/judges/anthropic.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/judges/anthropic.test.ts`:
```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { judgeWithAnthropic } from '../../src/judges/anthropic.js';

let server: Server;
let baseUrl = '';
let receivedAuth = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    receivedAuth = (req.headers['x-api-key'] as string) ?? '';
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: '{"score": 3.5, "rationale": "partial"}' }],
          stop_reason: 'end_turn',
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (typeof addr === 'object' && addr) baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('judgeWithAnthropic', () => {
  it('sends x-api-key and parses content[].text', async () => {
    const r = await judgeWithAnthropic({
      baseUrl,
      apiKey: 'sk-test',
      model: 'claude-opus-4-7',
      temperature: 0,
      maxTokens: 256,
      prompt: 'p',
      output: 'o',
      rubric: 'r',
    });
    expect(receivedAuth).toBe('sk-test');
    expect(r.score).toBe(3.5);
    expect(r.rationale).toBe('partial');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/judges/anthropic.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/judges/anthropic.ts`:
```typescript
import { buildJudgePrompt } from './rubric.js';
import { parseJudgeResponse, type ParsedJudgment } from './parse.js';

export interface AnthropicJudgeOptions {
  baseUrl?: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  prompt: string;
  output: string;
  rubric: string;
}

export async function judgeWithAnthropic(
  opts: AnthropicJudgeOptions,
): Promise<ParsedJudgment & { raw: string }> {
  const base = (opts.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '');
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': opts.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature,
      messages: [{ role: 'user', content: buildJudgePrompt(opts) }],
    }),
  });
  if (!res.ok) {
    throw new Error(`anthropic: HTTP ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  const raw = (data.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n');
  const parsed = parseJudgeResponse(raw);
  return { ...parsed, raw };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/judges/anthropic.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/judges/anthropic.ts tests/judges/anthropic.test.ts
git commit -m "feat(judges): add Anthropic judge against /v1/messages"
```

---

### Task 12: OpenAI judge

**Files:**
- Create: `src/judges/openai.ts`
- Create: `tests/judges/openai.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/judges/openai.test.ts`:
```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { judgeWithOpenAICompatible } from '../../src/judges/openai-compatible.js';

let server: Server;
let baseUrl = '';
let receivedAuth = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    receivedAuth = (req.headers['authorization'] as string) ?? '';
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            { message: { role: 'assistant', content: '{"score": 2.5, "rationale": "meh"}' } },
          ],
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (typeof addr === 'object' && addr) baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('judgeWithOpenAICompatible', () => {
  it('sends Authorization: Bearer and parses choices[0].message.content', async () => {
    const r = await judgeWithOpenAICompatible({
      endpoint: baseUrl,
      apiKey: 'sk-test',
      model: 'gpt-4o',
      temperature: 0,
      maxTokens: 256,
      prompt: 'p',
      output: 'o',
      rubric: 'r',
    });
    expect(receivedAuth).toBe('Bearer sk-test');
    expect(r.score).toBe(2.5);
    expect(r.rationale).toBe('meh');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/judges/openai.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

The OpenAI client and the OpenAI-compatible client are the same — OpenAI is just a pre-set endpoint. Task 13 creates the shared `openai-compatible.ts`; this task adds a thin wrapper. Deferring implementation of `openai-compatible.ts` to Task 13 means this test has a dependency; re-order would require moving Task 13 ahead of Task 12. Order chosen here: do Task 13 next, then come back and mark this green.

For now, create the OpenAI wrapper that will exist on top:

`src/judges/openai.ts`:
```typescript
import { judgeWithOpenAICompatible, type OpenAICompatibleJudgeOptions } from './openai-compatible.js';
import type { ParsedJudgment } from './parse.js';

export type OpenAIJudgeOptions = Omit<OpenAICompatibleJudgeOptions, 'endpoint'> & {
  endpoint?: string;
};

export async function judgeWithOpenAI(
  opts: OpenAIJudgeOptions,
): Promise<ParsedJudgment & { raw: string }> {
  return judgeWithOpenAICompatible({
    ...opts,
    endpoint: opts.endpoint ?? 'https://api.openai.com/v1',
  });
}
```

- [ ] **Step 4: Defer test run until after Task 13**

This test imports from `openai-compatible.ts`, which is implemented in Task 13. After completing Task 13, run:

Run: `npx vitest run tests/judges/openai.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit (after Task 13)**

```bash
git add src/judges/openai.ts tests/judges/openai.test.ts
git commit -m "feat(judges): add OpenAI judge wrapper over openai-compatible client"
```

---

### Task 13: OpenAI-compatible judge (shared client for OpenAI, HF endpoints, Groq, vLLM, llama.cpp server)

**Files:**
- Create: `src/judges/openai-compatible.ts`
- Create: `tests/judges/openai-compatible.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/judges/openai-compatible.test.ts`:
```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { judgeWithOpenAICompatible } from '../../src/judges/openai-compatible.js';

let server: Server;
let baseUrl = '';
let lastBody: any = null;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      lastBody = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            { message: { role: 'assistant', content: '{"score": 4, "rationale": "good"}' } },
          ],
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (typeof addr === 'object' && addr) baseUrl = `http://127.0.0.1:${addr.port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('judgeWithOpenAICompatible', () => {
  it('POSTs to /chat/completions with temperature and model', async () => {
    const r = await judgeWithOpenAICompatible({
      endpoint: baseUrl,
      apiKey: 'x',
      model: 'mistral-7b',
      temperature: 0.2,
      maxTokens: 128,
      prompt: 'p',
      output: 'o',
      rubric: 'r',
    });
    expect(r.score).toBe(4);
    expect(lastBody.model).toBe('mistral-7b');
    expect(lastBody.temperature).toBe(0.2);
    expect(lastBody.max_tokens).toBe(128);
  });

  it('works without apiKey (local endpoints like llama.cpp server)', async () => {
    const r = await judgeWithOpenAICompatible({
      endpoint: baseUrl,
      apiKey: null,
      model: 'local',
      temperature: 0,
      maxTokens: 128,
      prompt: 'p',
      output: 'o',
      rubric: 'r',
    });
    expect(r.score).toBe(4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/judges/openai-compatible.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/judges/openai-compatible.ts`:
```typescript
import { buildJudgePrompt } from './rubric.js';
import { parseJudgeResponse, type ParsedJudgment } from './parse.js';

export interface OpenAICompatibleJudgeOptions {
  endpoint: string;
  apiKey: string | null;
  model: string;
  temperature: number;
  maxTokens: number;
  prompt: string;
  output: string;
  rubric: string;
}

export async function judgeWithOpenAICompatible(
  opts: OpenAICompatibleJudgeOptions,
): Promise<ParsedJudgment & { raw: string }> {
  const base = opts.endpoint.replace(/\/+$/, '');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.apiKey) {
    headers['authorization'] = `Bearer ${opts.apiKey}`;
  }
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: opts.model,
      temperature: opts.temperature,
      max_tokens: opts.maxTokens,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: buildJudgePrompt(opts) }],
    }),
  });
  if (!res.ok) {
    throw new Error(`openai-compatible: HTTP ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = data.choices?.[0]?.message?.content ?? '';
  const parsed = parseJudgeResponse(raw);
  return { ...parsed, raw };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/judges/openai-compatible.test.ts tests/judges/openai.test.ts`
Expected: PASS — 3 tests total (2 new + 1 from Task 12).

- [ ] **Step 5: Commit**

```bash
git add src/judges/openai-compatible.ts tests/judges/openai-compatible.test.ts
git commit -m "feat(judges): add OpenAI-compatible judge client for OpenAI, HF, Groq, vLLM, llama.cpp"
```

---

### Task 14: Judge dispatcher

**Files:**
- Create: `src/judges/index.ts`
- Create: `tests/judges/index.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/judges/index.test.ts`:
```typescript
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { judge } from '../../src/judges/index.js';

let server: Server;
let baseUrl = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const isAnthropic = req.url?.includes('/v1/messages');
      res.writeHead(200, { 'content-type': 'application/json' });
      if (isAnthropic) {
        res.end(JSON.stringify({ content: [{ type: 'text', text: '{"score":3,"rationale":"x"}' }] }));
      } else if (req.url?.includes('/api/chat')) {
        res.end(JSON.stringify({ message: { content: '{"score":3,"rationale":"x"}' } }));
      } else {
        res.end(JSON.stringify({ choices: [{ message: { content: '{"score":3,"rationale":"x"}' } }] }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (typeof addr === 'object' && addr) baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('judge (dispatcher)', () => {
  it('dispatches to ollama', async () => {
    const r = await judge({
      provider: 'ollama',
      model: 'q',
      endpoint: baseUrl,
      apiKeyEnv: null,
      temperature: 0,
      maxTokens: 256,
    }, { prompt: 'p', output: 'o', rubric: 'r' });
    expect(r.score).toBe(3);
  });

  it('dispatches to openai-compatible', async () => {
    const r = await judge({
      provider: 'openai-compatible',
      model: 'm',
      endpoint: baseUrl + '/v1',
      apiKeyEnv: null,
      temperature: 0,
      maxTokens: 256,
    }, { prompt: 'p', output: 'o', rubric: 'r' });
    expect(r.score).toBe(3);
  });

  it('reads api key from apiKeyEnv', async () => {
    process.env.TEST_KEY = 'sk-xyz';
    const r = await judge({
      provider: 'anthropic',
      model: 'claude',
      endpoint: baseUrl,
      apiKeyEnv: 'TEST_KEY',
      temperature: 0,
      maxTokens: 256,
    }, { prompt: 'p', output: 'o', rubric: 'r' });
    expect(r.score).toBe(3);
    delete process.env.TEST_KEY;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/judges/index.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/judges/index.ts`:
```typescript
import type { Config, Judgment, JudgeProvider } from '../types.js';
import { hashRubric } from './rubric.js';
import { judgeWithOllama } from './ollama.js';
import { judgeWithAnthropic } from './anthropic.js';
import { judgeWithOpenAI } from './openai.js';
import { judgeWithOpenAICompatible } from './openai-compatible.js';

export interface JudgeInput {
  prompt: string;
  output: string;
  rubric: string;
}

export interface JudgeConfig {
  provider: JudgeProvider;
  model: string;
  endpoint: string | null;
  apiKeyEnv: string | null;
  temperature: number;
  maxTokens: number;
}

const DEFAULT_API_KEY_ENV: Record<JudgeProvider, string | null> = {
  ollama: null,
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  'openai-compatible': null,
};

export async function judge(
  cfg: JudgeConfig,
  input: JudgeInput,
): Promise<Omit<Judgment, 'runId'>> {
  const apiKeyEnv = cfg.apiKeyEnv ?? DEFAULT_API_KEY_ENV[cfg.provider];
  const apiKey = apiKeyEnv ? process.env[apiKeyEnv] ?? null : null;
  let res: { score: number; rationale: string; raw: string };
  switch (cfg.provider) {
    case 'ollama':
      if (!cfg.endpoint) throw new Error('ollama: endpoint required');
      res = await judgeWithOllama({
        endpoint: cfg.endpoint,
        model: cfg.model,
        temperature: cfg.temperature,
        maxTokens: cfg.maxTokens,
        ...input,
      });
      break;
    case 'anthropic':
      if (!apiKey) throw new Error(`anthropic: API key not set (env ${apiKeyEnv})`);
      res = await judgeWithAnthropic({
        baseUrl: cfg.endpoint ?? undefined,
        apiKey,
        model: cfg.model,
        temperature: cfg.temperature,
        maxTokens: cfg.maxTokens,
        ...input,
      });
      break;
    case 'openai':
      if (!apiKey) throw new Error(`openai: API key not set (env ${apiKeyEnv})`);
      res = await judgeWithOpenAI({
        endpoint: cfg.endpoint ?? undefined,
        apiKey,
        model: cfg.model,
        temperature: cfg.temperature,
        maxTokens: cfg.maxTokens,
        ...input,
      });
      break;
    case 'openai-compatible':
      if (!cfg.endpoint) throw new Error('openai-compatible: endpoint required');
      res = await judgeWithOpenAICompatible({
        endpoint: cfg.endpoint,
        apiKey,
        model: cfg.model,
        temperature: cfg.temperature,
        maxTokens: cfg.maxTokens,
        ...input,
      });
      break;
  }
  return {
    score: res.score,
    rationale: res.rationale,
    rubricHash: hashRubric(input.rubric),
    judgeProvider: cfg.provider,
    judgeModel: cfg.model,
    raw: res.raw,
  };
}

export function judgeConfigFromConfig(cfg: Config): JudgeConfig {
  return {
    provider: cfg.judge.provider,
    model: cfg.judge.model,
    endpoint: cfg.judge.endpoint,
    apiKeyEnv: cfg.judge.apiKeyEnv,
    temperature: cfg.judge.temperature,
    maxTokens: cfg.judge.maxTokens,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/judges/index.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/judges/index.ts tests/judges/index.test.ts
git commit -m "feat(judges): add dispatcher; resolve api keys from env; produce Judgment record"
```

---

## Phase 6 — Run orchestration

### Task 15: Expand the run matrix

**Files:**
- Create: `src/run.ts` (partial — matrix only)
- Create: `tests/run.matrix.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/run.matrix.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { expandMatrix } from '../src/run.js';
import type { PromptSpec } from '../src/types.js';

const prompts: PromptSpec[] = [
  { id: 'p1', prompt: 'x', rubric: 'r' },
  { id: 'p2', prompt: 'y', rubric: 'r' },
];

describe('expandMatrix', () => {
  it('produces prompts × variants × samples rows', () => {
    const m = expandMatrix(prompts, 2);
    expect(m).toHaveLength(2 * 2 * 2);
    expect(m.filter((r) => r.variant === 'baseline')).toHaveLength(4);
    expect(m.filter((r) => r.variant === 'current')).toHaveLength(4);
  });

  it('assigns stable ids of form <promptId>::<variant>::<sample>', () => {
    const m = expandMatrix(prompts, 1);
    const ids = m.map((r) => r.id).sort();
    expect(ids).toEqual([
      'p1::baseline::1',
      'p1::current::1',
      'p2::baseline::1',
      'p2::current::1',
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/run.matrix.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/run.ts`:
```typescript
import type { PromptSpec, Variant } from './types.js';

export interface MatrixRow {
  id: string;
  promptId: string;
  prompt: string;
  rubric: string;
  variant: Variant;
  sample: number;
}

export function expandMatrix(prompts: PromptSpec[], samples: number): MatrixRow[] {
  const rows: MatrixRow[] = [];
  const variants: Variant[] = ['baseline', 'current'];
  for (const p of prompts) {
    for (const v of variants) {
      for (let s = 1; s <= samples; s++) {
        rows.push({
          id: `${p.id}::${v}::${s}`,
          promptId: p.id,
          prompt: p.prompt,
          rubric: p.rubric,
          variant: v,
          sample: s,
        });
      }
    }
  }
  return rows;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/run.matrix.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/run.ts tests/run.matrix.test.ts
git commit -m "feat(run): expand prompts × variants × samples into a deterministic run matrix"
```

---

### Task 16: Concurrency-limited runner

**Files:**
- Modify: `src/run.ts` (add `runBenchmark`)
- Create: `tests/run.benchmark.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/run.benchmark.test.ts`:
```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer, type Server } from 'node:http';
import { runBenchmark } from '../src/run.js';
import type { Config, PromptSpec } from '../src/types.js';

let server: Server;
let judgeUrl = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          message: { content: '{"score": 4, "rationale": "ok"}' },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (typeof addr === 'object' && addr) judgeUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const fakeClaude = resolve('tests/fixtures/fake-claude.js');
chmodSync(fakeClaude, 0o755);

const prompts: PromptSpec[] = [{ id: 'p1', prompt: 'x', rubric: 'r' }];

function baseConfig(): Config {
  return {
    plugin: { path: '/tmp/plugin', gitRoot: '/tmp/plugin' },
    provider: {
      command: 'node',
      extraArgs: [fakeClaude],
      timeout: 30,
      model: null,
      allowedTools: null,
    },
    judge: {
      provider: 'ollama',
      model: 'q',
      endpoint: judgeUrl,
      apiKeyEnv: null,
      temperature: 0,
      maxTokens: 256,
    },
    runs: { samples: 2, parallel: 2 },
    snapshots: { dir: '/tmp/snaps' },
  };
}

describe('runBenchmark', () => {
  it('runs the full matrix and judges each output', async () => {
    const snap = await runBenchmark({
      config: baseConfig(),
      prompts,
      baselinePluginDir: '/tmp/a',
      currentPluginDir: '/tmp/b',
      baselineRef: 'v1',
      baselineSha: 'abc',
      currentRef: 'HEAD',
      currentSha: 'def',
      name: 'test',
    });
    expect(snap.runs).toHaveLength(4); // 1 prompt × 2 variants × 2 samples
    expect(snap.judgments).toHaveLength(4);
    expect(snap.judgments.every((j) => j.score === 4)).toBe(true);
    expect(snap.summary.baseline.n).toBe(2);
    expect(snap.summary.current.n).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/run.benchmark.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `runBenchmark` + helpers**

Append to `src/run.ts`:
```typescript
import { invokeClaude } from './provider.js';
import { judge, judgeConfigFromConfig } from './judges/index.js';
import type { Config, PromptSpec, RunResult, Judgment, Snapshot, SummaryStats } from './types.js';

export interface RunBenchmarkOptions {
  config: Config;
  prompts: PromptSpec[];
  baselinePluginDir: string;
  currentPluginDir: string;
  baselineRef: string;
  baselineSha: string;
  currentRef: string;
  currentSha: string;
  name: string;
  onProgress?: (ev: ProgressEvent) => void;
}

export type ProgressEvent =
  | { kind: 'run-start'; rowId: string }
  | { kind: 'run-end'; rowId: string; durationMs: number; error: string | null }
  | { kind: 'judge-start'; runId: string }
  | { kind: 'judge-end'; runId: string; score: number };

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

function stats(xs: number[]): SummaryStats {
  if (xs.length === 0) return { n: 0, mean: 0, median: 0, variance: 0 };
  const sorted = [...xs].sort((a, b) => a - b);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
  return { n: xs.length, mean, median, variance };
}

export async function runBenchmark(opts: RunBenchmarkOptions): Promise<Snapshot> {
  const matrix = expandMatrix(opts.prompts, opts.config.runs.samples);
  const runs = await mapWithConcurrency<MatrixRow, RunResult>(
    matrix,
    opts.config.runs.parallel,
    async (row) => {
      opts.onProgress?.({ kind: 'run-start', rowId: row.id });
      const pluginDir = row.variant === 'baseline' ? opts.baselinePluginDir : opts.currentPluginDir;
      const r = await invokeClaude({
        command: opts.config.provider.command,
        extraArgs: opts.config.provider.extraArgs,
        prompt: row.prompt,
        pluginDir,
        timeoutMs: opts.config.provider.timeout * 1000,
        model: opts.config.provider.model,
        allowedTools: opts.config.provider.allowedTools,
      });
      opts.onProgress?.({ kind: 'run-end', rowId: row.id, durationMs: r.durationMs, error: r.error });
      return {
        id: row.id,
        promptId: row.promptId,
        variant: row.variant,
        sample: row.sample,
        output: r.output,
        durationMs: r.durationMs,
        exitCode: r.exitCode,
        error: r.error,
      };
    },
  );

  const judgeCfg = judgeConfigFromConfig(opts.config);
  const judgments = await mapWithConcurrency<RunResult, Judgment>(
    runs,
    opts.config.runs.parallel,
    async (run) => {
      opts.onProgress?.({ kind: 'judge-start', runId: run.id });
      const prompt = opts.prompts.find((p) => p.id === run.promptId)!;
      if (run.error || run.output.length === 0) {
        return {
          runId: run.id,
          score: 0,
          rationale: `run failed: ${run.error ?? 'empty output'}`,
          rubricHash: '',
          judgeProvider: judgeCfg.provider,
          judgeModel: judgeCfg.model,
          raw: '',
        };
      }
      const j = await judge(judgeCfg, { prompt: prompt.prompt, output: run.output, rubric: prompt.rubric });
      opts.onProgress?.({ kind: 'judge-end', runId: run.id, score: j.score });
      return { runId: run.id, ...j };
    },
  );

  const scoreOf = (runId: string): number =>
    judgments.find((j) => j.runId === runId)?.score ?? 0;
  const baselineScores = runs.filter((r) => r.variant === 'baseline').map((r) => scoreOf(r.id));
  const currentScores = runs.filter((r) => r.variant === 'current').map((r) => scoreOf(r.id));
  const baseline = stats(baselineScores);
  const current = stats(currentScores);

  return {
    schemaVersion: 1,
    name: opts.name,
    createdAt: new Date().toISOString(),
    plugin: {
      path: opts.config.plugin.path,
      baselineRef: opts.baselineRef,
      baselineSha: opts.baselineSha,
      currentRef: opts.currentRef,
      currentSha: opts.currentSha,
    },
    config: opts.config,
    judge: { provider: opts.config.judge.provider, model: opts.config.judge.model },
    prompts: opts.prompts,
    runs,
    judgments,
    summary: { baseline, current, delta: current.mean - baseline.mean },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/run.benchmark.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/run.ts tests/run.benchmark.test.ts
git commit -m "feat(run): runBenchmark orchestrates matrix, concurrency-limited runs, judging, and summary stats"
```

---

### Task 17: Snapshot read/write/list

**Files:**
- Create: `src/snapshot.ts`
- Create: `tests/snapshot.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/snapshot.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveSnapshot, loadSnapshot, listSnapshots, removeSnapshot } from '../src/snapshot.js';
import type { Snapshot } from '../src/types.js';

function makeSnap(name: string): Snapshot {
  return {
    schemaVersion: 1,
    name,
    createdAt: '2026-04-23T10:00:00Z',
    plugin: { path: '/x', baselineRef: 'v1', baselineSha: 'a', currentRef: 'v2', currentSha: 'b' },
    config: {} as any,
    judge: { provider: 'ollama', model: 'q' },
    prompts: [],
    runs: [],
    judgments: [],
    summary: {
      baseline: { n: 0, mean: 0, median: 0, variance: 0 },
      current: { n: 0, mean: 0, median: 0, variance: 0 },
      delta: 0,
    },
  };
}

describe('snapshot io', () => {
  it('saves, lists, loads, removes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ef-snap-'));
    const snap = makeSnap('v1-baseline');
    const p = await saveSnapshot(snap, dir);
    expect(p).toMatch(/v1-baseline/);
    const list = await listSnapshots(dir);
    expect(list).toEqual(['v1-baseline']);
    const loaded = await loadSnapshot(dir, 'v1-baseline');
    expect(loaded.name).toBe('v1-baseline');
    await removeSnapshot(dir, 'v1-baseline');
    expect(await listSnapshots(dir)).toEqual([]);
  });

  it('rejects names with path traversal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ef-snap-'));
    const snap = makeSnap('../escape');
    await expect(saveSnapshot(snap, dir)).rejects.toThrow(/snapshot name/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/snapshot.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/snapshot.ts`:
```typescript
import { mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Snapshot } from './types.js';

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;

function validateName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(`invalid snapshot name: ${name} (must match ${NAME_RE})`);
  }
}

export async function saveSnapshot(snap: Snapshot, dir: string): Promise<string> {
  validateName(snap.name);
  const target = join(dir, snap.name);
  await mkdir(target, { recursive: true });
  const path = join(target, 'snapshot.json');
  await writeFile(path, JSON.stringify(snap, null, 2));
  return path;
}

export async function loadSnapshot(dir: string, name: string): Promise<Snapshot> {
  validateName(name);
  const path = join(dir, name, 'snapshot.json');
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw) as Snapshot;
}

export async function listSnapshots(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && NAME_RE.test(e.name)).map((e) => e.name).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

export async function removeSnapshot(dir: string, name: string): Promise<void> {
  validateName(name);
  const target = resolve(dir, name);
  if (!target.startsWith(resolve(dir))) {
    throw new Error('refusing to remove outside snapshots dir');
  }
  await rm(target, { recursive: true, force: true });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/snapshot.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/snapshot.ts tests/snapshot.test.ts
git commit -m "feat(snapshot): save/load/list/remove JSON snapshots with path-traversal guard"
```

---

## Phase 7 — Comparator

### Task 18: Compute comparison between two snapshots

**Files:**
- Create: `src/compare.ts` (partial — compute only)
- Create: `tests/compare.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/compare.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { compareSnapshots } from '../src/compare.js';
import type { Snapshot, Judgment, RunResult, PromptSpec } from '../src/types.js';

function mkJudgment(runId: string, score: number): Judgment {
  return {
    runId,
    score,
    rationale: 'x',
    rubricHash: 'h',
    judgeProvider: 'ollama',
    judgeModel: 'q',
    raw: '',
  };
}

function mkRun(id: string, promptId: string, variant: 'baseline' | 'current', sample: number): RunResult {
  return { id, promptId, variant, sample, output: '', durationMs: 1, exitCode: 0, error: null };
}

function mkSnap(
  name: string,
  perPromptBaseline: Record<string, number[]>,
  perPromptCurrent: Record<string, number[]>,
): Snapshot {
  const prompts: PromptSpec[] = Object.keys(perPromptBaseline).map((id) => ({
    id,
    prompt: 'x',
    rubric: 'r',
  }));
  const runs: RunResult[] = [];
  const judgments: Judgment[] = [];
  for (const pid of Object.keys(perPromptBaseline)) {
    perPromptBaseline[pid].forEach((s, i) => {
      const runId = `${pid}::baseline::${i + 1}`;
      runs.push(mkRun(runId, pid, 'baseline', i + 1));
      judgments.push(mkJudgment(runId, s));
    });
    perPromptCurrent[pid].forEach((s, i) => {
      const runId = `${pid}::current::${i + 1}`;
      runs.push(mkRun(runId, pid, 'current', i + 1));
      judgments.push(mkJudgment(runId, s));
    });
  }
  return {
    schemaVersion: 1,
    name,
    createdAt: '2026-04-23T00:00:00Z',
    plugin: { path: '/x', baselineRef: 'a', baselineSha: 'a', currentRef: 'b', currentSha: 'b' },
    config: {} as any,
    judge: { provider: 'ollama', model: 'q' },
    prompts,
    runs,
    judgments,
    summary: {
      baseline: { n: 0, mean: 0, median: 0, variance: 0 },
      current: { n: 0, mean: 0, median: 0, variance: 0 },
      delta: 0,
    },
  };
}

describe('compareSnapshots', () => {
  it('computes per-prompt delta and categorizes verdicts', () => {
    const a = mkSnap('a', { p1: [3, 3], p2: [4, 4] }, { p1: [3, 3], p2: [4, 4] });
    const b = mkSnap('b', { p1: [3, 3], p2: [4, 4] }, { p1: [4, 4], p2: [4, 4] });
    const cmp = compareSnapshots(a, b);
    expect(cmp.from).toBe('a');
    expect(cmp.to).toBe('b');
    expect(cmp.perPrompt).toHaveLength(2);
    const p1 = cmp.perPrompt.find((d) => d.promptId === 'p1')!;
    expect(p1.delta).toBeCloseTo(1.0);
    expect(p1.verdict).toBe('improved');
    expect(cmp.improvements).toHaveLength(1);
    expect(cmp.regressions).toHaveLength(0);
    expect(cmp.netDelta).toBeCloseTo(0.5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/compare.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/compare.ts`:
```typescript
import type { Snapshot, Comparison, PromptDelta, Judgment, RunResult } from './types.js';

const VERDICT_THRESHOLD = 0.2;

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function scoresForPromptAndVariant(
  snap: Snapshot,
  promptId: string,
  variant: 'baseline' | 'current',
): number[] {
  const runIds = snap.runs
    .filter((r: RunResult) => r.promptId === promptId && r.variant === variant)
    .map((r) => r.id);
  return snap.judgments
    .filter((j: Judgment) => runIds.includes(j.runId))
    .map((j) => j.score);
}

export function compareSnapshots(from: Snapshot, to: Snapshot): Comparison {
  const promptIds = Array.from(
    new Set([...from.prompts.map((p) => p.id), ...to.prompts.map((p) => p.id)]),
  );
  const perPrompt: PromptDelta[] = promptIds.map((pid) => {
    // "to"'s current represents the new state; "from"'s current represents the old state.
    // We compare same-variant scores across snapshots on the current variant by default.
    const baselineMean = mean(scoresForPromptAndVariant(from, pid, 'current'));
    const currentMean = mean(scoresForPromptAndVariant(to, pid, 'current'));
    const delta = currentMean - baselineMean;
    const verdict: PromptDelta['verdict'] =
      delta >= VERDICT_THRESHOLD ? 'improved' : delta <= -VERDICT_THRESHOLD ? 'regressed' : 'stable';
    return { promptId: pid, baselineMean, currentMean, delta, verdict };
  });
  const netDelta = mean(perPrompt.map((d) => d.delta));
  return {
    from: from.name,
    to: to.name,
    netDelta,
    perPrompt,
    improvements: perPrompt.filter((d) => d.verdict === 'improved'),
    stable: perPrompt.filter((d) => d.verdict === 'stable'),
    regressions: perPrompt.filter((d) => d.verdict === 'regressed'),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/compare.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/compare.ts tests/compare.test.ts
git commit -m "feat(compare): compute per-prompt deltas and verdicts between two snapshots"
```

---

### Task 19: Markdown formatter for comparison

**Files:**
- Modify: `src/compare.ts` (add `formatComparisonMarkdown`)
- Create: `tests/compare.format.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/compare.format.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { formatComparisonMarkdown } from '../src/compare.js';
import type { Comparison } from '../src/types.js';

const cmp: Comparison = {
  from: 'a',
  to: 'b',
  netDelta: 0.5,
  perPrompt: [
    { promptId: 'p1', baselineMean: 3, currentMean: 4, delta: 1, verdict: 'improved' },
    { promptId: 'p2', baselineMean: 4, currentMean: 4, delta: 0, verdict: 'stable' },
    { promptId: 'p3', baselineMean: 4, currentMean: 3.5, delta: -0.5, verdict: 'regressed' },
  ],
  improvements: [],
  stable: [],
  regressions: [],
};

describe('formatComparisonMarkdown', () => {
  it('renders a table and section headers', () => {
    const md = formatComparisonMarkdown(cmp);
    expect(md).toContain('# Benchmark comparison: `a` → `b`');
    expect(md).toContain('**Net delta:** +0.50');
    expect(md).toContain('| p1 |');
    expect(md).toContain('✓ improved');
    expect(md).toContain('✗ regressed');
    expect(md).toContain('~ stable');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/compare.format.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement — append to `src/compare.ts`**

```typescript
function fmt(n: number, digits = 2): string {
  const s = n.toFixed(digits);
  return n >= 0 ? `+${s}` : s;
}

function verdictGlyph(v: 'improved' | 'stable' | 'regressed'): string {
  return v === 'improved' ? '✓ improved' : v === 'regressed' ? '✗ regressed' : '~ stable';
}

export function formatComparisonMarkdown(cmp: Comparison): string {
  const lines: string[] = [];
  lines.push(`# Benchmark comparison: \`${cmp.from}\` → \`${cmp.to}\``);
  lines.push('');
  lines.push(`**Net delta:** ${fmt(cmp.netDelta)}`);
  lines.push('');
  lines.push('| Prompt | Baseline | Current | Δ | Verdict |');
  lines.push('|---|---|---|---|---|');
  for (const d of cmp.perPrompt) {
    lines.push(
      `| ${d.promptId} | ${d.baselineMean.toFixed(2)} | ${d.currentMean.toFixed(2)} | ${fmt(d.delta)} | ${verdictGlyph(d.verdict)} |`,
    );
  }
  return lines.join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/compare.format.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/compare.ts tests/compare.format.test.ts
git commit -m "feat(compare): format comparison as markdown table with per-prompt verdicts"
```

---

## Phase 8 — CLI commands

### Task 20: `ef init`

**Files:**
- Create: `templates/eval-bench.yaml`
- Create: `templates/prompts.yaml`
- Create: `templates/github-action.yml`
- Create: `src/cli/init.ts`
- Modify: `src/cli/index.ts` (wire up)
- Create: `tests/cli.init.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/cli.init.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../src/cli/init.js';

describe('ef init', () => {
  it('writes eval-bench.yaml, prompts.yaml, snapshots/.gitkeep', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ef-init-'));
    await runInit({ cwd: dir, ci: false });
    expect(existsSync(join(dir, 'eval-bench.yaml'))).toBe(true);
    expect(existsSync(join(dir, 'prompts.yaml'))).toBe(true);
    expect(existsSync(join(dir, 'snapshots', '.gitkeep'))).toBe(true);
    expect(readFileSync(join(dir, 'eval-bench.yaml'), 'utf8')).toContain('judge:');
  });

  it('emits GH Actions workflow with --ci', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ef-init-'));
    await runInit({ cwd: dir, ci: true });
    expect(existsSync(join(dir, '.github', 'workflows', 'eval-bench.yml'))).toBe(true);
  });

  it('does not overwrite existing files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ef-init-'));
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'eval-bench.yaml'), 'custom');
    await runInit({ cwd: dir, ci: false });
    expect(readFileSync(join(dir, 'eval-bench.yaml'), 'utf8')).toBe('custom');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli.init.test.ts`
Expected: FAIL.

- [ ] **Step 3: Create templates and init handler**

`templates/eval-bench.yaml`:
```yaml
# eval-bench configuration
# See https://github.com/<org>/eval-bench/blob/main/docs/config.md

plugin:
  path: ./

provider:
  command: claude
  timeout: 180
  model: claude-opus-4-7

judge:
  provider: ollama
  model: qwen2.5:14b
  endpoint: http://localhost:11434
  temperature: 0
  maxTokens: 1024

runs:
  samples: 3
  parallel: 2

snapshots:
  dir: ./snapshots
```

`templates/prompts.yaml`:
```yaml
# Each prompt is exercised against both the baseline and the current plugin version.
# Rubrics must produce a score in [0,5]. Be specific — vague rubrics produce noisy judges.
#
# A good prompt set exercises the paths in your plugin you care about: some prompts
# trigger skills, some trigger MCP tools, some delegate to subagents, some fire hooks.
# The judge grades end-to-end output regardless of which internal path produced it.

# Skill-driven example
- id: skill-example
  prompt: |
    Replace with a task that should trigger one of your skills.
    E.g. "List all components of the system and their purpose."
  rubric: |
    Score 0-5 on:
    - Completeness (0-2): every expected item is present
    - Accuracy (0-2): no invented or incorrect details
    - Format (0-1): readable, concise, no filler

# MCP-tool-driven example
- id: mcp-tool-example
  prompt: |
    Replace with a task that should invoke one of your plugin's MCP tools.
    E.g. "Use the db.query tool to find the 5 most recent orders for user 42."
  rubric: |
    Score 0-5 on:
    - Tool invocation (0-2): actually calls the expected MCP tool; does not guess
    - Correctness (0-2): returned data matches what the tool would produce
    - Formatting (0-1): output follows the requested format

# Subagent-driven example
- id: subagent-example
  prompt: |
    Replace with a task that should delegate to one of your subagents.
    E.g. "Review this PR for security issues."
  rubric: |
    Score 0-5 on:
    - Delegation (0-1): actually delegates to the expected subagent
    - Coverage (0-2): addresses the expected areas of concern
    - Specificity (0-2): concrete findings with file:line references; no generic advice
```

`templates/github-action.yml`:
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
          path: snapshots/
```

`src/cli/init.ts`:
```typescript
import { mkdir, writeFile, access, readFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates');

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function copyTemplate(templateName: string, targetPath: string): Promise<boolean> {
  if (await exists(targetPath)) return false;
  const contents = await readFile(join(TEMPLATES_DIR, templateName), 'utf8');
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, contents);
  return true;
}

export async function runInit(opts: { cwd: string; ci: boolean }): Promise<void> {
  const wrote: string[] = [];
  const skipped: string[] = [];
  if (await copyTemplate('eval-bench.yaml', join(opts.cwd, 'eval-bench.yaml')))
    wrote.push('eval-bench.yaml');
  else skipped.push('eval-bench.yaml');
  if (await copyTemplate('prompts.yaml', join(opts.cwd, 'prompts.yaml')))
    wrote.push('prompts.yaml');
  else skipped.push('prompts.yaml');
  const keep = join(opts.cwd, 'snapshots', '.gitkeep');
  if (!(await exists(keep))) {
    await mkdir(dirname(keep), { recursive: true });
    await writeFile(keep, '');
    wrote.push('snapshots/.gitkeep');
  }
  if (opts.ci) {
    const ciTarget = join(opts.cwd, '.github', 'workflows', 'eval-bench.yml');
    if (await copyTemplate('github-action.yml', ciTarget)) wrote.push('.github/workflows/eval-bench.yml');
    else skipped.push('.github/workflows/eval-bench.yml');
  }
  for (const f of wrote) console.log(`  created  ${f}`);
  for (const f of skipped) console.log(`  skipped  ${f} (already exists)`);
  console.log('');
  console.log('Next steps:');
  console.log('  1. Edit prompts.yaml — write 3-5 prompts that exercise your plugin');
  console.log('  2. Edit eval-bench.yaml — set judge provider and model');
  console.log('  3. Run: ef run --baseline <ref> --save-as v1-baseline');
}
```

Wire into `src/cli/index.ts`:
```typescript
// replace the init .action body with:
.action(async (opts) => {
  const { runInit } = await import('./init.js');
  await runInit({ cwd: process.cwd(), ci: Boolean(opts.ci) });
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cli.init.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add templates/ src/cli/init.ts src/cli/index.ts tests/cli.init.test.ts
git commit -m "feat(cli): implement `ef init` with templates for config, prompts, and GH Actions"
```

---

### Task 21: `ef run`

**Files:**
- Create: `src/cli/run.ts`
- Modify: `src/cli/index.ts`
- Create: `src/logger.ts`
- Create: `tests/cli.run.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/cli.run.test.ts`:
```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { execa } from 'execa';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

let server: Server;
let judgeUrl = '';

beforeAll(async () => {
  server = createServer((_req, res) => {
    let body = '';
    _req.on('data', (c) => (body += c));
    _req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: { content: '{"score":4,"rationale":"ok"}' } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (typeof addr === 'object' && addr) judgeUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

async function makeGitRepo(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'ef-run-'));
  await execa('git', ['init', '-q'], { cwd: root });
  await execa('git', ['config', 'user.email', 't@t'], { cwd: root });
  await execa('git', ['config', 'user.name', 't'], { cwd: root });
  writeFileSync(join(root, 'f'), '1');
  await execa('git', ['add', '.'], { cwd: root });
  await execa('git', ['commit', '-m', 'v1', '-q'], { cwd: root });
  await execa('git', ['tag', 'v1'], { cwd: root });
  writeFileSync(join(root, 'f'), '2');
  await execa('git', ['commit', '-am', 'v2', '-q'], { cwd: root });
  return root;
}

describe('ef run', () => {
  it('runs end-to-end and saves a snapshot', async () => {
    const repo = await makeGitRepo();
    const fakeClaude = resolve('tests/fixtures/fake-claude.js');
    chmodSync(fakeClaude, 0o755);
    writeFileSync(
      join(repo, 'eval-bench.yaml'),
      `plugin:\n  path: ./\nprovider:\n  command: node\n  extraArgs: ['${fakeClaude}']\n  timeout: 10\njudge:\n  provider: ollama\n  model: q\n  endpoint: ${judgeUrl}\nruns:\n  samples: 1\n  parallel: 1\nsnapshots:\n  dir: ./snaps\n`,
    );
    writeFileSync(
      join(repo, 'prompts.yaml'),
      `- id: p1\n  prompt: hello\n  rubric: score 0-5\n`,
    );
    const cliPath = resolve('src/cli/index.ts');
    const { exitCode, stdout } = await execa(
      'npx',
      ['tsx', cliPath, 'run', '--baseline', 'v1', '--save-as', 'r1'],
      { cwd: repo, reject: false },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Snapshot saved/);
    const snapPath = join(repo, 'snaps', 'r1', 'snapshot.json');
    const snap = JSON.parse(await readFile(snapPath, 'utf8'));
    expect(snap.runs).toHaveLength(2);
    expect(snap.judgments).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli.run.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement logger and run handler**

`src/logger.ts`:
```typescript
import chalk from 'chalk';

export function info(msg: string): void {
  console.log(msg);
}
export function ok(msg: string): void {
  console.log(chalk.green('✓') + ' ' + msg);
}
export function warn(msg: string): void {
  console.log(chalk.yellow('!') + ' ' + msg);
}
export function err(msg: string): void {
  console.error(chalk.red('✗') + ' ' + msg);
}
export function progress(current: number, total: number, label: string, status: string, ms: number): void {
  const statusColor = status === 'OK' ? chalk.green : status === 'FAIL' ? chalk.red : chalk.yellow;
  console.log(`[${current}/${total}] ${label.padEnd(40)} ${statusColor(status.padEnd(8))} (${(ms / 1000).toFixed(1)}s)`);
}
```

`src/cli/run.ts`:
```typescript
import { loadConfig } from '../config.js';
import { loadPrompts } from '../prompts.js';
import { runBenchmark } from '../run.js';
import { saveSnapshot, loadSnapshot } from '../snapshot.js';
import { createWorktree, resolveSha } from '../swap.js';
import { compareSnapshots, formatComparisonMarkdown } from '../compare.js';
import { info, ok, err, progress } from '../logger.js';
import type { Config } from '../types.js';

export interface RunOptions {
  cwd: string;
  plugin?: string;
  baseline?: string;
  current?: string;
  prompts?: string;
  config?: string;
  samples?: number;
  judge?: string;
  saveAs?: string;
  compare?: string;
  failOnRegression?: number;
  dryRun?: boolean;
  verbose?: boolean;
}

function applyOverrides(cfg: Config, opts: RunOptions): Config {
  if (opts.samples) cfg.runs.samples = opts.samples;
  if (opts.judge) {
    const [provider, ...rest] = opts.judge.split(':');
    cfg.judge.provider = provider as Config['judge']['provider'];
    if (rest.length) cfg.judge.model = rest.join(':');
  }
  if (opts.plugin) {
    cfg.plugin.path = opts.plugin;
    cfg.plugin.gitRoot = opts.plugin;
  }
  return cfg;
}

export async function runCommand(opts: RunOptions): Promise<number> {
  const configPath = opts.config ?? 'eval-bench.yaml';
  const promptsPath = opts.prompts ?? 'prompts.yaml';
  const cfg = applyOverrides(loadConfig(configPath), opts);
  const prompts = loadPrompts(promptsPath);
  const gitRoot = cfg.plugin.gitRoot;
  const baselineRef = opts.baseline ?? 'HEAD~1';
  const currentRef = opts.current ?? 'HEAD';
  const name = opts.saveAs ?? new Date().toISOString().replace(/[:.]/g, '-');

  info(`Plugin:   ${cfg.plugin.path}`);
  info(`Baseline: ${baselineRef}`);
  info(`Current:  ${currentRef}`);
  info(`Judge:    ${cfg.judge.provider}/${cfg.judge.model}`);
  info(`Matrix:   ${prompts.length} prompts × ${cfg.runs.samples} samples × 2 variants = ${prompts.length * cfg.runs.samples * 2} runs`);
  if (opts.dryRun) return 0;

  const baselineSha = await resolveSha(gitRoot, baselineRef);
  const currentSha = await resolveSha(gitRoot, currentRef);
  const baselineWt = await createWorktree(gitRoot, baselineRef);

  try {
    let runIdx = 0;
    const total = prompts.length * cfg.runs.samples * 2;
    const snap = await runBenchmark({
      config: cfg,
      prompts,
      baselinePluginDir: baselineWt.path,
      currentPluginDir: gitRoot,
      baselineRef,
      baselineSha,
      currentRef,
      currentSha,
      name,
      onProgress: (ev) => {
        if (ev.kind === 'run-end') {
          runIdx++;
          const status = ev.error ? 'FAIL' : 'OK';
          progress(runIdx, total, ev.rowId, status, ev.durationMs);
        }
      },
    });
    const path = await saveSnapshot(snap, cfg.snapshots.dir);
    ok(`Snapshot saved: ${path}`);
    info(`  baseline mean ${snap.summary.baseline.mean.toFixed(2)} (n=${snap.summary.baseline.n})`);
    info(`  current  mean ${snap.summary.current.mean.toFixed(2)} (n=${snap.summary.current.n})`);
    info(`  delta    ${snap.summary.delta >= 0 ? '+' : ''}${snap.summary.delta.toFixed(2)}`);
    if (opts.compare) {
      const base = await loadSnapshot(cfg.snapshots.dir, opts.compare);
      const cmp = compareSnapshots(base, snap);
      info('');
      info(formatComparisonMarkdown(cmp));
      if (opts.failOnRegression !== undefined && cmp.netDelta < -opts.failOnRegression) {
        err(`Regression exceeds threshold (${cmp.netDelta.toFixed(2)} < -${opts.failOnRegression})`);
        return 1;
      }
    }
    return 0;
  } finally {
    await baselineWt.cleanup();
  }
}
```

Wire into `src/cli/index.ts` — replace the run `.action`:
```typescript
.action(async (opts) => {
  const { runCommand } = await import('./run.js');
  const code = await runCommand({ cwd: process.cwd(), ...opts });
  process.exit(code);
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cli.run.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/run.ts src/cli/index.ts src/logger.ts tests/cli.run.test.ts
git commit -m "feat(cli): implement `ef run` — orchestrate swap, benchmark, save, optional compare"
```

---

### Task 22: `ef snapshot` subcommands

**Files:**
- Create: `src/cli/snapshot.ts`
- Modify: `src/cli/index.ts`
- Create: `tests/cli.snapshot.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/cli.snapshot.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotList, snapshotShow, snapshotRm } from '../src/cli/snapshot.js';

function seed(dir: string, name: string) {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(
    join(dir, name, 'snapshot.json'),
    JSON.stringify({
      schemaVersion: 1,
      name,
      createdAt: '2026-04-23T00:00:00Z',
      plugin: { path: '', baselineRef: '', baselineSha: '', currentRef: '', currentSha: '' },
      config: {},
      judge: { provider: 'ollama', model: 'q' },
      prompts: [],
      runs: [],
      judgments: [],
      summary: { baseline: { n: 1, mean: 3, median: 3, variance: 0 }, current: { n: 1, mean: 3.5, median: 3.5, variance: 0 }, delta: 0.5 },
    }),
  );
}

describe('ef snapshot', () => {
  it('list / show / rm', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ef-snapcli-'));
    seed(dir, 'a');
    seed(dir, 'b');
    const list = await snapshotList(dir);
    expect(list).toEqual(['a', 'b']);
    const summary = await snapshotShow(dir, 'a');
    expect(summary).toMatch(/baseline mean 3.00/);
    expect(summary).toMatch(/delta \+0.50/);
    await snapshotRm(dir, 'a');
    expect(await snapshotList(dir)).toEqual(['b']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli.snapshot.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/cli/snapshot.ts`:
```typescript
import { listSnapshots, loadSnapshot, removeSnapshot } from '../snapshot.js';

export async function snapshotList(dir: string): Promise<string[]> {
  return listSnapshots(dir);
}

export async function snapshotShow(dir: string, name: string): Promise<string> {
  const s = await loadSnapshot(dir, name);
  const lines: string[] = [];
  lines.push(`name:       ${s.name}`);
  lines.push(`created:    ${s.createdAt}`);
  lines.push(`baselineRef:${s.plugin.baselineRef}`);
  lines.push(`currentRef: ${s.plugin.currentRef}`);
  lines.push(`prompts:    ${s.prompts.length}`);
  lines.push(`runs:       ${s.runs.length}`);
  lines.push(`baseline mean ${s.summary.baseline.mean.toFixed(2)} (n=${s.summary.baseline.n})`);
  lines.push(`current  mean ${s.summary.current.mean.toFixed(2)} (n=${s.summary.current.n})`);
  lines.push(`delta    ${s.summary.delta >= 0 ? '+' : ''}${s.summary.delta.toFixed(2)}`);
  return lines.join('\n');
}

export async function snapshotRm(dir: string, name: string): Promise<void> {
  await removeSnapshot(dir, name);
}
```

Wire into `src/cli/index.ts` by replacing the snapshot subcommand actions (see Task 3 for context) to call these helpers. The config dir is `./snapshots` by default; read `snapshots.dir` from `eval-bench.yaml` if present, else fall back.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cli.snapshot.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/snapshot.ts src/cli/index.ts tests/cli.snapshot.test.ts
git commit -m "feat(cli): implement `ef snapshot list/show/rm` against snapshots dir"
```

---

### Task 23: `ef compare`

**Files:**
- Create: `src/cli/compare.ts`
- Modify: `src/cli/index.ts`
- Create: `tests/cli.compare.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/cli.compare.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareCommand } from '../src/cli/compare.js';

function seed(dir: string, name: string, scoreCurrent: number): void {
  mkdirSync(join(dir, name), { recursive: true });
  const base = {
    schemaVersion: 1,
    name,
    createdAt: '2026-04-23T00:00:00Z',
    plugin: { path: '', baselineRef: '', baselineSha: '', currentRef: '', currentSha: '' },
    config: {},
    judge: { provider: 'ollama', model: 'q' },
    prompts: [{ id: 'p1', prompt: 'x', rubric: 'r' }],
    runs: [{ id: 'p1::current::1', promptId: 'p1', variant: 'current', sample: 1, output: '', durationMs: 1, exitCode: 0, error: null }],
    judgments: [{ runId: 'p1::current::1', score: scoreCurrent, rationale: '', rubricHash: '', judgeProvider: 'ollama', judgeModel: 'q', raw: '' }],
    summary: { baseline: { n: 0, mean: 0, median: 0, variance: 0 }, current: { n: 1, mean: scoreCurrent, median: scoreCurrent, variance: 0 }, delta: 0 },
  };
  writeFileSync(join(dir, name, 'snapshot.json'), JSON.stringify(base));
}

describe('ef compare', () => {
  it('emits markdown by default', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ef-cmp-'));
    seed(dir, 'a', 3);
    seed(dir, 'b', 4);
    const out = await compareCommand({ dir, from: 'a', to: 'b', format: 'md' });
    expect(out).toContain('# Benchmark comparison: `a` → `b`');
    expect(out).toContain('| p1 |');
  });

  it('emits json when requested', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ef-cmp-'));
    seed(dir, 'a', 3);
    seed(dir, 'b', 4);
    const out = await compareCommand({ dir, from: 'a', to: 'b', format: 'json' });
    const obj = JSON.parse(out);
    expect(obj.from).toBe('a');
    expect(obj.to).toBe('b');
    expect(obj.perPrompt[0].delta).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli.compare.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/cli/compare.ts`:
```typescript
import { loadSnapshot } from '../snapshot.js';
import { compareSnapshots, formatComparisonMarkdown } from '../compare.js';

export interface CompareOptions {
  dir: string;
  from: string;
  to: string;
  format: 'md' | 'json' | 'both';
  threshold?: number;
}

export async function compareCommand(opts: CompareOptions): Promise<string> {
  const a = await loadSnapshot(opts.dir, opts.from);
  const b = await loadSnapshot(opts.dir, opts.to);
  const cmp = compareSnapshots(a, b);
  if (opts.threshold !== undefined) {
    cmp.perPrompt = cmp.perPrompt.filter((d) => Math.abs(d.delta) > opts.threshold!);
  }
  if (opts.format === 'json') return JSON.stringify(cmp, null, 2);
  if (opts.format === 'md') return formatComparisonMarkdown(cmp);
  return formatComparisonMarkdown(cmp) + '\n\n' + JSON.stringify(cmp, null, 2);
}
```

Wire into `src/cli/index.ts`:
```typescript
// replace the compare .action:
.action(async (a, b, opts) => {
  const { compareCommand } = await import('./compare.js');
  const { loadConfig } = await import('../config.js');
  const cfg = await loadConfig('eval-bench.yaml').catch(() => null);
  const dir = cfg?.snapshots.dir ?? './snapshots';
  const out = await compareCommand({ dir, from: a, to: b, format: opts.format ?? 'md', threshold: opts.threshold });
  if (opts.out) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(opts.out, out);
  } else {
    console.log(out);
  }
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cli.compare.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/compare.ts src/cli/index.ts tests/cli.compare.test.ts
git commit -m "feat(cli): implement `ef compare` with md/json/both output formats and threshold filter"
```

---

### Task 24: `ef view` — delegate to Promptfoo

**Files:**
- Create: `src/cli/view.ts`
- Modify: `src/cli/index.ts`
- Create: `tests/cli.view.test.ts`

> Note: For MVP, `view` simply pretty-prints the snapshot and tells the user how to open the Promptfoo UI if they have Promptfoo installed. Full Promptfoo integration (generating a promptfoo-format results file) is deferred to v0.2 — doing it now would require translating every snapshot into a Promptfoo eval export. The `view` command in MVP opens an HTML page generated from the snapshot.

- [ ] **Step 1: Write the failing test**

`tests/cli.view.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { viewCommand } from '../src/cli/view.js';

function seed(dir: string, name: string) {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(
    join(dir, name, 'snapshot.json'),
    JSON.stringify({
      schemaVersion: 1,
      name,
      createdAt: '2026-04-23T00:00:00Z',
      plugin: { path: '', baselineRef: '', baselineSha: '', currentRef: '', currentSha: '' },
      config: {},
      judge: { provider: 'ollama', model: 'q' },
      prompts: [{ id: 'p1', prompt: 'x', rubric: 'r' }],
      runs: [{ id: 'p1::baseline::1', promptId: 'p1', variant: 'baseline', sample: 1, output: 'hi', durationMs: 1, exitCode: 0, error: null }],
      judgments: [{ runId: 'p1::baseline::1', score: 4, rationale: 'ok', rubricHash: '', judgeProvider: 'ollama', judgeModel: 'q', raw: '' }],
      summary: { baseline: { n: 1, mean: 4, median: 4, variance: 0 }, current: { n: 0, mean: 0, median: 0, variance: 0 }, delta: -4 },
    }),
  );
}

describe('ef view', () => {
  it('generates an HTML file under snapshot dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ef-view-'));
    seed(dir, 'a');
    const html = await viewCommand({ dir, name: 'a', writeHtml: true, open: false });
    expect(existsSync(join(dir, 'a', 'view.html'))).toBe(true);
    expect(html).toContain('<html');
    expect(html).toContain('p1');
    expect(html).toContain('score 4');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli.view.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/cli/view.ts`:
```typescript
import { loadSnapshot } from '../snapshot.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Snapshot } from '../types.js';

function escape(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
}

function renderHtml(s: Snapshot): string {
  const rows = s.prompts.map((p) => {
    const variants = (['baseline', 'current'] as const).map((v) => {
      const runs = s.runs.filter((r) => r.promptId === p.id && r.variant === v);
      const cells = runs
        .map((r) => {
          const j = s.judgments.find((x) => x.runId === r.id);
          return `<div class="cell"><div class="score">score ${j?.score ?? '-'}</div><pre>${escape(r.output).slice(0, 800)}</pre><div class="rat">${escape(j?.rationale ?? '')}</div></div>`;
        })
        .join('');
      return `<div class="variant"><h4>${v}</h4>${cells}</div>`;
    });
    return `<section><h3>${escape(p.id)}</h3><p class="prompt">${escape(p.prompt)}</p>${variants.join('')}</section>`;
  });
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escape(s.name)}</title>
<style>
body{font:14px -apple-system,sans-serif;margin:2em;color:#111}
section{border-top:1px solid #eee;padding-top:1em;margin-top:2em}
.variant{display:inline-block;vertical-align:top;width:48%;margin-right:1%}
.cell{background:#f7f7f7;padding:0.5em;margin:0.5em 0;border-radius:4px}
.score{font-weight:bold;color:#0a0}
pre{white-space:pre-wrap;font-size:12px}
.rat{color:#666;font-size:12px;margin-top:0.3em}
.prompt{background:#eef;padding:0.5em;border-radius:4px}
h1{margin-bottom:0}
.meta{color:#666;font-size:12px}
</style></head>
<body>
<h1>${escape(s.name)}</h1>
<div class="meta">created ${s.createdAt} · judge ${s.judge.provider}/${s.judge.model} · baseline ${escape(s.plugin.baselineRef)} · current ${escape(s.plugin.currentRef)}</div>
<p>baseline mean ${s.summary.baseline.mean.toFixed(2)} · current mean ${s.summary.current.mean.toFixed(2)} · delta ${s.summary.delta.toFixed(2)}</p>
${rows.join('')}
</body></html>`;
}

export async function viewCommand(opts: {
  dir: string;
  name: string;
  writeHtml: boolean;
  open: boolean;
}): Promise<string> {
  const snap = await loadSnapshot(opts.dir, opts.name);
  const html = renderHtml(snap);
  if (opts.writeHtml) {
    const path = join(opts.dir, opts.name, 'view.html');
    await writeFile(path, html);
    if (opts.open) {
      const { execa } = await import('execa');
      const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      await execa(cmd, [path], { detached: true, stdio: 'ignore' }).catch(() => {});
    }
  }
  return html;
}
```

Wire into `src/cli/index.ts`:
```typescript
// replace the view .action:
.action(async (snapshotName) => {
  const { loadConfig } = await import('../config.js');
  const { listSnapshots } = await import('../snapshot.js');
  const cfg = await loadConfig('eval-bench.yaml').catch(() => null);
  const dir = cfg?.snapshots.dir ?? './snapshots';
  const name = snapshotName ?? (await listSnapshots(dir)).at(-1);
  if (!name) { console.error('no snapshots found'); process.exit(1); }
  const { viewCommand } = await import('./view.js');
  await viewCommand({ dir, name, writeHtml: true, open: true });
  console.log(`opened view for snapshot "${name}"`);
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cli.view.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/view.ts src/cli/index.ts tests/cli.view.test.ts
git commit -m "feat(cli): implement `ef view` — render an HTML report from a snapshot"
```

---

## Phase 9 — Documentation

### Task 25: README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Write the failing test**

`tests/docs.readme.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('README', () => {
  it('has a quickstart, install, and link to docs', () => {
    const r = readFileSync('README.md', 'utf8');
    expect(r).toMatch(/## Install/);
    expect(r).toMatch(/## Quickstart/);
    expect(r).toMatch(/docs\/quickstart\.md/);
    expect(r).toMatch(/docs\/judges\.md/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/docs.readme.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the README**

Replace `README.md` with (showing full content):

````markdown
# eval-bench

Benchmark Claude Code plugins by A/B comparing plugin versions with LLM-judged evaluation prompts.

Runs a fixed set of prompts against two versions of your plugin (baseline vs current), invokes the real `claude` CLI so skills, MCP servers, and subagents actually load, grades each output with a configurable judge (local Ollama, Anthropic, OpenAI, or any OpenAI-compatible endpoint), and produces a side-by-side comparison.

## Install

```bash
npm i -g eval-bench
# or
npx eval-bench --help
```

Requires:
- Node 20+
- `claude` CLI on PATH ([install instructions](https://docs.anthropic.com/claude-code))
- Your plugin in a git repo (required for baseline checkout)
- A judge: either Ollama installed locally, or an API key for Anthropic/OpenAI

## Quickstart

```bash
cd my-claude-plugin
ef init
$EDITOR prompts.yaml   # write 3–5 prompts with rubrics
ef run --baseline v1.0.0 --save-as v1-baseline
# edit your plugin...
ef run --baseline v1-baseline --save-as wip --compare v1-baseline
ef view wip
```

Full walkthrough: [docs/quickstart.md](docs/quickstart.md).

## Docs

- [docs/quickstart.md](docs/quickstart.md) — zero to first comparison in ten minutes
- [docs/concepts.md](docs/concepts.md) — plugin, baseline, variant, sample, judge, rubric, snapshot
- [docs/config.md](docs/config.md) — every field in `eval-bench.yaml` and `prompts.yaml`
- [docs/rubrics.md](docs/rubrics.md) — how to write rubrics that produce reliable scores
- [docs/judges.md](docs/judges.md) — picking a judge; local vs hosted tradeoffs; known-good models
- [docs/ci.md](docs/ci.md) — GitHub Actions, GitLab CI, self-hosted GPU runners
- [docs/troubleshooting.md](docs/troubleshooting.md) — common failure modes
- [docs/comparison-to-promptfoo.md](docs/comparison-to-promptfoo.md) — when to use this tool vs raw Promptfoo

## License

MIT.
````

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/docs.readme.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add README.md tests/docs.readme.test.ts
git commit -m "docs: write README with install, quickstart, and docs index"
```

---

### Task 26: Core docs (quickstart, concepts)

**Files:**
- Create: `docs/quickstart.md`
- Create: `docs/concepts.md`
- Create: `tests/docs.core.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('core docs', () => {
  it('quickstart covers install, init, run, compare', () => {
    const q = readFileSync('docs/quickstart.md', 'utf8');
    expect(q).toMatch(/ef init/);
    expect(q).toMatch(/ef run/);
    expect(q).toMatch(/ef compare/);
  });
  it('concepts defines the core terms', () => {
    const c = readFileSync('docs/concepts.md', 'utf8');
    for (const term of ['plugin', 'baseline', 'current', 'variant', 'sample', 'judge', 'rubric', 'snapshot']) {
      expect(c.toLowerCase()).toContain(term);
    }
  });
});
```

- [ ] **Step 2: Run test — FAIL**

Run: `npx vitest run tests/docs.core.test.ts`

- [ ] **Step 3: Write the docs**

`docs/quickstart.md`:
```markdown
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
ef init
```

This creates `eval-bench.yaml`, `prompts.yaml`, and a `snapshots/` directory.

## 4. Write prompts

Edit `prompts.yaml`. Three to five prompts that exercise your plugin's key capabilities. For each, write a specific rubric.

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
ef run --baseline v1.0.0 --current v1.0.0 --save-as v1-baseline
```

Both baseline and current are v1.0.0 — this is your clean comparison point. The tool still runs both variants so you can measure judge noise.

## 6. Make a change

Edit your plugin — tweak a skill, add an MCP server, change a subagent prompt. Commit or just leave dirty in the working tree.

## 7. Re-run and compare

```bash
ef run --baseline v1.0.0 --save-as wip --compare v1-baseline
```

You'll see per-prompt deltas and a net score. If the net is positive and no prompts regressed, your change is a win.

## 8. Open the HTML view

```bash
ef view wip
```

Opens a local HTML page with baseline vs current outputs per prompt, judge scores, and rationale.

## Next

- [concepts.md](concepts.md) for terminology
- [rubrics.md](rubrics.md) for writing better rubrics (the single biggest lever on signal quality)
- [judges.md](judges.md) for picking between Ollama / Anthropic / OpenAI
- [ci.md](ci.md) for running this on every PR
```

`docs/concepts.md`:
```markdown
# Concepts

**Plugin** — the Claude Code plugin under test. A directory containing `.claude-plugin/`, `skills/`, `agents/`, etc. Must be in a git repo.

**Baseline** — the plugin version you are comparing *against*. Usually a tag or commit SHA (e.g. `v1.0.0`, `origin/main`). Resolved via `git rev-parse` and checked out into a temporary worktree.

**Current** — the plugin version you are comparing. Defaults to `HEAD` (your working tree).

**Variant** — either `baseline` or `current`. Each prompt is run against both.

**Sample** — one execution of one prompt against one variant. `samples: 3` means each prompt is run 3 times per variant so we can measure variance (noise) in the judge scoring.

**Judge** — an LLM that reads the prompt, the output, and the rubric, and returns a score 0–5 plus a rationale. Supported providers: `ollama`, `anthropic`, `openai`, `openai-compatible`.

**Rubric** — per-prompt grading criteria. Write a specific, checklist-style rubric; vague rubrics produce noisy judge scores. See [rubrics.md](rubrics.md).

**Snapshot** — the saved result of a `ef run`. JSON file at `snapshots/<name>/snapshot.json`. Contains the prompts, every run's output, every judgment, and summary statistics. Commit them to git if you want a historical record.

**Comparison** — the diff between two snapshots. Per-prompt mean deltas, a net score, and lists of improvements / stable / regressions. Output as markdown or JSON.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/docs.core.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/quickstart.md docs/concepts.md tests/docs.core.test.ts
git commit -m "docs: add quickstart and concepts pages"
```

---

### Task 27: Config, rubrics, judges docs

**Files:**
- Create: `docs/config.md`
- Create: `docs/rubrics.md`
- Create: `docs/judges.md`
- Create: `tests/docs.refs.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('reference docs', () => {
  it('config.md documents every top-level field', () => {
    const c = readFileSync('docs/config.md', 'utf8');
    for (const k of ['plugin', 'provider', 'judge', 'runs', 'snapshots']) {
      expect(c).toContain(`## ${k}`);
    }
  });
  it('rubrics.md has examples of good and bad rubrics', () => {
    const r = readFileSync('docs/rubrics.md', 'utf8');
    expect(r.toLowerCase()).toMatch(/good example/);
    expect(r.toLowerCase()).toMatch(/bad example/);
  });
  it('judges.md documents all four providers', () => {
    const j = readFileSync('docs/judges.md', 'utf8');
    for (const p of ['Ollama', 'Anthropic', 'OpenAI', 'OpenAI-compatible']) {
      expect(j).toContain(p);
    }
  });
});
```

- [ ] **Step 2: Run test — FAIL**

- [ ] **Step 3: Write the docs**

Write `docs/config.md` — copy structure from spec section 6 plus per-field notes and full type for each field. Each top-level section (`## plugin`, `## provider`, `## judge`, `## runs`, `## snapshots`) lists every field with type, default, whether required, and what it does.

Write `docs/rubrics.md` — sections: why rubrics matter, structure of a good rubric (numbered criteria with point values), good example (specific, checklist-style), bad example (vague "is this output good?"), common pitfalls (judges struggle with open-ended questions), test your rubric (run the same output through multiple judges and look at variance).

Write `docs/judges.md` — decision table (local vs hosted, resource requirements, known-good models), section per provider with config example, bias warnings (Claude judging Claude, small-model structured-output failures), recommendation: default Ollama `qwen2.5:14b` for dev, escalate to Claude/GPT-4 as a secondary judge for release gates.

(Full content matches spec sections 9 and 15 — keep docs under 500 lines each.)

- [ ] **Step 4: Run test — PASS**

Run: `npx vitest run tests/docs.refs.test.ts`

- [ ] **Step 5: Commit**

```bash
git add docs/config.md docs/rubrics.md docs/judges.md tests/docs.refs.test.ts
git commit -m "docs: add config reference, rubrics guide, and judges guide"
```

---

### Task 28: CI, troubleshooting, comparison docs

**Files:**
- Create: `docs/ci.md`
- Create: `docs/troubleshooting.md`
- Create: `docs/comparison-to-promptfoo.md`
- Create: `tests/docs.aux.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('aux docs', () => {
  it('ci.md has a complete GitHub Actions example', () => {
    const c = readFileSync('docs/ci.md', 'utf8');
    expect(c).toMatch(/runs-on: ubuntu-latest/);
    expect(c).toMatch(/ollama pull/);
    expect(c).toMatch(/fail-on-regression/);
  });
  it('troubleshooting.md covers common errors', () => {
    const t = readFileSync('docs/troubleshooting.md', 'utf8');
    for (const s of ['not a git repo', 'claude CLI not found', 'Ollama', 'judge response']) {
      expect(t).toContain(s);
    }
  });
  it('comparison-to-promptfoo.md answers "when should I use this vs raw Promptfoo"', () => {
    const p = readFileSync('docs/comparison-to-promptfoo.md', 'utf8');
    expect(p.toLowerCase()).toMatch(/use eval-bench when/);
    expect(p.toLowerCase()).toMatch(/use raw promptfoo when/);
  });
});
```

- [ ] **Step 2: Run test — FAIL**

- [ ] **Step 3: Write the docs**

`docs/ci.md` — full GitHub Actions workflow (copy from spec section 8), GitLab CI equivalent, note on self-hosted GPU runner for faster judging, guidance on secrets (ANTHROPIC_API_KEY), note on caching Ollama models.

`docs/troubleshooting.md` — sections:
- "not a git repo" — what it means, fix
- "claude CLI not found" — install claude-code npm package, add to PATH
- "Ollama: connection refused" — ensure `ollama serve` is running
- "judge response: could not parse JSON" — usually means judge model is too small; upgrade to 7B+; check rubric structure
- "timed out" — increase `provider.timeout`; consider `--samples 1` for faster iteration

`docs/comparison-to-promptfoo.md` — two-section decision doc:
- **Use eval-bench when:** benchmarking a Claude Code plugin end-to-end with real skills/MCPs/subagents loaded; comparing plugin versions via git refs; want a turnkey A/B with LLM-as-judge and no YAML learning curve.
- **Use raw Promptfoo when:** benchmarking arbitrary LLM prompts across multiple providers (OpenAI + Anthropic + Gemini side-by-side); red-team testing; dataset-based evaluation with Promptfoo's built-in datasets; need Promptfoo's plugin/extension ecosystem.

- [ ] **Step 4: Run test — PASS**

Run: `npx vitest run tests/docs.aux.test.ts`

- [ ] **Step 5: Commit**

```bash
git add docs/ci.md docs/troubleshooting.md docs/comparison-to-promptfoo.md tests/docs.aux.test.ts
git commit -m "docs: add CI guide, troubleshooting, and promptfoo-comparison pages"
```

---

## Phase 10 — Release prep

### Task 29: End-to-end integration test with a toy plugin fixture

**Files:**
- Create: `tests/e2e/toy-plugin/` (git-initialized fixture)
- Create: `tests/e2e.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/e2e.test.ts`:
```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { execa } from 'execa';
import { mkdtempSync, cpSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let server: Server;
let judgeUrl = '';

beforeAll(async () => {
  server = createServer((_req, res) => {
    let body = '';
    _req.on('data', (c) => (body += c));
    _req.on('end', () => {
      // score based on output length to ensure deltas between baseline/current
      const reqBody = JSON.parse(body);
      const output = reqBody.messages[0].content.match(/OUTPUT:\s*([\s\S]*?)-----\nRUBRIC/)?.[1]?.trim() ?? '';
      const score = Math.min(5, output.length / 10);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: { content: `{"score":${score},"rationale":"len-based"}` } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (typeof addr === 'object' && addr) judgeUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('e2e', () => {
  it('init → run baseline → edit → run with compare', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'ef-e2e-'));
    cpSync('tests/e2e/toy-plugin', repo, { recursive: true });
    await execa('git', ['init', '-q'], { cwd: repo });
    await execa('git', ['config', 'user.email', 't@t'], { cwd: repo });
    await execa('git', ['config', 'user.name', 't'], { cwd: repo });
    await execa('git', ['add', '.'], { cwd: repo });
    await execa('git', ['commit', '-m', 'v1', '-q'], { cwd: repo });

    const cli = resolve('src/cli/index.ts');
    // init is already present via toy plugin fixture; override judge endpoint:
    const cfg = readFileSync(join(repo, 'eval-bench.yaml'), 'utf8').replace('JUDGE_URL', judgeUrl);
    writeFileSync(join(repo, 'eval-bench.yaml'), cfg);

    // baseline run
    const r1 = await execa('npx', ['tsx', cli, 'run', '--baseline', 'HEAD', '--save-as', 'v1-baseline'], { cwd: repo, reject: false });
    expect(r1.exitCode).toBe(0);

    // edit fake-claude to return LONGER output
    writeFileSync(join(repo, 'fake-claude.js'), readFileSync(join(repo, 'fake-claude.js'), 'utf8').replace('PLUGIN=', 'PLUGIN_VERSION_TWO_MUCH_LONGER_OUTPUT='));
    await execa('git', ['commit', '-am', 'v2', '-q'], { cwd: repo });

    // compare run
    const r2 = await execa('npx', ['tsx', cli, 'run', '--baseline', 'v1-baseline', '--save-as', 'v2', '--compare', 'v1-baseline'], { cwd: repo, reject: false });
    expect(r2.exitCode).toBe(0);
    expect(r2.stdout).toMatch(/improved|stable/);
  }, 60_000);
});
```

`tests/e2e/toy-plugin/eval-bench.yaml`:
```yaml
plugin:
  path: ./
provider:
  command: node
  extraArgs: ['fake-claude.js']
  timeout: 10
judge:
  provider: ollama
  model: q
  endpoint: JUDGE_URL
runs:
  samples: 2
  parallel: 1
snapshots:
  dir: ./snaps
```

`tests/e2e/toy-plugin/prompts.yaml`:
```yaml
- id: say-hi
  prompt: say hi
  rubric: score by length
- id: say-bye
  prompt: say bye
  rubric: score by length
```

`tests/e2e/toy-plugin/fake-claude.js`:
```javascript
#!/usr/bin/env node
const args = process.argv.slice(2);
const p = args[args.indexOf('-p') + 1];
console.log(`PLUGIN=${process.env.EVAL_BENCH_PLUGIN_DIR ?? ''} P=${p}`);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/e2e.test.ts`
Expected: FAIL — fixture missing if any path wrong.

- [ ] **Step 3: Adjust paths until it passes**

Set executable bit on `fake-claude.js`; ensure fixture is `cp`-ed with permissions; verify worktree cleanup after test.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/e2e.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/ tests/e2e.test.ts
git commit -m "test(e2e): end-to-end flow — init, baseline, edit, compare with real git and mock judge"
```

---

### Task 30: CI for the tool itself

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write the failing test**

`tests/tool-ci.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('tool CI', () => {
  it('runs lint, test, and build', () => {
    const w = readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(w).toMatch(/npm ci/);
    expect(w).toMatch(/npm run lint/);
    expect(w).toMatch(/npm test/);
    expect(w).toMatch(/npm run build/);
  });
});
```

- [ ] **Step 2: Run test — FAIL**

- [ ] **Step 3: Create workflow**

`.github/workflows/ci.yml`:
```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: ['20', '22']
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm test
      - run: npm run build
```

- [ ] **Step 4: Run test — PASS**

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml tests/tool-ci.test.ts
git commit -m "ci: add GitHub Actions workflow for lint, test, and build on Node 20/22"
```

---

### Task 31: Publish checklist + CHANGELOG

**Files:**
- Create: `CHANGELOG.md`
- Modify: `package.json` (add `repository`, `bugs`, `homepage`)

- [ ] **Step 1: Write the failing test**

`tests/release.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('release metadata', () => {
  it('package.json has repository, bugs, homepage', () => {
    const p = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(p.repository).toBeTruthy();
    expect(p.bugs).toBeTruthy();
    expect(p.homepage).toBeTruthy();
  });
  it('CHANGELOG exists with v0.1.0 entry', () => {
    const c = readFileSync('CHANGELOG.md', 'utf8');
    expect(c).toMatch(/0\.1\.0/);
  });
});
```

- [ ] **Step 2: Run test — FAIL**

- [ ] **Step 3: Create files**

`CHANGELOG.md`:
```markdown
# Changelog

All notable changes to this project will be documented in this file.

## 0.1.0 — Unreleased

Initial release.

- `ef init` — scaffold `eval-bench.yaml`, `prompts.yaml`, `snapshots/`, and optional GitHub Actions workflow
- `ef run` — benchmark plugin by running each prompt × sample × variant via `claude -p`, judged by Ollama / Anthropic / OpenAI / OpenAI-compatible
- `ef snapshot list | show | rm` — manage stored snapshots
- `ef compare` — diff two snapshots, emit markdown or JSON
- `ef view` — render an HTML report for a snapshot
- Plugin-version swap via `git worktree`
- Docs: quickstart, concepts, config, rubrics, judges, CI, troubleshooting, promptfoo-comparison
```

Update `package.json`:
```json
  "repository": { "type": "git", "url": "git+https://github.com/<owner>/eval-bench.git" },
  "bugs": { "url": "https://github.com/<owner>/eval-bench/issues" },
  "homepage": "https://github.com/<owner>/eval-bench#readme",
  "keywords": ["claude", "claude-code", "llm", "eval", "benchmark", "plugin", "skills", "mcp"],
```

- [ ] **Step 4: Run test — PASS**

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md package.json tests/release.test.ts
git commit -m "chore: add CHANGELOG; fill package.json repository/bugs/homepage"
```

---

### Task 32: Final check — coverage, publish dry-run

**Files:**
- Modify: `package.json` (add `coverage` script)
- Create: `tests/coverage-floor.test.ts` (soft check — runs but does not fail CI)

- [ ] **Step 1: Add coverage script**

`package.json` scripts:
```json
  "test:coverage": "vitest run --coverage",
  "publish:dry": "npm publish --dry-run"
```

- [ ] **Step 2: Run coverage locally**

Run: `npm run test:coverage`
Expected: at least 85% line coverage across `src/**`.

- [ ] **Step 3: Run publish dry-run**

Run: `npm run publish:dry`
Expected: exit 0; no secrets in the tarball; `templates/` included; `tests/` excluded.

- [ ] **Step 4: Verify package contents**

Run: `npm pack --dry-run`
Expected: file list includes `dist/`, `templates/`, `README.md`, `LICENSE`, `CHANGELOG.md` — and excludes `tests/`, `docs/`, `src/`, `.github/`.

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "chore: add test:coverage and publish:dry scripts"
```

---

## Self-review notes

- **Spec coverage:** every spec section maps to ≥1 task. CLI surface (spec §5) → Tasks 3, 20–24. Config (§6) → Tasks 4–6. Walkthrough (§7) covered by e2e (Task 29) and quickstart docs (Task 26). CI sample (§8) → Tasks 20, 28. Judges (§9) → Tasks 10–14, doc in Task 27. Output format (§10) → Tasks 17, 18, 19. UI (§11) → Task 24. Docs plan (§12) → Tasks 25–28. Tech choices (§13) → Tasks 1–2. MVP scope (§14) matches; deferred items are *not* in the plan.
- **Placeholder scan:** none of TBD / TODO / implement later / similar-to-task-N appear.
- **Type consistency:** `Config`, `PromptSpec`, `RunResult`, `Judgment`, `Snapshot`, `Comparison`, `PromptDelta` defined in Task 4 and used verbatim elsewhere. `judge()` signature, `JudgeConfig`, `invokeClaude()` signature, `runBenchmark()` options — all match across tasks.
- **Ordering note:** Task 12 (OpenAI judge wrapper) imports from Task 13 (`openai-compatible`). Flagged inline — complete Task 13 before running Task 12's tests; commit both after Task 13.

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-23-eval-bench-plan.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach? (To execute now, you will also need to create the target repository first — see `docs/superpowers/specs/2026-04-23-eval-bench-spec.md` §13 for the layout and §14 for MVP scope.)

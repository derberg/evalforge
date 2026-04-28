export type JudgeProvider =
  | 'ollama'
  | 'anthropic'
  | 'openai'
  | 'openai-compatible'
  | 'openrouter'
  | 'github-models'
  | 'claude-cli';

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
  // null = succeeded; string = judge threw with this message.
  // Set to "run failed" when the underlying Claude run produced no output.
  // Resume retries judgments where this is set (and run.output exists).
  error: string | null;
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
  // Absent on legacy snapshots; treat as complete when loading.
  complete?: boolean;
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

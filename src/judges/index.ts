import type { Config, Judgment, JudgeProvider } from '../types.js';
import { hashRubric } from './rubric.js';
import { judgeWithOllama } from './ollama.js';
import { judgeWithAnthropic } from './anthropic.js';
import { judgeWithOpenAI } from './openai.js';
import { judgeWithOpenAICompatible } from './openai-compatible.js';
import { judgeWithOpenRouter } from './openrouter.js';
import { judgeWithGithubModels } from './github-models.js';
import { judgeWithClaudeCli } from './claude-cli.js';

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
  openrouter: 'OPENROUTER_API_KEY',
  'github-models': 'GITHUB_TOKEN',
  'claude-cli': null,
};

export async function judge(
  cfg: JudgeConfig,
  input: JudgeInput,
): Promise<Omit<Judgment, 'runId'>> {
  const apiKeyEnv = cfg.apiKeyEnv ?? DEFAULT_API_KEY_ENV[cfg.provider];
  const apiKey = apiKeyEnv ? (process.env[apiKeyEnv] ?? null) : null;
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
    case 'openrouter':
      if (!apiKey) throw new Error(`openrouter: API key not set (env ${apiKeyEnv})`);
      res = await judgeWithOpenRouter({
        endpoint: cfg.endpoint ?? undefined,
        apiKey,
        model: cfg.model,
        temperature: cfg.temperature,
        maxTokens: cfg.maxTokens,
        ...input,
      });
      break;
    case 'github-models':
      if (!apiKey) throw new Error(`github-models: API key not set (env ${apiKeyEnv})`);
      res = await judgeWithGithubModels({
        endpoint: cfg.endpoint ?? undefined,
        apiKey,
        model: cfg.model,
        temperature: cfg.temperature,
        maxTokens: cfg.maxTokens,
        ...input,
      });
      break;
    case 'claude-cli':
      res = await judgeWithClaudeCli({
        model: cfg.model,
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
    error: null,
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

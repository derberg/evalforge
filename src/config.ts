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
      provider: z.enum([
        'ollama',
        'anthropic',
        'openai',
        'openai-compatible',
        'openrouter',
        'github-models',
        'claude-cli',
      ]),
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
        dir: z.string().default('./.eval-bench/snapshots'),
      })
      .default({}),
  })
  .superRefine((cfg, ctx) => {
    if (
      (cfg.judge.provider === 'ollama' || cfg.judge.provider === 'openai-compatible') &&
      !cfg.judge.endpoint
    ) {
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

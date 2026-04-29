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

export function filterPrompts(prompts: PromptSpec[], ids: string[]): PromptSpec[] {
  const known = new Set(prompts.map((p) => p.id));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length) {
    throw new Error(
      `unknown prompt id(s): ${missing.join(', ')}. Available: ${prompts.map((p) => p.id).join(', ')}`,
    );
  }
  const want = new Set(ids);
  return prompts.filter((p) => want.has(p.id));
}

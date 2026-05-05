export interface ParsedJudgment {
  score: number;
  rationale: string;
}

export class JudgeParseError extends Error {
  readonly raw: string;
  constructor(message: string, raw: string) {
    super(message);
    this.name = 'JudgeParseError';
    this.raw = raw;
  }
}

const FENCE_RE = /```(?:json)?\s*([\s\S]*?)```/i;

export function parseJudgeResponse(raw: string): ParsedJudgment {
  const trimmed = raw.trim();

  // Try strategies in order. Parsing the raw response as-is comes FIRST so
  // we don't accidentally strip code fences that appear inside the JSON
  // string (e.g. a rationale describing the rubric's ```likec4 syntax — the
  // non-greedy fence regex would otherwise match between two backticks
  // inside the rationale string and feed the model a malformed slice).
  // Brace-slice runs last because it can misfire when the rationale itself
  // contains brace-like substrings.
  const candidates: string[] = [trimmed];
  const fenceMatch = trimmed.match(FENCE_RE);
  if (fenceMatch) candidates.push(fenceMatch[1].trim());
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  let obj: object | null = null;
  let lastErr: Error | null = null;
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed === 'object' && parsed !== null) {
        obj = parsed;
        break;
      }
      // Non-object root (e.g. a bare number or string) — keep trying.
      lastErr = new Error('JSON root must be an object');
    } catch (err) {
      lastErr = err as Error;
    }
  }

  if (obj === null) {
    throw new JudgeParseError(
      `judge response: could not parse JSON (${lastErr?.message ?? 'no candidates worked'})`,
      raw,
    );
  }
  const { score, rationale } = obj as { score?: unknown; rationale?: unknown };
  if (typeof score !== 'number' || Number.isNaN(score)) {
    throw new JudgeParseError('judge response: missing or non-numeric "score"', raw);
  }
  if (typeof rationale !== 'string') {
    throw new JudgeParseError('judge response: missing string "rationale"', raw);
  }
  const clamped = Math.max(0, Math.min(5, score));
  return { score: clamped, rationale };
}

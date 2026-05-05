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
  let candidate = raw.trim();
  const fenceMatch = candidate.match(FENCE_RE);
  if (fenceMatch) {
    candidate = fenceMatch[1].trim();
  } else {
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
    throw new JudgeParseError(
      `judge response: could not parse JSON (${(err as Error).message})`,
      raw,
    );
  }
  if (typeof obj !== 'object' || obj === null) {
    throw new JudgeParseError('judge response: JSON root must be an object', raw);
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

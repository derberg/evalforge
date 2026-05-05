import { describe, it, expect } from 'vitest';
import { parseJudgeResponse, JudgeParseError } from '../../src/judges/parse.js';

describe('parseJudgeResponse', () => {
  it('parses a well-formed JSON response', () => {
    const { score, rationale } = parseJudgeResponse('{"score": 4.2, "rationale": "good"}');
    expect(score).toBe(4.2);
    expect(rationale).toBe('good');
  });

  it('extracts JSON from a fenced block', () => {
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

  it('throws JudgeParseError carrying the original raw response on JSON failure', () => {
    const raw = 'c4 rather than mermaid — this looks like a LikeC4 diagram, not JSON.';
    let caught: unknown = null;
    try {
      parseJudgeResponse(raw);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(JudgeParseError);
    expect((caught as JudgeParseError).raw).toBe(raw);
  });

  it('parses JSON whose rationale contains code fences (real Sonnet 4.6 response)', () => {
    // Verbatim shape of a response that broke pre-0.11.4: rationale describes
    // a ```c4 fence vs the expected ```likec4, so the non-greedy fence regex
    // would match between the two backtick triplets inside the JSON string
    // and produce the malformed slice "c4 rather than the rubric-specified ".
    const raw =
      '{"score": 4.5, "rationale": "minor format issue: fenced block is labelled ```c4 rather than the rubric-specified ```likec4, otherwise spec-compliant."}';
    const { score, rationale } = parseJudgeResponse(raw);
    expect(score).toBe(4.5);
    expect(rationale).toMatch(/```c4 rather than/);
    expect(rationale).toMatch(/```likec4/);
  });

  it('falls back to fence extraction when prose surrounds a fenced JSON block', () => {
    const raw = "Sure, here's the score:\n```json\n{\"score\": 3, \"rationale\": \"ok\"}\n```\nLet me know if you want elaboration.";
    const { score, rationale } = parseJudgeResponse(raw);
    expect(score).toBe(3);
    expect(rationale).toBe('ok');
  });

  it('falls back to brace extraction when prose surrounds a bare JSON object', () => {
    const raw = 'Score: {"score": 2, "rationale": "meh"} — that is my read.';
    const { score, rationale } = parseJudgeResponse(raw);
    expect(score).toBe(2);
    expect(rationale).toBe('meh');
  });

  it('throws JudgeParseError with raw when score is missing', () => {
    const raw = '{"rationale": "no score"}';
    let caught: unknown = null;
    try {
      parseJudgeResponse(raw);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(JudgeParseError);
    expect((caught as JudgeParseError).raw).toBe(raw);
  });
});

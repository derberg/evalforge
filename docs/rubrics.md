# Rubrics

## What is a rubric?

A rubric is the grading sheet you write for each prompt. It says, in plain text, what "good" looks like for *this specific prompt* — so the judge can hand back a 0–5 score with a clear rationale.

Think of it as the answer key a teacher gives a TA before grading exams. Without one, the TA invents their own standard and grades differently every time. With one, two different TAs land on roughly the same score.

You write one rubric per prompt, alongside the prompt in `.eval-bench/prompts.yaml`:

```yaml
- id: list-products
  prompt: |
    List every product the docs mention.
  rubric: |
    Score 0-5:
    - Names every product (0-2)
    - Each has a one-line summary (0-2)
    - No products that don't exist (0-1)
```

That's it — plain text, with point values that add up to 5. The judge reads the prompt, the plugin's output, and this rubric, then returns a score and a rationale. The score lands in the snapshot; the comparison between snapshots is what tells you whether your change was an improvement or a regression.

The rest of this page is about writing rubrics that produce reliable scores instead of noise.

## Why rubrics matter

The judge sees three things: the prompt, the output, and the rubric. It scores 0–5 with a rationale. Without specific criteria, the judge has to invent its own — and it will invent differently each time, especially with smaller models. With explicit criteria, you reduce its job to checking each box, which is far more deterministic.

## Structure of a good rubric

Numbered criteria with explicit point values, totalling 5. Optionally a penalty clause for hallucination.

```
Score 0-5 on:
- Completeness (0-2): names every product currently in the docs
- Accuracy (0-2): one-liners match the official documented purpose
- Format (0-1): readable list, no padding or filler
Penalty: -1 if it invents products that don't exist.
```

## Good example

A rubric for a prompt that should invoke an MCP tool:

```
Score 0-5 on:
- Tool invocation (0-2): actually calls the db.query MCP tool; does not invent results
- Correctness (0-2): returns exactly 5 rows in descending date order
- Formatting (0-1): valid markdown table with column headers
Penalty: -2 if it fabricates order data instead of calling the tool.
```

The judge has clear yes/no checks per criterion. Two different judge models will agree on this within ±0.5 most of the time.

## Bad example

```
Score 0-5: is this a good response?
```

This forces the judge to invent its own quality criteria. Two runs of the same model on the same output will produce different scores. Two different models will produce wildly different scores. Useless as a regression signal.

## One rubric per plugin component path

Different plugin components warrant different rubrics. Don't try to write a generic rubric that grades skill-driven, MCP-tool-driven, and subagent-delegated outputs uniformly — they have different success criteria.

- **Skill prompts:** grade content quality + correctness against the skill's docs.
- **MCP-tool prompts:** grade *whether the tool was invoked* + result correctness.
- **Subagent prompts:** grade *whether delegation happened* + the subagent's specific concerns.
- **Slash-command prompts:** grade *invocation* + reporting.
- **Hook-affected prompts:** grade the post-hook behavior, not the original tool call.

## Common pitfalls

1. **Open-ended quality questions.** "Is this output helpful?" is judge-roulette. Decompose into specific dimensions.
2. **Rubrics longer than the output.** If your rubric is two pages and the answer is one paragraph, the judge will weight criteria randomly. Keep rubrics tight.
3. **No penalty for hallucination.** Without a penalty, judges often score plausible-but-wrong content highly. Add an explicit penalty when factual accuracy matters.
4. **Different rubrics across runs.** If you change the rubric, you've changed the measurement instrument. Keep rubrics stable across snapshots you intend to compare. The tool hashes the rubric (`rubricHash` in snapshot JSON) so you can detect drift.

## Test your rubric

Before committing to a rubric, run it through two different judges (e.g. Ollama qwen2.5:14b and Claude Opus). If their scores disagree by more than 1 point on the same output, your rubric is too vague. Tighten it until they agree.

## Calibration tip

Run `samples: 5` on a stable prompt+output for a single variant. Look at the variance in `summary`. If variance > 0.3 (out of a 0–5 range) on identical inputs, the rubric is producing noise. Tighten it or use a larger judge.

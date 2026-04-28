#!/usr/bin/env node
// Stand-in for `claude -p --output-format json`: returns a JSON envelope with
// the prompt echoed in `result` plus a deterministic `usage` block so token
// extraction can be asserted on.
const args = process.argv.slice(2);
const promptIdx = args.indexOf('-p');
const prompt = promptIdx >= 0 ? args[promptIdx + 1] : '';
const payload = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 10,
  result: `[PLUGIN_DIR=${process.env.EVAL_BENCH_PLUGIN_DIR ?? ''}] ${prompt}`,
  total_cost_usd: 0.0123,
  usage: {
    input_tokens: 11,
    output_tokens: 22,
    cache_read_input_tokens: 33,
    cache_creation_input_tokens: 44,
  },
};
console.log(JSON.stringify(payload));
process.exit(0);

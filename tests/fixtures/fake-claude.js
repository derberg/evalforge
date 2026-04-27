#!/usr/bin/env node
// Minimal stand-in for `claude -p`: echoes the last arg, plus env-var marker.
const args = process.argv.slice(2);
const promptIdx = args.indexOf('-p');
const prompt = promptIdx >= 0 ? args[promptIdx + 1] : '';
console.log(`[PLUGIN_DIR=${process.env.EVAL_BENCH_PLUGIN_DIR ?? ''}] ${prompt}`);
process.exit(0);

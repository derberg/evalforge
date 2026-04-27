#!/usr/bin/env node
const args = process.argv.slice(2);
const p = args[args.indexOf('-p') + 1];
console.log(`PLUGIN=${process.env.EVAL_BENCH_PLUGIN_DIR ?? ''} P=${p}`);

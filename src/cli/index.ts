#!/usr/bin/env node
import { Command } from 'commander';
import { version } from '../index.js';

const program = new Command();

program
  .name('eval-bench')
  .description('Benchmark Claude Code skills/agents/plugins by A/B comparing versions with LLM judging.')
  .version(version);

program
  .command('init')
  .description('Scaffold a benchmark config in the current directory.')
  .option('--ci', 'Also emit a GitHub Actions workflow')
  .action(async (opts) => {
    const { runInit } = await import('./init.js');
    await runInit({ cwd: process.cwd(), ci: Boolean(opts.ci) });
  });

program
  .command('run')
  .description('Run a benchmark against the plugin.')
  .option('--plugin <path>', 'Path to plugin')
  .option('--baseline <ref>', 'Git ref for baseline')
  .option('--baseline-from <name>', 'Reuse baseline runs from a saved snapshot instead of regenerating them')
  .option('--current <ref>', 'Git ref for current', 'HEAD')
  .option('--prompts <file>', 'Prompts file', './.eval-bench/prompts.yaml')
  .option('--config <file>', 'Config file', './.eval-bench/eval-bench.yaml')
  .option('--samples <n>', 'Override samples-per-prompt', (v) => parseInt(v, 10))
  .option(
    '--only <ids>',
    'Run only these prompt ids (comma-separated, repeatable)',
    (v: string, prev?: string[]) => {
      const next = v.split(',').map((s) => s.trim()).filter(Boolean);
      return prev ? [...prev, ...next] : next;
    },
  )
  .option('--judge <spec>', 'Override judge, e.g. ollama:qwen2.5:14b')
  .option('--save-as <name>', 'Save snapshot under this name')
  .option('--compare <name>', 'After running, compare against this snapshot')
  .option('--fail-on-regression <n>', 'Exit nonzero if net score drops more than <n>', parseFloat)
  .option('--force', 'Overwrite an existing complete snapshot with the same --save-as name')
  .option('--dry-run', 'Print planned matrix without running')
  .option('-v, --verbose')
  .action(async (opts) => {
    const { runCommand } = await import('./run.js');
    const code = await runCommand({
      cwd: process.cwd(),
      plugin: opts.plugin,
      baseline: opts.baseline,
      baselineFrom: opts.baselineFrom,
      current: opts.current,
      prompts: opts.prompts,
      config: opts.config,
      samples: opts.samples,
      only: opts.only,
      judge: opts.judge,
      saveAs: opts.saveAs,
      compare: opts.compare,
      failOnRegression: opts.failOnRegression,
      force: Boolean(opts.force),
      dryRun: opts.dryRun,
      verbose: opts.verbose,
    });
    process.exit(code);
  });

program
  .command('eval')
  .description('Run the eval matrix at a single ref and save a snapshot. Pair with `eb compare` to diff snapshots.')
  .requiredOption('--save-as <name>', 'Save snapshot under this name')
  .option('--ref <ref>', 'Git ref to evaluate', 'HEAD')
  .option('--plugin <path>', 'Path to plugin')
  .option('--prompts <file>', 'Prompts file', './.eval-bench/prompts.yaml')
  .option('--config <file>', 'Config file', './.eval-bench/eval-bench.yaml')
  .option('--judge <spec>', 'Override judge, e.g. ollama:qwen2.5:14b')
  .option('--force', 'Overwrite an existing complete snapshot with the same name')
  .option(
    '--only <ids>',
    'Run only these prompt ids (comma-separated, repeatable)',
    (v: string, prev?: string[]) => {
      const next = v.split(',').map((s) => s.trim()).filter(Boolean);
      return prev ? [...prev, ...next] : next;
    },
  )
  .option('--dry-run', 'Print planned matrix without running')
  .action(async (opts) => {
    const { evalCommand } = await import('./eval.js');
    const code = await evalCommand({
      cwd: process.cwd(),
      plugin: opts.plugin,
      ref: opts.ref,
      prompts: opts.prompts,
      config: opts.config,
      judge: opts.judge,
      saveAs: opts.saveAs,
      force: Boolean(opts.force),
      only: opts.only,
      dryRun: opts.dryRun,
    });
    process.exit(code);
  });

async function snapshotsDir(): Promise<string> {
  try {
    const { loadConfig } = await import('../config.js');
    const cfg = loadConfig('.eval-bench/eval-bench.yaml');
    return cfg.snapshots.dir;
  } catch {
    return './.eval-bench/snapshots';
  }
}

program
  .command('view [snapshot]')
  .description('Render an HTML view for a snapshot and open it.')
  .action(async (snapshotName) => {
    const dir = await snapshotsDir();
    const { listSnapshots } = await import('../snapshot.js');
    const name = snapshotName ?? (await listSnapshots(dir)).at(-1);
    if (!name) {
      console.error('no snapshots found');
      process.exit(1);
    }
    const { viewCommand } = await import('./view.js');
    await viewCommand({ dir, name, writeHtml: true, open: true });
    console.log(`opened view for snapshot "${name}"`);
  });

const snapshot = program.command('snapshot').description('Manage saved snapshots.');
snapshot.command('list').action(async () => {
  const { snapshotList } = await import('./snapshot.js');
  const dir = await snapshotsDir();
  const list = await snapshotList(dir);
  for (const n of list) console.log(n);
});
snapshot.command('show <name>').action(async (name) => {
  const { snapshotShow } = await import('./snapshot.js');
  const dir = await snapshotsDir();
  console.log(await snapshotShow(dir, name));
});
snapshot.command('rm <name>').action(async (name) => {
  const { snapshotRm } = await import('./snapshot.js');
  const dir = await snapshotsDir();
  await snapshotRm(dir, name);
  console.log(`removed ${name}`);
});

program
  .command('compare <a> <b>')
  .description('Compare two snapshots.')
  .option('--format <fmt>', 'md | json | both', 'md')
  .option('--out <path>', 'Write to file (default: stdout)')
  .option('--threshold <n>', 'Only show prompts where score delta > <n>', parseFloat)
  .action(async (a, b, opts) => {
    const { compareCommand } = await import('./compare.js');
    const dir = await snapshotsDir();
    const out = await compareCommand({
      dir,
      from: a,
      to: b,
      format: opts.format ?? 'md',
      threshold: opts.threshold,
    });
    if (opts.out) {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(opts.out, out);
    } else {
      console.log(out);
    }
  });

program.parseAsync().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

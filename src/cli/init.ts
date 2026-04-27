import { mkdir, writeFile, access, readFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates');

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function copyTemplate(templateName: string, targetPath: string): Promise<boolean> {
  if (await exists(targetPath)) return false;
  const contents = await readFile(join(TEMPLATES_DIR, templateName), 'utf8');
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, contents);
  return true;
}

export async function runInit(opts: { cwd: string; ci: boolean }): Promise<void> {
  const wrote: string[] = [];
  const skipped: string[] = [];
  if (await copyTemplate('eval-bench.yaml', join(opts.cwd, '.eval-bench', 'eval-bench.yaml')))
    wrote.push('.eval-bench/eval-bench.yaml');
  else skipped.push('.eval-bench/eval-bench.yaml');
  if (await copyTemplate('prompts.yaml', join(opts.cwd, '.eval-bench', 'prompts.yaml')))
    wrote.push('.eval-bench/prompts.yaml');
  else skipped.push('.eval-bench/prompts.yaml');
  const keep = join(opts.cwd, '.eval-bench', 'snapshots', '.gitkeep');
  if (!(await exists(keep))) {
    await mkdir(dirname(keep), { recursive: true });
    await writeFile(keep, '');
    wrote.push('.eval-bench/snapshots/.gitkeep');
  }
  if (opts.ci) {
    const ciTarget = join(opts.cwd, '.github', 'workflows', 'eval-bench.yml');
    if (await copyTemplate('github-action.yml', ciTarget))
      wrote.push('.github/workflows/eval-bench.yml');
    else skipped.push('.github/workflows/eval-bench.yml');
  }
  for (const f of wrote) console.log(`  created  ${f}`);
  for (const f of skipped) console.log(`  skipped  ${f} (already exists)`);
  console.log('');
  console.log('Next steps:');
  console.log('  1. Edit .eval-bench/prompts.yaml — write 3-5 prompts that exercise your plugin');
  console.log('  2. Edit .eval-bench/eval-bench.yaml — set judge provider and model');
  console.log('  3. Run: eb run --baseline <ref> --save-as v1-baseline');
}

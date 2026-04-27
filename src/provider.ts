import { execa } from 'execa';
import { access, mkdir, writeFile, readdir, symlink } from 'node:fs/promises';
import { join, basename, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

export interface InvokeClaudeOptions {
  command: string;
  extraArgs: string[];
  prompt: string;
  pluginDir: string;
  timeoutMs: number;
  model: string | null;
  allowedTools: string[] | null;
}

export interface InvokeClaudeResult {
  output: string;
  exitCode: number;
  durationMs: number;
  error: string | null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function discoverFiles(dir: string, pattern: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const found: string[] = [];
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        found.push(...(await discoverFiles(fullPath, pattern)));
      } else if (entry.name.endsWith(pattern)) {
        found.push(fullPath);
      }
    }
    return found;
  } catch {
    return [];
  }
}

interface TempPluginSetup {
  tempDir: string;
  cleanup: () => Promise<void>;
}

async function setupTempPlugin(pluginDir: string): Promise<TempPluginSetup | null> {
  const pluginJsonPath = join(pluginDir, '.claude-plugin', 'plugin.json');
  
  // If plugin.json exists, no temp setup needed
  if (await exists(pluginJsonPath)) {
    return null;
  }

  // Discover skills and agents
  const skillsDir = join(pluginDir, 'skills');
  const agentsDir = join(pluginDir, 'agents');
  const skillFiles = await discoverFiles(skillsDir, '.md');
  const agentFiles = await discoverFiles(agentsDir, '.md');

  // If no skills or agents found, return null (let Claude fail naturally)
  if (skillFiles.length === 0 && agentFiles.length === 0) {
    return null;
  }

  // Create temp directory
  const tempDir = join(tmpdir(), `eval-bench-${randomBytes(8).toString('hex')}`);
  await mkdir(tempDir, { recursive: true });

  try {
    // Create .claude-plugin directory
    const tempPluginDir = join(tempDir, '.claude-plugin');
    await mkdir(tempPluginDir, { recursive: true });

    // Generate minimal plugin.json
    const manifest: Record<string, unknown> = {
      name: basename(pluginDir),
      version: '0.0.0-eval-bench-temp',
    };

    if (skillFiles.length > 0) {
      manifest.skills = skillFiles.map((f) => relative(pluginDir, f));
      // Symlink skills directory
      await symlink(skillsDir, join(tempDir, 'skills'), 'dir').catch(() => {
        // Fallback: ignore if symlink fails (Windows might need different approach)
      });
    }

    if (agentFiles.length > 0) {
      manifest.agents = agentFiles.map((f) => relative(pluginDir, f));
      // Symlink agents directory
      await symlink(agentsDir, join(tempDir, 'agents'), 'dir').catch(() => {
        // Fallback: ignore if symlink fails
      });
    }

    await writeFile(join(tempPluginDir, 'plugin.json'), JSON.stringify(manifest, null, 2));

    return {
      tempDir,
      cleanup: async () => {
        // Clean up temp directory
        const { rm } = await import('node:fs/promises');
        await rm(tempDir, { recursive: true, force: true }).catch(() => {
          // Ignore cleanup errors
        });
      },
    };
  } catch (err) {
    // Clean up on error
    const { rm } = await import('node:fs/promises');
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

export async function invokeClaude(opts: InvokeClaudeOptions): Promise<InvokeClaudeResult> {
  // Setup temp plugin if needed
  const tempSetup = await setupTempPlugin(opts.pluginDir);
  const effectivePluginDir = tempSetup?.tempDir ?? opts.pluginDir;

  try {
    const args = [...opts.extraArgs, '-p', opts.prompt];
    if (opts.model) {
      args.push('--model', opts.model);
    }
    if (opts.allowedTools && opts.allowedTools.length > 0) {
      args.push('--allowed-tools', opts.allowedTools.join(','));
    }
    const started = Date.now();
    try {
      const result = await execa(opts.command, args, {
        timeout: opts.timeoutMs,
        reject: false,
        env: {
          ...process.env,
          EVAL_BENCH_PLUGIN_DIR: effectivePluginDir,
        },
      });
      const durationMs = Date.now() - started;
      const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
      if (result.timedOut) {
        return { output, exitCode: result.exitCode ?? -1, durationMs, error: 'timed out' };
      }
      if (result.exitCode !== 0) {
        return {
          output,
          exitCode: result.exitCode ?? -1,
          durationMs,
          error: result.stderr || 'non-zero exit',
        };
      }
      return { output, exitCode: 0, durationMs, error: null };
    } catch (err) {
      const durationMs = Date.now() - started;
      const msg = err instanceof Error ? err.message : String(err);
      return { output: '', exitCode: -1, durationMs, error: msg };
    }
  } finally {
    // Clean up temp plugin if it was created
    if (tempSetup) {
      await tempSetup.cleanup();
    }
  }
}

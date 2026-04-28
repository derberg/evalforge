import { execa } from 'execa';
import { access, mkdir, writeFile, readdir, symlink } from 'node:fs/promises';
import { join, basename, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { RunUsage } from './types.js';

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
  usage: RunUsage | null;
}

interface ClaudeJsonResult {
  result?: unknown;
  total_cost_usd?: unknown;
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
    cache_read_input_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
  };
}

function num(x: unknown): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : 0;
}

// Returns { output, usage } if stdout is a Claude `--output-format json`
// payload; null if we should fall back to treating raw stdout as output.
function parseClaudeJson(stdout: string): { output: string; usage: RunUsage } | null {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith('{')) return null;
  let parsed: ClaudeJsonResult;
  try {
    parsed = JSON.parse(trimmed) as ClaudeJsonResult;
  } catch {
    return null;
  }
  if (typeof parsed.result !== 'string' || !parsed.usage) return null;
  return {
    output: parsed.result,
    usage: {
      inputTokens: num(parsed.usage.input_tokens),
      outputTokens: num(parsed.usage.output_tokens),
      cacheReadInputTokens: num(parsed.usage.cache_read_input_tokens),
      cacheCreationInputTokens: num(parsed.usage.cache_creation_input_tokens),
      totalCostUsd: num(parsed.total_cost_usd),
    },
  };
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

  // Auto-inject `--output-format json` so we can capture token usage. If the
  // user already specified an output format, respect their choice and accept
  // that we won't get usage data from this run.
  const userSpecifiedFormat = opts.extraArgs.some(
    (a) => a === '--output-format' || a.startsWith('--output-format='),
  );
  const formatArgs = userSpecifiedFormat ? [] : ['--output-format', 'json'];

  try {
    const args = [...opts.extraArgs, ...formatArgs, '-p', opts.prompt];
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
      const rawStdout = result.stdout ?? '';
      const parsed = parseClaudeJson(rawStdout);
      const output = parsed
        ? parsed.output
        : [rawStdout, result.stderr].filter(Boolean).join('\n');
      const usage = parsed?.usage ?? null;
      if (result.timedOut) {
        return { output, exitCode: result.exitCode ?? -1, durationMs, error: 'timed out', usage };
      }
      if (result.exitCode !== 0) {
        return {
          output,
          exitCode: result.exitCode ?? -1,
          durationMs,
          error: result.stderr || 'non-zero exit',
          usage,
        };
      }
      return { output, exitCode: 0, durationMs, error: null, usage };
    } catch (err) {
      const durationMs = Date.now() - started;
      const msg = err instanceof Error ? err.message : String(err);
      return { output: '', exitCode: -1, durationMs, error: msg, usage: null };
    }
  } finally {
    // Clean up temp plugin if it was created
    if (tempSetup) {
      await tempSetup.cleanup();
    }
  }
}

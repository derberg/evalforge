import { loadSnapshot } from '../snapshot.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Snapshot } from '../types.js';

function escape(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c);
}

function fmtUsage(r: { usage?: { inputTokens: number; outputTokens: number; totalCostUsd: number } | null }): string {
  if (!r.usage) return '';
  const u = r.usage;
  return `<div class="tok">in ${u.inputTokens.toLocaleString('en-US')} · out ${u.outputTokens.toLocaleString('en-US')} · $${u.totalCostUsd.toFixed(4)}</div>`;
}

function renderHtml(s: Snapshot): string {
  const rows = s.prompts.map((p) => {
    const variants = (['baseline', 'current'] as const).map((v) => {
      const runs = s.runs.filter((r) => r.promptId === p.id && r.variant === v);
      const cells = runs
        .map((r) => {
          const j = s.judgments.find((x) => x.runId === r.id);
          return `<div class="cell"><div class="score">score ${j?.score ?? '-'}</div>${fmtUsage(r)}<pre>${escape(r.output).slice(0, 800)}</pre><div class="rat">${escape(j?.rationale ?? '')}</div></div>`;
        })
        .join('');
      return `<div class="variant"><h4>${v}</h4>${cells}</div>`;
    });
    return `<section><h3>${escape(p.id)}</h3><p class="prompt">${escape(p.prompt)}</p>${variants.join('')}</section>`;
  });
  const t = s.summary.tokens;
  const tokenLine = t
    ? `<p>tokens — baseline in/out ${t.baseline.inputTokens.toLocaleString('en-US')}/${t.baseline.outputTokens.toLocaleString('en-US')} ($${t.baseline.totalCostUsd.toFixed(4)}) · current in/out ${t.current.inputTokens.toLocaleString('en-US')}/${t.current.outputTokens.toLocaleString('en-US')} ($${t.current.totalCostUsd.toFixed(4)}) · cost Δ ${t.costDelta >= 0 ? '+' : ''}$${t.costDelta.toFixed(4)}</p>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escape(s.name)}</title>
<style>
body{font:14px -apple-system,sans-serif;margin:2em;color:#111}
section{border-top:1px solid #eee;padding-top:1em;margin-top:2em}
.variant{display:inline-block;vertical-align:top;width:48%;margin-right:1%}
.cell{background:#f7f7f7;padding:0.5em;margin:0.5em 0;border-radius:4px}
.score{font-weight:bold;color:#0a0}
.tok{color:#888;font-size:11px;margin:0.2em 0}
pre{white-space:pre-wrap;font-size:12px}
.rat{color:#666;font-size:12px;margin-top:0.3em}
.prompt{background:#eef;padding:0.5em;border-radius:4px}
h1{margin-bottom:0}
.meta{color:#666;font-size:12px}
</style></head>
<body>
<h1>${escape(s.name)}</h1>
<div class="meta">created ${s.createdAt} · judge ${s.judge.provider}/${s.judge.model} · baseline ${escape(s.plugin.baselineRef)} · current ${escape(s.plugin.currentRef)}</div>
<p>baseline mean ${s.summary.baseline.mean.toFixed(2)} · current mean ${s.summary.current.mean.toFixed(2)} · delta ${s.summary.delta.toFixed(2)}</p>
${tokenLine}
${rows.join('')}
</body></html>`;
}

export async function viewCommand(opts: {
  dir: string;
  name: string;
  writeHtml: boolean;
  open: boolean;
}): Promise<string> {
  const snap = await loadSnapshot(opts.dir, opts.name);
  const html = renderHtml(snap);
  if (opts.writeHtml) {
    const path = join(opts.dir, opts.name, 'view.html');
    await writeFile(path, html);
    if (opts.open) {
      const { execa } = await import('execa');
      const cmd =
        process.platform === 'darwin'
          ? 'open'
          : process.platform === 'win32'
            ? 'start'
            : 'xdg-open';
      await execa(cmd, [path], { detached: true, stdio: 'ignore' }).catch(() => {});
    }
  }
  return html;
}

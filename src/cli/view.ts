import { loadSnapshot } from '../snapshot.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Snapshot, Variant } from '../types.js';

function escape(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c);
}

// Render `<ref>@<short-sha>` so two snapshots labelled "HEAD" but pointing at
// different commits — common after `--baseline-from`/`--current-from` stitches
// inherit ref strings from their sources — are visually distinct in the view.
// Falls back to whichever piece is non-empty if the other is missing.
function refLabel(ref: string, sha: string): string {
  if (!sha) return ref;
  const short = sha.slice(0, 7);
  if (!ref || ref === sha || ref === short) return short;
  return `${ref}@${short}`;
}

function fmtUsage(r: { usage?: { inputTokens: number; outputTokens: number; totalCostUsd: number } | null }): string {
  if (!r.usage) return '';
  const u = r.usage;
  return `<div class="cell-tok">in ${u.inputTokens.toLocaleString('en-US')} · out ${u.outputTokens.toLocaleString('en-US')} · $${u.totalCostUsd.toFixed(4)}</div>`;
}

function scoreClass(score: number): string {
  if (score === 0) return 'fail';
  if (score >= 4.5) return 'great';
  if (score >= 3.5) return 'ok';
  if (score >= 2.5) return 'meh';
  return 'bad';
}

function meanFor(s: Snapshot, promptId: string, variant: Variant): { mean: number; n: number; failed: number } {
  const runs = s.runs.filter((r) => r.promptId === promptId && r.variant === variant);
  const scores: number[] = [];
  let failed = 0;
  for (const r of runs) {
    const j = s.judgments.find((x) => x.runId === r.id);
    if (!j) continue;
    if (j.score === 0 || j.error) failed++;
    scores.push(j.score);
  }
  const mean = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  return { mean, n: scores.length, failed };
}

interface Verdict {
  label: string;
  klass: 'good' | 'bad' | 'mixed' | 'neutral' | 'partial';
  hook: string;
  reasons: string[];
}

function computeVerdict(s: Snapshot): Verdict {
  const scoreDelta = s.summary.delta;
  const costDelta = s.summary.tokens?.costDelta ?? 0;
  const baseN = s.summary.baseline.n;
  const curN = s.summary.current.n;
  const failed = s.judgments.filter((j) => j.score === 0 || j.error).length;
  const hasTokens = !!s.summary.tokens;

  if (curN === 0)
    return { label: 'baseline only', klass: 'partial', hook: 'No current variant runs to compare against.', reasons: [] };
  if (baseN === 0)
    return { label: 'current only', klass: 'partial', hook: 'No baseline variant runs to compare against.', reasons: [] };

  const scoreRegressed = scoreDelta < -0.2;
  const scoreImproved = scoreDelta > 0.2;
  const costSaved = hasTokens && costDelta < -0.05;
  const costGrew = hasTokens && costDelta > 0.05;

  const reasons: string[] = [];
  if (failed > 0) reasons.push(`${failed} run${failed > 1 ? 's' : ''} failed (score 0)`);
  if (scoreRegressed) reasons.push(`quality dropped ${Math.abs(scoreDelta).toFixed(2)} pts`);
  else if (scoreImproved) reasons.push(`quality rose ${scoreDelta.toFixed(2)} pts`);
  else reasons.push(`quality held steady (Δ ${scoreDelta >= 0 ? '+' : ''}${scoreDelta.toFixed(2)})`);
  if (costSaved) reasons.push(`cost fell $${Math.abs(costDelta).toFixed(2)}`);
  else if (costGrew) reasons.push(`cost rose $${costDelta.toFixed(2)}`);

  let label: string;
  let klass: Verdict['klass'];
  let hook: string;

  if (scoreRegressed && costSaved) {
    label = 'mixed';
    klass = 'mixed';
    hook = 'Cheaper, but worse. Trade-off you may not want.';
  } else if (scoreImproved && costGrew) {
    label = 'mixed';
    klass = 'mixed';
    hook = 'Better quality, but more expensive. Worth it?';
  } else if (scoreRegressed) {
    label = 'regression';
    klass = 'bad';
    hook = 'Current is worse than baseline. Investigate before shipping.';
  } else if (scoreImproved) {
    label = 'win';
    klass = 'good';
    hook = costSaved ? 'Better and cheaper. Ship it.' : 'Higher quality at similar cost.';
  } else if (costSaved) {
    label = 'cost win';
    klass = 'good';
    hook = 'Same quality, lower cost.';
  } else if (costGrew) {
    label = 'cost regression';
    klass = 'bad';
    hook = 'Same quality, but more expensive.';
  } else {
    label = 'stable';
    klass = 'neutral';
    hook = 'No meaningful change in quality or cost.';
  }

  return { label, klass, hook, reasons };
}

function renderHtml(s: Snapshot): string {
  const verdict = computeVerdict(s);
  const t = s.summary.tokens;
  const baselineMean = s.summary.baseline.mean;
  const currentMean = s.summary.current.mean;
  const scoreDelta = s.summary.delta;
  const costDelta = t?.costDelta ?? 0;
  const failedRuns = s.judgments.filter((j) => j.score === 0 || j.error).length;
  const passedRuns = s.runs.length - failedRuns;

  const promptRows = s.prompts.map((p, i) => {
    const b = meanFor(s, p.id, 'baseline');
    const c = meanFor(s, p.id, 'current');
    const delta = c.n && b.n ? c.mean - b.mean : 0;
    const dir = delta > 0.1 ? 'up' : delta < -0.1 ? 'down' : 'flat';
    const noData = b.n === 0 || c.n === 0;
    const baseW = (b.mean / 5) * 100;
    const curW = (c.mean / 5) * 100;
    const flag = b.failed + c.failed > 0;
    return `<a class="prow" href="#p-${escape(p.id)}" style="--i:${i}">
      <div class="prow-id">${escape(p.id)}</div>
      <div class="prow-bars">
        <div class="prow-bar prow-bar-base"><span style="width:${baseW.toFixed(1)}%"></span><em>${b.n ? b.mean.toFixed(2) : '—'}</em></div>
        <div class="prow-bar prow-bar-curr"><span style="width:${curW.toFixed(1)}%"></span><em>${c.n ? c.mean.toFixed(2) : '—'}</em></div>
      </div>
      <div class="prow-delta prow-delta-${dir}">${noData ? '—' : (delta >= 0 ? '+' : '') + delta.toFixed(2)}</div>
      ${flag ? '<div class="prow-flag" title="contains failed runs">!</div>' : '<div class="prow-flag-empty"></div>'}
    </a>`;
  });

  const renderCell = (r: typeof s.runs[number] | undefined, variant: Variant): string => {
    if (!r) {
      return `<div class="cell cell-empty variant-${variant}"><div class="empty-out">no run</div></div>`;
    }
    const j = s.judgments.find((x) => x.runId === r.id);
    const score = j?.score ?? 0;
    const cls = scoreClass(score);
    const failed = score === 0 || j?.error != null;
    const sliced = (r.output ?? '').slice(0, 800);
    const body = sliced.trim()
      ? `<pre>${escape(sliced)}</pre>`
      : '<div class="empty-out">no output</div>';
    const note = j?.rationale || j?.error || '';
    return `<div class="cell cell-${cls} variant-${variant}${failed ? ' cell-failed' : ''}">
      <div class="cell-head">
        <div class="cell-score">score ${j?.score ?? '-'}</div>
        ${fmtUsage(r)}
      </div>
      ${body}
      ${note ? `<div class="rat">${escape(note)}</div>` : ''}
    </div>`;
  };

  const sections = s.prompts.map((p, pi) => {
    const baseRuns = s.runs
      .filter((r) => r.promptId === p.id && r.variant === 'baseline')
      .sort((a, b) => a.sample - b.sample);
    const currRuns = s.runs
      .filter((r) => r.promptId === p.id && r.variant === 'current')
      .sort((a, b) => a.sample - b.sample);
    const maxN = Math.max(baseRuns.length, currRuns.length);
    const pairs: string[] = [];
    for (let i = 0; i < maxN; i++) {
      pairs.push(renderCell(baseRuns[i], 'baseline'));
      pairs.push(renderCell(currRuns[i], 'current'));
    }
    const grid = maxN
      ? `<div class="variant-head variant-baseline"><span class="variant-label">baseline</span></div>
         <div class="variant-head variant-current"><span class="variant-label">current</span></div>
         ${pairs.join('')}`
      : '<div class="variant-empty" style="grid-column:1/-1">no runs</div>';
    return `<section id="p-${escape(p.id)}" style="--i:${pi}">
      <header class="sect-head">
        <span class="sect-tag">prompt ${pi + 1} / ${s.prompts.length}</span>
        <h3>${escape(p.id)}</h3>
      </header>
      <div class="prompt"><pre>${escape(p.prompt).trim()}</pre></div>
      <div class="variants">${grid}</div>
    </section>`;
  });

  const scoreDeltaCls = scoreDelta > 0.2 ? 'good' : scoreDelta < -0.2 ? 'bad' : 'neutral';
  const costDeltaCls = costDelta < -0.05 ? 'good' : costDelta > 0.05 ? 'bad' : 'neutral';
  const samples = s.config?.runs?.samples ?? '?';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${escape(s.name)} · eval-bench</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<script>(function(){try{var s=localStorage.getItem('ef-theme');var t=s||(matchMedia('(prefers-color-scheme: light)').matches?'light':'dark');document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&family=Instrument+Serif:ital@0;1&display=swap" rel="stylesheet">
<style>
:root,:root[data-theme="dark"]{
  --bg:#0b0a0d;
  --bg-elev:#121116;
  --bg-cell:#16151a;
  --line:#2a262e;
  --line-soft:#1d1b22;
  --fg:#ece8de;
  --fg-soft:#a09a8c;
  --mute:#5a5560;
  --good:#7afca7;
  --bad:#ff6f6f;
  --warn:#f6c177;
  --accent:#e0c89c;
  --grid:rgba(255,255,255,0.018);
  --glow-good:rgba(122,252,167,0.05);
  --glow-bad:rgba(255,111,111,0.05);
  --topbar-grad:rgba(0,0,0,0.35);
  --row-hover:#1c1a20;
  --bar-text-blend:difference;
}
:root[data-theme="light"]{
  --bg:#f3eee2;
  --bg-elev:#ebe5d4;
  --bg-cell:#fbf7ec;
  --line:#cdc6b1;
  --line-soft:#ddd6c1;
  --fg:#1d1a13;
  --fg-soft:#4d473b;
  --mute:#8c8573;
  --good:#1c7a3b;
  --bad:#b53636;
  --warn:#9a6918;
  --accent:#876936;
  --grid:rgba(0,0,0,0.025);
  --glow-good:rgba(28,122,59,0.08);
  --glow-bad:rgba(181,54,54,0.07);
  --topbar-grad:rgba(255,255,255,0.55);
  --row-hover:#e7dfca;
  --bar-text-blend:normal;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--bg);color:var(--fg);font-family:'JetBrains Mono',ui-monospace,monospace;font-weight:400;font-size:13px;line-height:1.55;-webkit-font-smoothing:antialiased;transition:background-color 0.2s ease,color 0.2s ease}
body{
  background-image:
    radial-gradient(circle at 18% -10%, var(--glow-good), transparent 45%),
    radial-gradient(circle at 110% 8%, var(--glow-bad), transparent 50%),
    linear-gradient(var(--grid) 1px, transparent 1px),
    linear-gradient(90deg, var(--grid) 1px, transparent 1px);
  background-size: auto, auto, 32px 32px, 32px 32px;
  background-attachment: fixed;
  min-height:100vh;padding-bottom:6em;
}

/* === TOPBAR === */
.topbar{
  display:flex;align-items:center;justify-content:space-between;gap:2em;
  padding:1.1em 2.4em;border-bottom:1px solid var(--line-soft);
  background:linear-gradient(to bottom,var(--topbar-grad),transparent);
}
.topbar-right{display:flex;align-items:center;gap:1.4em}
.theme-toggle{
  width:32px;height:32px;display:inline-flex;align-items:center;justify-content:center;
  background:var(--bg-elev);border:1px solid var(--line);
  color:var(--fg-soft);cursor:pointer;padding:0;
  transition:background 0.18s,color 0.18s,border-color 0.18s,transform 0.18s;
  font-family:inherit;
}
.theme-toggle:hover{background:var(--row-hover);color:var(--fg);border-color:var(--accent)}
.theme-toggle:active{transform:scale(0.94)}
.theme-toggle svg{width:14px;height:14px;display:block}
.theme-toggle .icon-sun{display:inline}
.theme-toggle .icon-moon{display:none}
:root[data-theme="light"] .theme-toggle .icon-sun{display:none}
:root[data-theme="light"] .theme-toggle .icon-moon{display:inline}
.brand{display:flex;align-items:center;gap:0.7em;font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:var(--fg-soft)}
.brand-icon{width:18px;height:18px;color:var(--accent);flex:none}
.brand strong{color:var(--fg);font-weight:500;letter-spacing:0.18em}
.topbar-meta{font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:var(--mute);text-align:right;line-height:1.7}
.topbar-meta b{color:var(--fg-soft);font-weight:400;text-transform:none;letter-spacing:0.02em}

/* === HERO === */
.hero{padding:4em 2.4em 2.6em;border-bottom:1px solid var(--line-soft);position:relative}
.hero-eyebrow{font-size:10px;letter-spacing:0.32em;text-transform:uppercase;color:var(--mute);margin-bottom:1.4em;display:flex;align-items:center;gap:0.8em}
.hero-eyebrow::after{content:'';flex:1;height:1px;background:var(--line)}
.hero h1{
  font-family:'Instrument Serif',serif;
  font-weight:400;font-style:italic;
  font-size:clamp(56px, 11vw, 144px);
  line-height:0.9;letter-spacing:-0.02em;
  margin:0;color:var(--fg);
}
.hero h1 .name{
  display:block;margin-top:0.55em;
  color:var(--accent);font-style:normal;
  font-family:'JetBrains Mono',monospace;
  font-size:0.18em;letter-spacing:0.02em;font-weight:400;
}
.hero[data-verdict="good"] h1{color:var(--good)}
.hero[data-verdict="bad"] h1{color:var(--bad)}
.hero[data-verdict="mixed"] h1{color:var(--warn)}
.hero[data-verdict="neutral"] h1{color:var(--accent)}
.hero[data-verdict="partial"] h1{color:var(--accent)}

.hero-hook{font-size:18px;color:var(--fg-soft);max-width:54ch;margin:1.6em 0 0;line-height:1.45}

.reasons{margin-top:1.8em;display:flex;flex-wrap:wrap;gap:0.5em}
.reason{font-size:10.5px;letter-spacing:0.1em;text-transform:uppercase;padding:0.45em 0.85em;border:1px solid var(--line);color:var(--fg-soft);background:var(--bg-elev)}
.reason::before{content:'›';margin-right:0.55em;color:var(--mute)}

/* === VERDICT SCALE === */
.verdict-scale{margin-top:2.4em;padding:1.6em 0 0;border-top:1px solid var(--line-soft)}
.verdict-scale-title{font-size:9px;letter-spacing:0.28em;text-transform:uppercase;color:var(--mute);margin-bottom:1.2em}
.verdict-items{display:flex;gap:0.8em;flex-wrap:wrap}
.verdict-item{display:flex;align-items:center;gap:0.7em;padding:0.65em 1em;border:1px solid var(--line);background:var(--bg-elev);transition:all 0.2s;font-size:11px}
.verdict-item-indicator{width:8px;height:8px;border-radius:50%;flex:none;transition:transform 0.2s;background:currentColor}
.verdict-item-indicator.good{color:var(--good)}
.verdict-item-indicator.bad{color:var(--bad)}
.verdict-item-indicator.mixed{color:var(--warn)}
.verdict-item-indicator.neutral{color:var(--accent)}
.verdict-item-indicator.partial{color:var(--mute)}
.verdict-item-label{font-weight:500;color:var(--fg-soft);letter-spacing:0.02em;white-space:nowrap}
.verdict-item-desc{color:var(--mute);font-size:10px}
.verdict-item.active{border-color:var(--accent);background:color-mix(in srgb, var(--accent) 12%, var(--bg-elev));transform:scale(1.05)}
.verdict-item.active .verdict-item-indicator{transform:scale(1.5);box-shadow:0 0 12px currentColor}
.verdict-item.active .verdict-item-label{color:var(--fg)}
.verdict-item.active .verdict-item-desc{color:var(--fg-soft)}

/* === METRICS === */
.metrics{display:grid;grid-template-columns:repeat(3,1fr);border-bottom:1px solid var(--line-soft)}
.metric{padding:2em 2.4em;border-right:1px solid var(--line-soft);position:relative;overflow:hidden}
.metric:last-child{border-right:none}
.metric-label{font-size:10px;letter-spacing:0.28em;text-transform:uppercase;color:var(--mute);margin-bottom:1em;display:flex;align-items:baseline;gap:0.7em}
.metric-label-tag{font-size:9px;letter-spacing:0.12em;color:var(--mute);padding:0.15em 0.5em;border:1px solid var(--line)}
.metric-value{font-size:54px;font-weight:300;line-height:1;letter-spacing:-0.04em;color:var(--fg);font-variant-numeric:tabular-nums}
.metric-value-sub{font-size:24px;color:var(--mute);font-weight:300;letter-spacing:-0.02em}
.metric-detail{margin-top:0.6em;font-size:11px;color:var(--fg-soft);letter-spacing:0.04em}
.metric-detail b{color:var(--fg);font-weight:400}
.metric-delta{font-size:13px;font-weight:500;font-variant-numeric:tabular-nums;margin-top:0.5em;letter-spacing:0.01em}
.metric-delta.good{color:var(--good)}
.metric-delta.bad{color:var(--bad)}
.metric-delta.neutral{color:var(--fg-soft)}
.metric-delta::before{content:attr(data-icon);margin-right:0.35em;display:inline-block;width:0.9em;text-align:center}
.metric-bar{margin-top:1.2em;height:3px;background:var(--line);position:relative;overflow:hidden}
.metric-bar span{position:absolute;top:0;bottom:0;left:0;background:var(--accent);transform-origin:left;transform:scaleX(0);animation:bar-grow 1.4s cubic-bezier(0.2,0.8,0.2,1) 0.3s forwards}
@keyframes bar-grow{to{transform:scaleX(1)}}

/* === SECTION TITLE === */
.section-title{font-size:11px;letter-spacing:0.32em;text-transform:uppercase;color:var(--mute);margin:3.5em 2.4em 1.4em;display:flex;align-items:center;gap:1em}
.section-title::before{content:'';width:24px;height:1px;background:var(--accent)}
.section-title::after{content:'';flex:1;height:1px;background:var(--line)}

/* === PROMPTS TABLE === */
.prompts-table{margin:0 2.4em}
.prow{
  display:grid;grid-template-columns:minmax(180px,2fr) 5fr 90px 30px;
  align-items:center;gap:1.4em;
  padding:0.95em 1.2em;
  border:1px solid var(--line-soft);border-bottom:none;
  text-decoration:none;color:inherit;
  background:var(--bg-elev);
  transition:background 0.18s, border-color 0.18s, transform 0.18s;
  opacity:0;animation:fade-in 0.5s ease-out forwards;
  animation-delay:calc(var(--i) * 60ms + 200ms);
}
.prow:hover{background:var(--row-hover);border-color:var(--line)}
.prow:last-child{border-bottom:1px solid var(--line-soft)}
.prow-id{font-size:13px;color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.prow-bars{display:flex;flex-direction:column;gap:0.3em}
.prow-bar{position:relative;height:14px;background:var(--line-soft);display:flex;align-items:center}
.prow-bar span{position:absolute;top:0;bottom:0;left:0;transform-origin:left;transform:scaleX(0);animation:bar-grow 1s cubic-bezier(0.2,0.8,0.2,1) forwards;animation-delay:calc(var(--i) * 60ms + 400ms)}
.prow-bar-base span{background:var(--fg-soft)}
.prow-bar-curr span{background:var(--accent)}
.prow-bar em{position:absolute;right:0.6em;font-style:normal;font-size:10px;color:var(--fg);font-variant-numeric:tabular-nums;font-weight:500;mix-blend-mode:var(--bar-text-blend);z-index:1}
.prow-bar::after{position:absolute;left:0.55em;font-size:9px;letter-spacing:0.18em;color:var(--bg);font-weight:600;z-index:1;mix-blend-mode:var(--bar-text-blend)}
.prow-bar-base::after{content:'B'}
.prow-bar-curr::after{content:'C'}
.prow-delta{text-align:right;font-variant-numeric:tabular-nums;font-size:14px;font-weight:500;letter-spacing:-0.01em}
.prow-delta-up{color:var(--good)}
.prow-delta-down{color:var(--bad)}
.prow-delta-flat{color:var(--fg-soft)}
.prow-delta-up::before{content:'▲ '}
.prow-delta-down::before{content:'▼ '}
.prow-delta-flat::before{content:'• '}
.prow-flag{width:22px;height:22px;display:flex;align-items:center;justify-content:center;border-radius:50%;background:color-mix(in srgb, var(--bad) 18%, transparent);color:var(--bad);font-weight:700;font-size:13px}
.prow-flag-empty{width:22px;height:22px}
@keyframes fade-in{to{opacity:1}}

/* === DETAIL SECTIONS === */
section{padding:2.2em 2.4em;margin-top:1.2em;border-top:1px solid var(--line-soft);scroll-margin-top:1em;opacity:0;animation:fade-in 0.5s ease-out forwards;animation-delay:calc(var(--i) * 100ms + 600ms)}
.sect-head{display:flex;align-items:baseline;gap:1.2em;margin-bottom:1.2em;flex-wrap:wrap}
.sect-tag{font-size:10px;letter-spacing:0.24em;text-transform:uppercase;color:var(--mute);padding:0.3em 0.7em;border:1px solid var(--line)}
section h3{font-family:'Instrument Serif',serif;font-style:italic;font-weight:400;font-size:36px;margin:0;color:var(--fg);letter-spacing:-0.01em;line-height:1}
.prompt{background:linear-gradient(to right, color-mix(in srgb, var(--accent) 8%, transparent), transparent);border-left:2px solid var(--accent);padding:1em 1.4em;margin:0 0 1.4em;font-size:12px;color:var(--fg-soft)}
.prompt pre{margin:0;white-space:pre-wrap;font-family:'JetBrains Mono',monospace;line-height:1.6}

/* The variants grid uses a single 2-column track for ALL paired cells (one
   row per sample), so each row's height auto-sizes to its TALLER cell and
   align-items:stretch makes the shorter cell match. Don't replace this with
   per-variant columns — that would let baseline and current cells size
   independently and breaks visual pairing for samples of unequal output
   length. */
.variants{display:grid;grid-template-columns:1fr 1fr;gap:0.7em 1em;align-items:stretch}
.variant-head{font-size:10px;letter-spacing:0.28em;text-transform:uppercase;color:var(--mute);display:flex;align-items:center;gap:0.8em;margin-bottom:-0.2em}
.variant-head::after{content:'';flex:1;height:1px;background:var(--line-soft)}
.variant-label{padding:0.28em 0.75em;border:1px solid var(--line);background:var(--bg-elev)}
.variant-head.variant-baseline .variant-label{color:var(--fg-soft)}
.variant-head.variant-current .variant-label{color:var(--accent);border-color:var(--accent);background:color-mix(in srgb, var(--accent) 9%, transparent)}

/* Cells use an inner 3-row grid (head / body / rationale) so the rationale
   pins to the bottom without margin-top hacks and the body row absorbs any
   extra height when the row is stretched to match the taller paired cell.
   align-self:stretch is the default for grid items so the cell fills the
   .variants row naturally; no height:100% needed (which can resolve to
   intrinsic content height inside nested flex/grid contexts depending on
   browser). */
.cell{background:var(--bg-cell);border:1px solid var(--line-soft);padding:0.95em 1.05em;position:relative;border-left:3px solid var(--mute);display:grid;grid-template-rows:auto 1fr auto;align-self:stretch}
.cell-empty{justify-content:center;align-items:center;border-style:dashed;border-left-style:dashed;background:transparent}
.cell-great{border-left-color:var(--good)}
.cell-ok{border-left-color:var(--accent)}
.cell-meh{border-left-color:var(--warn)}
.cell-bad{border-left-color:var(--bad)}
.cell-fail{border-left-color:var(--bad);background:color-mix(in srgb, var(--bad) 6%, var(--bg-cell))}
.cell-failed::after{content:'FAILED';position:absolute;top:0.6em;right:0.85em;font-size:9px;letter-spacing:0.22em;color:var(--bad);font-weight:700}
.cell-head{display:flex;align-items:baseline;justify-content:space-between;gap:1em;margin-bottom:0.7em}
.cell-score{font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:var(--fg);font-weight:500}
.cell-great .cell-score{color:var(--good)}
.cell-ok .cell-score{color:var(--accent)}
.cell-meh .cell-score{color:var(--warn)}
.cell-bad .cell-score,.cell-fail .cell-score{color:var(--bad)}
.cell-tok{font-size:10px;color:var(--mute);letter-spacing:0.04em;font-variant-numeric:tabular-nums}
.cell pre{white-space:pre-wrap;font-size:12px;margin:0;color:var(--fg);line-height:1.55}
.empty-out{font-family:'Instrument Serif',serif;font-style:italic;color:var(--bad);font-size:16px;padding:0.4em 0}
/* No margin-top:auto needed — the cell's inner grid pins this to the last row. */
.rat{padding-top:0.7em;border-top:1px dashed var(--line);font-size:11px;color:var(--fg-soft);line-height:1.55}
.rat::before{content:'JUDGE';display:inline-block;font-size:9px;letter-spacing:0.2em;color:var(--mute);margin-right:0.6em;padding:0.1em 0.4em;border:1px solid var(--line)}
.variant-empty{padding:2em;color:var(--mute);text-align:center;font-size:11px;letter-spacing:0.16em;text-transform:uppercase;border:1px dashed var(--line)}

@media (max-width:900px){
  .metrics{grid-template-columns:1fr}
  .metric{border-right:none;border-bottom:1px solid var(--line-soft)}
  .variants{grid-template-columns:1fr}
  .prow{grid-template-columns:1fr;gap:0.5em}
  .prow-id{font-size:14px}
  .topbar,.hero,.metric,section{padding-left:1.4em;padding-right:1.4em}
  .section-title,.prompts-table{margin-left:1.4em;margin-right:1.4em}
  .topbar{flex-direction:column;align-items:flex-start;gap:0.6em}
  .topbar-meta{text-align:left}
  .topbar-right{flex-direction:row;align-items:flex-start;gap:0.8em;width:100%;justify-content:space-between}
  .verdict-items{flex-direction:column}
  .verdict-item{width:100%}
}
</style></head>
<body>
<div class="topbar">
  <div class="brand">
    <svg class="brand-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M2 9h20"/>
      <path d="M2 12h20"/>
      <path d="M5 12v8"/>
      <path d="M19 12v8"/>
      <path d="M5 16h14"/>
    </svg>
    <span><strong>eval-bench</strong> // snapshot view</span>
  </div>
  <div class="topbar-right">
    <div class="topbar-meta">
      <div>${escape(s.createdAt)}</div>
      <div>judge <b>${escape(s.judge.provider)}/${escape(s.judge.model)}</b> · base <b>${escape(refLabel(s.plugin.baselineRef, s.plugin.baselineSha))}</b> → curr <b>${escape(refLabel(s.plugin.currentRef, s.plugin.currentSha))}</b></div>
    </div>
    <button class="theme-toggle" type="button" aria-label="Toggle light/dark theme" title="Toggle theme">
      <svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>
      <svg class="icon-moon" viewBox="0 0 24 24" fill="currentColor"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
    </button>
  </div>
</div>
<script>(function(){document.addEventListener('click',function(e){var b=e.target.closest('.theme-toggle');if(!b)return;var c=document.documentElement.getAttribute('data-theme')||'dark';var n=c==='dark'?'light':'dark';document.documentElement.setAttribute('data-theme',n);try{localStorage.setItem('ef-theme',n);}catch(_){}});})();</script>

<div class="hero" data-verdict="${verdict.klass}">
  <div class="hero-eyebrow">verdict</div>
  <h1>${escape(verdict.label)}<span class="name">${escape(s.name)}</span></h1>
  <p class="hero-hook">${escape(verdict.hook)}</p>
  ${verdict.reasons.length ? `<div class="reasons">${verdict.reasons.map((r) => `<span class="reason">${escape(r)}</span>`).join('')}</div>` : ''}
  
  <div class="verdict-scale">
    <div class="verdict-scale-title">all possible verdicts</div>
    <div class="verdict-items">
      <div class="verdict-item ${verdict.label === 'win' ? 'active' : ''}">
        <div class="verdict-item-indicator good"></div>
        <div class="verdict-item-label">win</div>
        <div class="verdict-item-desc">• better quality</div>
      </div>
      <div class="verdict-item ${verdict.label === 'cost win' ? 'active' : ''}">
        <div class="verdict-item-indicator good"></div>
        <div class="verdict-item-label">cost win</div>
        <div class="verdict-item-desc">• same quality, lower cost</div>
      </div>
      <div class="verdict-item ${verdict.label === 'stable' ? 'active' : ''}">
        <div class="verdict-item-indicator neutral"></div>
        <div class="verdict-item-label">stable</div>
        <div class="verdict-item-desc">• no meaningful change</div>
      </div>
      <div class="verdict-item ${verdict.label === 'mixed' ? 'active' : ''}">
        <div class="verdict-item-indicator mixed"></div>
        <div class="verdict-item-label">mixed</div>
        <div class="verdict-item-desc">• trade-offs present</div>
      </div>
      <div class="verdict-item ${verdict.label === 'regression' ? 'active' : ''}">
        <div class="verdict-item-indicator bad"></div>
        <div class="verdict-item-label">regression</div>
        <div class="verdict-item-desc">• quality dropped</div>
      </div>
      <div class="verdict-item ${verdict.label === 'cost regression' ? 'active' : ''}">
        <div class="verdict-item-indicator bad"></div>
        <div class="verdict-item-label">cost regression</div>
        <div class="verdict-item-desc">• same quality, higher cost</div>
      </div>
      <div class="verdict-item ${verdict.klass === 'partial' ? 'active' : ''}">
        <div class="verdict-item-indicator partial"></div>
        <div class="verdict-item-label">${verdict.klass === 'partial' ? escape(verdict.label) : 'partial'}</div>
        <div class="verdict-item-desc">• incomplete comparison</div>
      </div>
    </div>
  </div>
</div>

<div class="metrics">
  <div class="metric">
    <div class="metric-label">quality score <span class="metric-label-tag">mean / 5</span></div>
    <div class="metric-value">${currentMean.toFixed(2)}</div>
    <div class="metric-detail">baseline <b>${baselineMean.toFixed(2)}</b> · n=${s.summary.current.n || s.summary.baseline.n}</div>
    <div class="metric-delta ${scoreDeltaCls}" data-icon="${scoreDelta > 0.2 ? '▲' : scoreDelta < -0.2 ? '▼' : '•'}">${scoreDelta >= 0 ? '+' : ''}${scoreDelta.toFixed(2)} vs baseline</div>
    <div class="metric-bar"><span style="width:${Math.min(100, Math.max(0, (currentMean / 5) * 100)).toFixed(1)}%"></span></div>
  </div>
  <div class="metric">
    <div class="metric-label">cost <span class="metric-label-tag">usd</span></div>
    <div class="metric-value">${t ? '$' + t.current.totalCostUsd.toFixed(2) : '—'}</div>
    <div class="metric-detail">${t ? `baseline <b>$${t.baseline.totalCostUsd.toFixed(2)}</b>` : 'no token data'}</div>
    ${t ? `<div class="metric-delta ${costDeltaCls}" data-icon="${costDelta < -0.05 ? '▼' : costDelta > 0.05 ? '▲' : '•'}">${costDelta >= 0 ? '+' : ''}$${costDelta.toFixed(2)} vs baseline</div>` : '<div class="metric-delta neutral" data-icon="•">—</div>'}
    <div class="metric-bar"><span style="width:${t ? Math.min(100, (t.current.totalCostUsd / (Math.max(t.current.totalCostUsd, t.baseline.totalCostUsd) || 1)) * 100).toFixed(1) : 0}%"></span></div>
  </div>
  <div class="metric">
    <div class="metric-label">runs <span class="metric-label-tag">${s.runs.length} total</span></div>
    <div class="metric-value">${passedRuns}<span class="metric-value-sub">/${s.runs.length}</span></div>
    <div class="metric-detail">prompts <b>${s.prompts.length}</b> · samples per variant <b>${samples}</b></div>
    <div class="metric-delta ${failedRuns > 0 ? 'bad' : 'good'}" data-icon="${failedRuns > 0 ? '!' : '✓'}">${failedRuns > 0 ? `${failedRuns} failed` : 'all green'}</div>
    <div class="metric-bar"><span style="width:${s.runs.length ? ((passedRuns / s.runs.length) * 100).toFixed(1) : 0}%;background:${failedRuns > 0 ? 'var(--bad)' : 'var(--good)'}"></span></div>
  </div>
</div>

<div class="section-title">per-prompt breakdown</div>
<div class="prompts-table">${promptRows.join('')}</div>

<div class="section-title">run details</div>
${sections.join('')}

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

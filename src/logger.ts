import chalk from 'chalk';

export function info(msg: string): void {
  console.log(msg);
}
export function ok(msg: string): void {
  console.log(chalk.green('✓') + ' ' + msg);
}
export function warn(msg: string): void {
  console.log(chalk.yellow('!') + ' ' + msg);
}
export function err(msg: string): void {
  console.error(chalk.red('✗') + ' ' + msg);
}
export function progress(
  current: number,
  total: number,
  label: string,
  status: string,
  ms: number,
): void {
  const statusColor =
    status === 'OK' ? chalk.green : status === 'FAIL' ? chalk.red : chalk.yellow;
  console.log(
    `[${current}/${total}] ${label.padEnd(40)} ${statusColor(status.padEnd(8))} (${(ms / 1000).toFixed(1)}s)`,
  );
}

export function step(current: number, total: number, label: string, phase: string): void {
  console.log(`[${current}/${total}] ${label.padEnd(40)} ${chalk.dim(phase)}`);
}

// Print the judge's score + rationale right under the progress line so the
// reader can see *why* a row scored what it did without opening snapshot.json
// or view.html. This is the iteration loop for --only / --no-save / single-
// rubric work: tweak prompt or skill, re-run, read here, decide.
export function judgeResult(score: number, rationale: string, error: string | null): void {
  const indent = '       ';
  if (error) {
    console.log(`${indent}${chalk.red('judge error:')} ${chalk.dim(error)}`);
    return;
  }
  const scoreColor = score >= 4 ? chalk.green : score >= 2.5 ? chalk.yellow : chalk.red;
  // Wrap on whitespace at ~96 chars, indenting continuation lines so the
  // rationale visually associates with the row above. We don't truncate —
  // truncation would defeat the whole point of printing this.
  const cleaned = rationale.replace(/\s+/g, ' ').trim() || '(no rationale)';
  const wrapped = wrap(cleaned, 96, indent);
  console.log(`${indent}${scoreColor(`score ${score.toFixed(1)}`)} ${chalk.dim('—')} ${chalk.dim(wrapped)}`);
}

function wrap(text: string, width: number, indent: string): string {
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const w of words) {
    if (!current) {
      current = w;
    } else if (current.length + 1 + w.length <= width) {
      current += ' ' + w;
    } else {
      lines.push(current);
      current = w;
    }
  }
  if (current) lines.push(current);
  return lines.join('\n' + indent + '  ');
}

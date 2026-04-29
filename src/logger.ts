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

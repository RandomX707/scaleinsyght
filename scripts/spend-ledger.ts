import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Model spend ledger (opt-in): before a test database is reset, the model cost its run recorded in core.model_usage is
 * appended to a tally file, so a day's own spend is counted deterministically. Off unless SPEND_TALLY_FILE is set;
 * "{date}" in the path becomes the local date (YYYY-MM-DD). Totals only; no prompts, questions or data.
 */
const pad = (value: number) => String(value).padStart(2, '0');
export const localDate = (at: Date) => `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
export function tallyPath(template: string, at: Date): string { return template.replaceAll('{date}', localDate(at)); }
export function ledgerLine(input: { at: Date; label: string; costUsd: number; calls: number; database: string }): string {
  return `${pad(input.at.getHours())}:${pad(input.at.getMinutes())} · ${input.label} · ${input.costUsd.toFixed(4)} · recorded (${input.database}, ${input.calls} model ${input.calls === 1 ? 'call' : 'calls'})\n`;
}
/** The branch and commit being tested, or SPEND_LABEL when set (for example a PR number). */
export function runLabel(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SPEND_LABEL?.trim()) return env.SPEND_LABEL.trim().slice(0, 80);
  try {
    const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const branch = git('rev-parse', '--abbrev-ref', 'HEAD'); const commit = git('rev-parse', '--short', 'HEAD');
    return branch === 'HEAD' ? commit : `${branch} ${commit}`;
  } catch { return 'unknown run'; }
}
/** The stamp written on a fresh test database, so the next reset knows which run the recorded spend belongs to. */
export const stamp = (label: string, at: Date) => JSON.stringify({ spendLabel: label, startedAt: at.toISOString() });
export function readStamp(comment: string | null | undefined): { label: string; startedAt: Date } | null {
  try { const value = JSON.parse(comment ?? '') as { spendLabel?: unknown; startedAt?: unknown };
    return typeof value.spendLabel === 'string' && typeof value.startedAt === 'string' ? { label: value.spendLabel, startedAt: new Date(value.startedAt) } : null; } catch { return null; }
}
/** Appends one line when the run made model calls; returns the line, or null when nothing was recorded. */
export function recordSpend(input: { template: string | undefined; at: Date; label: string; costUsd: number; calls: number; database: string }): string | null {
  if (!input.template || input.calls === 0) return null;
  const path = tallyPath(input.template, input.at);
  mkdirSync(dirname(path), { recursive: true });
  const line = ledgerLine(input); appendFileSync(path, line);
  return line;
}

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const keyPattern = new RegExp(['sk', '[A-Za-z0-9_-]{8,}'].join('-'));

function gitOutput(args) {
  const result = spawnSync('git', args, { encoding: 'buffer' });
  if (result.status !== 0) throw new Error('secret_scan_git_failed');
  return result.stdout.toString('utf8').split('\0').filter(Boolean);
}

function stagedFiles() {
  return gitOutput(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']);
}

function worktreeFiles() {
  return gitOutput(['ls-files', '-co', '--exclude-standard', '-z']);
}

function stagedContent(path) {
  const result = spawnSync('git', ['show', `:${path}`], { encoding: 'buffer' });
  if (result.status !== 0) return '';
  return result.stdout.toString('utf8');
}

function scan(entries) {
  const hits = [];
  for (const { path, content } of entries) {
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (keyPattern.test(lines[index] ?? '')) hits.push(`${path}:${index + 1}`);
      keyPattern.lastIndex = 0;
    }
  }
  if (hits.length) {
    for (const location of hits) process.stderr.write(`potential OpenAI-style credential detected: ${location}\n`);
    return 1;
  }
  return 0;
}

const [mode, ...paths] = process.argv.slice(2);
try {
  let entries;
  if (mode === '--files') entries = paths.map((path) => ({ path, content: readFileSync(path, 'utf8') }));
  else if (mode === '--staged') entries = stagedFiles().map((path) => ({ path, content: stagedContent(path) }));
  else if (mode === '--worktree') entries = worktreeFiles().map((path) => ({ path, content: readFileSync(path, 'utf8') }));
  else throw new Error('secret_scan_mode_required');
  process.exitCode = scan(entries);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'secret_scan_failed'}\n`);
  process.exitCode = 2;
}

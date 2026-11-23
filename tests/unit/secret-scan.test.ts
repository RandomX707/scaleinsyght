import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryDirectories: string[] = [];
const scanner = resolve('scripts/secret-scan.mjs');

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('OpenAI key leak scanner', () => {
  it('secret_scanner_rejects_openai_style_key_in_env_example', () => {
    const directory = mkdtempSync(join(tmpdir(), 'scaleinsyght-secret-scan-'));
    temporaryDirectories.push(directory);
    const example = join(directory, '.env.example');
    writeFileSync(example, 'OPENAI_API_KEY=\n');

    const blank = spawnSync(process.execPath, [scanner, '--files', example], { encoding: 'utf8' });
    expect(blank.status).toBe(0);

    const syntheticKey = ['sk', 'proj', 'syntheticCanaryForScannerOnly0123456789abcdef'].join('-');
    writeFileSync(example, `OPENAI_API_KEY=${syntheticKey}\n`);
    const leaked = spawnSync(process.execPath, [scanner, '--files', example], { encoding: 'utf8' });
    expect(leaked.status).not.toBe(0);
    expect(leaked.stderr).toContain('.env.example:1');
    expect(leaked.stderr).not.toContain(syntheticKey);
  });

  it('wires staged and working-tree scans into the pre-commit hook and CI', () => {
    const hook = readFileSync(resolve('.githooks/pre-commit'), 'utf8');
    const workflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
    expect(hook).toContain('secret-scan.mjs --staged');
    expect(workflow).toContain('secret-scan.mjs --worktree');
  });
});

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sourceRoots = ['apps', 'scripts', 'tests', 'packages'];
const ignored = new Set(['node_modules', 'dist', 'coverage']);
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (path.replaceAll('\\', '/').startsWith('packages/ui/')) return [];
    if (entry.isDirectory()) return ignored.has(entry.name) ? [] : sources(path);
    return sourceExtensions.has(path.slice(path.lastIndexOf('.'))) ? [path] : [];
  });
}

function rawControls(contents: string): string[] {
  return [...contents.matchAll(/<\s*(input|select|textarea|button)\b/g)].map((match) => match[1]!);
}

describe('ui_no_raw_native_controls_outside_shared_package', () => {
  it('detects a raw native control', () => {
    expect(rawControls('<' + 'button>')).toEqual(['button']);
  });

  it('rejects raw input, select, textarea, and button elements in application source', () => {
    const violations = sourceRoots.flatMap((root) => sources(root)).flatMap((file) => {
      const contents = readFileSync(file, 'utf8');
      return rawControls(contents).map((tag) => `${file}:${tag}`);
    });
    expect(violations).toEqual([]);
  });
});

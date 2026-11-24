import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

function productionSources(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    if (statSync(path).isDirectory()) return productionSources(path);
    return /\.[cm]?[jt]sx?$/.test(name) ? [path] : [];
  });
}

describe('production runtime fixture isolation', () => {
  it('keeps golden data and deterministic providers out of app and package runtime code', () => {
    const roots = ['apps/api/src', 'apps/worker/src', ...readdirSync('packages')
      .map((name) => join('packages', name, 'src'))
      .filter(existsSync)];
    const violations = roots
      .flatMap(productionSources)
      .flatMap((path) => {
        const source = readFileSync(path, 'utf8');
        const forbidden = [
          /tests\/golden/,
          /\b(?:golden|synthetic)_?(?:result|source|profile|connector|fixture)/i,
          /golden:\/\//,
          /fixtureKey/,
          /executeGoldenStep/,
          /createGoldenConnector/,
          /listGoldenSources/,
          /listGoldenStructuralReferences/,
          /importGoldenMetadata/,
          /createGoldenHubAdapters/,
        ];
        return forbidden
          .filter((pattern) => pattern.test(source))
          .map((pattern) => `${relative(process.cwd(), path)} contains ${pattern}`);
      });
    expect(violations).toEqual([]);
  });
});

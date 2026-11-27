import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// Decision 67 follow-up: the app serves Inter and JetBrains Mono itself (OFL 1.1) and names no third-party font host.
it('loads fonts from the app bundle, not from Google Fonts', () => {
  expect(readFileSync('apps/web/index.html', 'utf8')).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
  const entry = readFileSync('apps/web/src/main.tsx', 'utf8');
  for (const weight of [400, 500, 600, 700]) expect(entry).toContain(`import '@fontsource/inter/${weight}.css';`);
  for (const weight of [400, 500]) expect(entry).toContain(`import '@fontsource/jetbrains-mono/${weight}.css';`);
});

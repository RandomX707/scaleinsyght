import { expect, it } from 'vitest';
import { readBack } from '../../apps/web/src/back.js';

it('reads the origin kept with a history entry, accepting only same-app paths', () => {
  expect(readBack({ back: { label: 'Dictionary · encounters', url: '/dictionary?connection=c&object=dbo.encounters' } })).toEqual({ label: 'Dictionary · encounters', url: '/dictionary?connection=c&object=dbo.encounters' });
  for (const state of [null, {}, { back: null }, { back: { label: '', url: '/x' } }, { back: { label: 'X', url: 'https://example.test/' } }, { back: { label: 'X', url: '//example.test/' } }, { back: { label: 'X'.repeat(200), url: '/x' } }, { back: { label: 1, url: '/x' } }])
    expect(readBack(state), JSON.stringify(state)).toBeNull();
});

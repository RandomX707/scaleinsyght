import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { FindingsPanel, type Finding } from './findings.js';

it('selects Suggestions when that is the only populated tab in the latest refresh', () => {
  const suggestion: Finding = {
    findingId:'suggestion',connectionId:'source',sourceName:'Warehouse',jobId:'latest',jobType:'nightly',
    kind:'id_match',subject:'left.id → right.id',detail:{},foundAt:'2026-11-25T00:00:00Z',status:'open',decidedAt:null,
  };
  const html=renderToStaticMarkup(createElement(FindingsPanel,{
    data:{findings:[suggestion,{...suggestion,findingId:'earlier',jobId:'earlier',kind:'new_tables'}],
      lastNight:{jobIds:['latest'],scheduled:false,startedAt:suggestion.foundAt,connections:1,profiled:18,listed:18,checked:18,changed:0}},
    decide:async()=>{},
  }));
  expect(html).toMatch(/aria-selected="true"[^>]*>Suggestions 1</);
  expect(html).toContain('Changes 0');
  expect(html).toContain('18 objects checked, 0 changed');
  expect(html).toContain('Approve all suggestions');
  expect(html).not.toContain('Approve all changes');
});

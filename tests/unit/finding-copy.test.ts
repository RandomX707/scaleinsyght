import { expect, it } from 'vitest';
import { findingGroup, findingSources, findingText, type Finding } from '../../apps/web/src/findings.js';

it('explains a possible relationship without repeating review policy or punctuation', () => {
  const finding: Finding = {
    findingId:'finding',connectionId:'source',sourceName:'pgs',jobId:'job',jobType:'nightly',
    kind:'probable_relationship',subject:'orders.department_id → departments.department_id',
    detail:{explanation:'Source-local structural analysis.'},foundAt:'2026-11-25T00:00:00Z',
    status:'open',decidedAt:null,
  };
  expect(findingText(finding)).toBe('orders.department_id → departments.department_id looks like a relationship: the columns appear to link tables within this source.');
});

it('separates suggested interpretations from measured changes', () => {
  for (const kind of ['probable_relationship','id_match','sensitive_column']) expect(findingGroup(kind)).toBe('Suggestions');
  for (const kind of ['schema_change','data_anomaly','new_tables']) expect(findingGroup(kind)).toBe('Changes');
});

it('uses the connection of each ID match endpoint', () => {
  const finding: Finding = {
    findingId:'finding',connectionId:'pgs',sourceName:'pgs',jobId:'job',jobType:'nightly',
    kind:'id_match',subject:'dbo.providers.provider_id → public.providers.provider_id',
    detail:{fromSource:'sql',fromField:'dbo.providers.provider_id',toSource:'pgs',toField:'public.providers.provider_id'},
    foundAt:'2026-11-25T00:00:00Z',status:'open',decidedAt:null,
  };
  expect(findingSources(finding)).toBe('sql · dbo.providers.provider_id ↔ pgs · public.providers.provider_id');
});

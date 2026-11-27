import { expect, it } from 'vitest';
import { classifyCatalogReferences } from '@scaleinsyght/profiler';
import { draftDescription } from '@scaleinsyght/api/dictionary';

it('splits catalog references of an encrypted module into tables and views, routines and unresolved names', () => {
  expect(classifyCatalogReferences(['dbo.Orders', 'dbo.usp_WriteLog', 'dbo.v_Totals', 'archive.Gone', 'Customers'],
    { relations: ['dbo.Orders', 'dbo.Customers', 'dbo.v_Totals'], routines: ['dbo.usp_WriteLog'] }, 'dbo'))
    .toEqual({ uses: ['dbo.Customers', 'dbo.Orders', 'dbo.v_Totals'], calls: ['dbo.usp_WriteLog'], unresolved: ['archive.Gone'] });
});

it('describes an encrypted module by what the catalog records, never as reads or writes', () => {
  expect(draftDescription({ kind: 'procedure', name: 'dbo.usp_Secret', encrypted: true, analysis: { writes: [], reads: [], calls: ['dbo.usp_WriteLog'], uses: ['dbo.Orders'] } }))
    .toBe('Procedure whose SQL the source encrypts. The database catalog records that it refers to Orders and runs usp_WriteLog, but not whether it reads or writes them.');
  expect(draftDescription({ kind: 'procedure', name: 'dbo.usp_Secret', encrypted: true, analysis: { writes: [], reads: [], calls: [], uses: [] } }))
    .toBe('Procedure whose SQL the source encrypts, so what it reads and writes is not known.');
});

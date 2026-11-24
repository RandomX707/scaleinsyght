import { describe, expect, it } from 'vitest';
import { decodePlannerOutput, hasNamedCountSubject, normalizeCatalogMentions, plannerSchema } from '../../apps/api/src/structured-planner.js';

const catalog = [{assets: [{qualified_name:'Charges',columns:[{name:'charge_type',label:'Charge Type'},{name:'charged_on'}]}]}];
const payload = {
  source_index:0, kind:'group_by',table:'Charges',join:null,groupBy:'Charges.charge_type',
  groupKey:null, entityColumn:null,operation:'sum',aggregateColumn:null,order:'asc',limit:2,filters:[],
};
const wrap = (intent: Record<string, unknown>) => JSON.stringify({intents:[intent]});
describe('structured planner', () => {
  it('exposes SQL identifiers and their original labels and preserves bottom counts', () => {
    expect(JSON.stringify(plannerSchema(catalog, []))).toContain('Charges.charge_type is displayed as Charge Type');
    expect(decodePlannerOutput(wrap(payload), catalog, [], 'Which groups have the smallest counts?')[0]?.intent).toEqual({
      kind:'group_by',table:'Charges',groupBy:'charge_type',order:'asc',orderBy:'value',limit:2,aggregate:{operation:'count'},
    });
  });
  it('preserves catalog headings through redaction without normalizing arbitrary names', () => {
    expect(normalizeCatalogMentions('Show Charge Types for Jane Doe',catalog)).toBe('Show charge types for Jane Doe');
  });
  it('refuses a direct count of a subject absent from the catalog', () => {
    expect(hasNamedCountSubject('How many insurance claims were denied?',catalog,[])).toBe(false);
    expect(hasNamedCountSubject('How many Charges were cancelled?',catalog,[])).toBe(true);
  });
  it('separates the subject from a source qualifier', () => {
    expect(hasNamedCountSubject('How many Charges in the workbook were recorded?',catalog,[])).toBe(true);
  });
  it('rejects a dimension count when the question names the fact table', () => {
    const sources = [{assets:[...catalog[0]!.assets,{qualified_name:'Departments',columns:[{name:'name'}]}]}];
    expect(() => decodePlannerOutput(wrap({...payload,table:'Departments'}),sources,[],'How many charges belong to Imaging?'))
      .toThrow('count_the_named_subject_table');
  });
  it('rejects a column outside the selected table', () => {
    expect(() => decodePlannerOutput(wrap({...payload,groupBy:'Visits.charge_type'}), catalog, [], 'Count records')).toThrow('column_does_not_belong_to_selected_table');
  });
  it('preserves a closed-open date interval on one source', () => {
    const answer = decodePlannerOutput(wrap({...payload,kind:'filtered_count',operation:'count',filters:[
      {column:'Charges.charged_on',operator:'gte',value:'2025-01-01',upperExclusive:'2026-01-01'},
    ]}),catalog,[],'Count charges during 2025');
    expect(answer[0]?.intent).toEqual({kind:'filtered_count',table:'Charges',column:'charged_on',operator:'gte',value:'2025-01-01',upperExclusive:'2026-01-01'});
  });
});

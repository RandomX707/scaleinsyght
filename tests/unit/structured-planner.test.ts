import { describe, expect, it } from 'vitest';
import { asksPerGroup, decodePlannerOutput, hasNamedCountSubject, normalizeCatalogMentions, plannerSchema } from '../../apps/api/src/structured-planner.js';

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
  it('reads the subject before do, does or did in a per-group count question', () => {
    // Regression: the subject used to run on to the last noun ("department"), so plans counting orders were rejected.
    const orders = [{assets: [{qualified_name:'dbo.orders',columns:[{name:'order_id'},{name:'department_id'}]},{qualified_name:'dbo.departments',columns:[{name:'department_id'},{name:'department_name'}]}]}];
    const grouped = {source_index:0,kind:'grouped_join',table:'dbo.orders',join:null,groupBy:'dbo.departments.department_name',groupKey:null,entityColumn:null,operation:'count',aggregateColumn:null,order:'desc',limit:null,filters:[]};
    expect(() => decodePlannerOutput(wrap(grouped), orders, [], 'How many orders does each department have?')).not.toThrow('count_the_named_subject_table');
    expect(hasNamedCountSubject('How many orders does each department have?',[{assets:[{qualified_name:'dbo.orders',columns:[{name:'order_id'}]}]}],[])).toBe(true);
  });
  it('rejects a single total for a per-group question', () => {
    const orders = [{assets: [{qualified_name:'dbo.orders',columns:[{name:'order_id'},{name:'department_id'}]},{qualified_name:'dbo.departments',columns:[{name:'department_id'},{name:'department_name'}]}]}];
    const joins = [{source_index:0,from_name:'dbo.orders.department_id',to_name:'dbo.departments.department_id'}];
    const total = {source_index:0,kind:'join_aggregate',table:'dbo.orders',join:'dbo.orders.department_id = dbo.departments.department_id',groupBy:null,groupKey:null,entityColumn:null,operation:'count',aggregateColumn:null,order:null,limit:null,filters:[]};
    expect(() => decodePlannerOutput(wrap(total), orders, joins, 'How many orders does each department have?')).toThrow('group_the_result_by_the_requested_dimension');
    for (const question of ['Give counts by order type','Break down order counts by order status','List the number of Charges for each Charge Type','Orders per department, top 5']) expect(asksPerGroup(question), question).toBe(true);
    for (const question of ['Give separate order totals for each testbed','How many orders have status placed?','Compare the number of orders in each source','How many encounters were admitted during 2024?']) expect(asksPerGroup(question), question).toBe(false);
  });
  it('separates the subject from a source qualifier', () => {
    expect(hasNamedCountSubject('How many Charges in the workbook were recorded?',catalog,[])).toBe(true);
  });
  it('rejects a dimension count when the question names the fact table', () => {
    const sources = [{assets:[...catalog[0]!.assets,{qualified_name:'Departments',columns:[{name:'name'}]}]}];
    expect(() => decodePlannerOutput(wrap({...payload,table:'Departments'}),sources,[],'How many charges belong to Imaging?'))
      .toThrow('count_the_named_subject_table');
  });
  it('rejects a single-table count that uses an asserted join to smuggle a dimension filter', () => {
    const sources = [{assets:[...catalog[0]!.assets,{qualified_name:'Departments',columns:[{name:'name'}]}]}];
    const joins = [{source_index:0,from_name:'Charges.charge_type',to_name:'Departments.name'}];
    const output = wrap({...payload,kind:'filtered_count',table:'Charges',join:'Charges.charge_type = Departments.name',
      filters:[{column:'Departments.name',operator:'eq',value:'Imaging',upperExclusive:null}]});
    expect(() => decodePlannerOutput(output,sources,joins,'How many charges belong to Imaging?')).toThrow('join_requires_a_join_intent');
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

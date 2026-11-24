import { describe, expect, it } from 'vitest';
import { decodePlannerOutput, describePlan, normalizeCatalogMentions, plannerSchema } from '../../apps/api/src/structured-planner.js';

const catalog = [{name:'Operations workbook',assets: [{qualified_name:'Charges',columns:[{name:'charge_type',label:'Charge Type'},{name:'charged_on'},{name:'amount',label:'Amount'}]}]}];
const declaration = {subject:'charges',grouping:null,conditions:[],comparison:false,answerable:true};
const declared = {subject_table:'Charges',measure:'count',measure_column:null,grouping_column:null,filter_columns:[] as string[]};
const step = {
  source_index:0, declared, kind:'count',table:'Charges',join:null,groupBy:null,
  groupKey:null, entityColumn:null,operation:'count',aggregateColumn:null,order:null,limit:null,filters:[] as unknown[],
};
const wrap = (intent: Record<string, unknown>, top: Record<string, unknown> = declaration) => JSON.stringify({declaration:top,intents:[intent]});
const grouped = {...step,kind:'group_by',groupBy:'Charges.charge_type',order:'asc',limit:2,declared:{...declared,grouping_column:'Charges.charge_type'}};
const orders = [{name:'SQL Server hospital',assets: [{qualified_name:'dbo.orders',columns:[{name:'order_id'},{name:'department_id'}]},{qualified_name:'dbo.departments',columns:[{name:'department_id'},{name:'department_name'}]}]}];
const orderJoins = [{source_index:0,from_name:'dbo.orders.department_id',to_name:'dbo.departments.department_id'}];
const orderStep = {...step,table:'dbo.orders',join:'dbo.orders.department_id = dbo.departments.department_id',declared:{...declared,subject_table:'dbo.orders'}};

describe('structured planner with declared intent (decision 44)', () => {
  it('exposes SQL identifiers, original labels and the declaration fields', () => {
    const schema = JSON.stringify(plannerSchema(catalog, []));
    expect(schema).toContain('Charges.charge_type is displayed as Charge Type');
    for (const field of ['declaration','answerable','comparison','subject_table','grouping_column','filter_columns']) expect(schema).toContain(field);
    expect(decodePlannerOutput(wrap(grouped, {...declaration,grouping:'charge type'}), catalog, []).steps[0]?.intent).toEqual({
      kind:'group_by',table:'Charges',groupBy:'charge_type',order:'asc',orderBy:'value',limit:2,aggregate:{operation:'count'},
    });
  });
  it('preserves catalog headings through redaction without normalizing arbitrary names', () => {
    expect(normalizeCatalogMentions('Show Charge Types for Jane Doe',catalog)).toBe('Show charge types for Jane Doe');
  });
  it('refuses when the model declares the subject absent', () => {
    expect(decodePlannerOutput(JSON.stringify({declaration:{...declaration,answerable:false},intents:[]}), catalog, []).steps).toEqual([]);
    expect(() => decodePlannerOutput(wrap(step,{...declaration,answerable:false}), catalog, [])).toThrow('declared_unanswerable_but_planned');
  });
  it('rejects a single total when the step declares a grouping', () => {
    // "How many orders does each department have?" planned as one join count.
    const total = {...orderStep,kind:'join_aggregate',declared:{...orderStep.declared,grouping_column:'dbo.departments.department_name'}};
    expect(() => decodePlannerOutput(wrap(total), orders, orderJoins)).toThrow('plan_grouping_differs_from_declared_grouping');
    const breakdown = {...orderStep,kind:'grouped_join',groupBy:'dbo.departments.department_name',order:'desc',declared:total.declared};
    expect(decodePlannerOutput(wrap(breakdown), orders, orderJoins).steps[0]?.intent).toMatchObject({kind:'grouped_join',groupByTable:'right',groupBy:'department_name'});
  });
  it('rejects a plan that groups when the step declares a single value', () => {
    expect(() => decodePlannerOutput(wrap({...grouped,declared}), catalog, [])).toThrow('declared_single_value_but_plan_groups');
  });
  it('rejects a plan whose subject differs from the declared subject', () => {
    const counted = {...orderStep,join:null,table:'dbo.departments'};
    expect(() => decodePlannerOutput(wrap(counted), orders, orderJoins)).toThrow('plan_subject_differs_from_declared_subject');
  });
  it('rejects a plan whose filters or measure differ from the declaration', () => {
    const filtered = {...step,kind:'filtered_count',filters:[{column:'Charges.charge_type',operator:'eq',value:'lab',upperExclusive:null}]};
    expect(() => decodePlannerOutput(wrap(filtered), catalog, [])).toThrow('plan_filters_differ_from_declared_filters');
    expect(decodePlannerOutput(wrap({...filtered,declared:{...declared,filter_columns:['Charges.charge_type']}}), catalog, []).steps[0]?.intent)
      .toEqual({kind:'filtered_count',table:'Charges',column:'charge_type',operator:'eq',value:'lab'});
    expect(() => decodePlannerOutput(wrap({...step,kind:'compare_aggregates',operation:'sum',aggregateColumn:'Charges.amount'}), catalog, [])).toThrow('plan_measure_differs_from_declared_measure');
  });
  it('checks the declared comparison against the number of sources', () => {
    expect(() => decodePlannerOutput(wrap(step,{...declaration,comparison:true}), catalog, [])).toThrow('declared_comparison_needs_two_sources');
  });
  it('rejects a single-table count that uses an asserted join to smuggle a dimension filter', () => {
    const sources = [{assets:[...catalog[0]!.assets,{qualified_name:'Departments',columns:[{name:'name'}]}]}];
    const joins = [{source_index:0,from_name:'Charges.charge_type',to_name:'Departments.name'}];
    const output = wrap({...step,kind:'filtered_count',join:'Charges.charge_type = Departments.name',
      filters:[{column:'Departments.name',operator:'eq',value:'Imaging',upperExclusive:null}],declared:{...declared,filter_columns:['Departments.name']}});
    expect(() => decodePlannerOutput(output,sources,joins)).toThrow('join_requires_a_join_intent');
  });
  it('rejects a column outside the selected table', () => {
    expect(() => decodePlannerOutput(wrap({...grouped,groupBy:'Visits.charge_type',declared:{...declared,grouping_column:'Visits.charge_type'}}), catalog, [])).toThrow('column_does_not_belong_to_selected_table');
  });
  it('preserves a closed-open date interval on one source', () => {
    const answer = decodePlannerOutput(wrap({...step,kind:'filtered_count',filters:[
      {column:'Charges.charged_on',operator:'gte',value:'2025-01-01',upperExclusive:'2026-01-01'},
    ],declared:{...declared,filter_columns:['Charges.charged_on']}}),catalog,[]);
    expect(answer.steps[0]?.intent).toEqual({kind:'filtered_count',table:'Charges',column:'charged_on',operator:'gte',value:'2025-01-01',upperExclusive:'2026-01-01'});
  });
  it('describes an accepted plan in plain words for verification', () => {
    const decoded = decodePlannerOutput(wrap(grouped, {...declaration,grouping:'charge type'}), catalog, []);
    expect(describePlan(decoded.steps, catalog)).toBe('Operations workbook: the number of Charges records, for each Charge Type, keeping the lowest 2');
  });
});

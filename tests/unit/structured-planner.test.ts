import { describe, expect, it } from 'vitest';
import { decodePlannerOutput, describePlan, normalizeCatalogMentions, plannerSchema, type PlannerFacts } from '../../apps/api/src/structured-planner.js';

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
  it('fills an empty executable grouping from the declaration but rejects a different one', () => {
    const visits = [{name:'Operations workbook',assets:[{qualified_name:'Visits',columns:[{name:'department',label:'Department'},{name:'patient_id',label:'Patient ID'}]}]}];
    const average = {...step,kind:'average_count_by',table:'Visits',groupBy:null,entityColumn:'Visits.patient_id',
      declared:{...declared,subject_table:'Visits',measure:'average_count_per_entity',grouping_column:'Visits.department'}};
    expect(decodePlannerOutput(wrap(average), visits, []).steps[0]?.intent).toEqual({kind:'average_count_by',table:'Visits',groupBy:'department',entityColumn:'patient_id',limit:100});
    expect(() => decodePlannerOutput(wrap({...average,groupBy:'Visits.patient_id'}), visits, [])).toThrow('plan_grouping_differs_from_declared_grouping');
  });
  it('never groups by a tagged column, which would return raw identifier values', () => {
    // heldout2 N06: "five provider IDs with the most encounters" was planned per patient_id, returning raw patient IDs.
    const encounters = [{name:'SQL Server hospital',assets:[{qualified_name:'dbo.encounters',columns:[{name:'patient_id',sensitivity_tags:['identifier']},{name:'provider_id',sensitivity_tags:[]}]}]}];
    const perPatient = {...step,kind:'group_by',table:'dbo.encounters',groupBy:'dbo.encounters.patient_id',order:'desc',limit:5,
      declared:{...declared,subject_table:'dbo.encounters',grouping_column:'dbo.encounters.patient_id'}};
    expect(() => decodePlannerOutput(wrap(perPatient), encounters, [])).toThrow('grouping_by_a_sensitive_column_is_not_allowed');
    const perProvider = {...perPatient,groupBy:'dbo.encounters.provider_id',declared:{...perPatient.declared,grouping_column:'dbo.encounters.provider_id'}};
    expect(decodePlannerOutput(wrap(perProvider), encounters, []).steps[0]?.intent).toMatchObject({kind:'group_by',groupBy:'provider_id'});
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
    expect(describePlan(decoded.steps, catalog)).toBe('Operations workbook: the number of Charges records, for each charge type, keeping the lowest 2 (ties broken alphabetically by group)');
  });
});

describe('conditions on the counted table (K6, decision 54)', () => {
  const filter = (column: string, operator: string, value: unknown, upperExclusive: string | null = null) => ({column,operator,value,upperExclusive});
  const counted = (filters: unknown[], kind = 'filtered_count', extra: Record<string, unknown> = {}) => ({...step,kind,filters,...extra,
    declared:{...declared,filter_columns:filters.map(item => (item as {column:string}).column),...(extra.declared as object ?? {})}});
  it('keeps every condition of a count with two or three conditions', () => {
    const decoded = decodePlannerOutput(wrap(counted([filter('Charges.charge_type','eq','lab'), filter('Charges.amount','gt',100), filter('Charges.charged_on','gte','2025-01-01','2026-01-01')])), catalog, []).steps[0]!;
    expect(decoded.intent).toEqual({kind:'filtered_count',table:'Charges',column:'charge_type',operator:'eq',value:'lab',
      filters:[{column:'amount',operator:'gt',value:100},{column:'charged_on',operator:'gte',value:'2025-01-01'},{column:'charged_on',operator:'lt',value:'2026-01-01'}]});
    expect(describePlan([decoded], catalog)).toContain('where charge_type eq "lab" and amount gt 100 and charged_on gte "2025-01-01" and charged_on lt "2026-01-01"');
  });
  it('keeps a single condition exactly as before', () => {
    expect(decodePlannerOutput(wrap(counted([filter('Charges.charge_type','eq','lab')])), catalog, []).steps[0]!.intent)
      .toEqual({kind:'filtered_count',table:'Charges',column:'charge_type',operator:'eq',value:'lab'});
  });
  it('applies conditions to a grouped count', () => {
    const plan = counted([filter('Charges.amount','gt',100)], 'group_by', {groupBy:'Charges.charge_type',declared:{grouping_column:'Charges.charge_type'}});
    expect(decodePlannerOutput(wrap(plan, {...declaration,grouping:'charge type'}), catalog, []).steps[0]!.intent)
      .toMatchObject({kind:'group_by',groupBy:'charge_type',filters:[{column:'amount',operator:'gt',value:100}]});
  });
  it('refuses a condition on another table without a join', () => {
    const plan = {...orderStep,join:null,kind:'filtered_count',filters:[filter('dbo.departments.department_name','eq','Emergency')],
      declared:{...orderStep.declared,filter_columns:['dbo.departments.department_name']}};
    expect(() => decodePlannerOutput(wrap(plan), orders, orderJoins)).toThrow();
  });
});

describe('display labels for key columns (decision 45)', () => {
  const catalog = [{name:'SQL Server hospital',assets:[
    {qualified_name:'dbo.orders',columns:[{name:'order_id'},{name:'department_id'},{name:'encounter_id'}]},
    {qualified_name:'dbo.departments',columns:[{name:'department_id'},{name:'department_code'},{name:'department_name'}]},
    {qualified_name:'dbo.department_order_summary',columns:[{name:'department_id'},{name:'order_count'}]},
  ]}];
  const joins = [{source_index:0,from_name:'dbo.orders.department_id',to_name:'dbo.departments.department_id',evidence_method:'declared',confidence_score:1}];
  const stat = (distinctCount: number, averageLength: number | null = null, nullRate = 0) => ({distinctCount,nullRate,averageLength});
  const facts = (): PlannerFacts => [{
    'dbo.orders': {rowCount:1500,columns:{order_id:stat(1500),department_id:stat(12),encounter_id:stat(900)}},
    'dbo.departments': {rowCount:12,columns:{department_id:stat(12),department_code:stat(12,5),department_name:stat(12,9.4)}},
    'dbo.department_order_summary': {rowCount:12,columns:{department_id:stat(12),order_count:stat(12)}},
  }];
  const perDepartment = {...step,kind:'group_by',table:'dbo.orders',groupBy:'dbo.orders.department_id',
    declared:{...declared,subject_table:'dbo.orders',grouping_column:'dbo.orders.department_id'}};
  const decode = (item: Record<string, unknown>, known: PlannerFacts = facts(), relations = joins) => decodePlannerOutput(wrap(item,{...declaration,grouping:'department'}), catalog, relations, known).steps[0]!;

  it('shows the related name, chosen from profile facts, when a plan groups by a key column', () => {
    const decoded = decode(perDepartment);
    expect(decoded.display).toEqual({key:'dbo.orders.department_id',label:'dbo.departments.department_name',via:'dbo.orders.department_id = dbo.departments.department_id'});
    expect(decoded.intent).toEqual({kind:'grouped_join',leftTable:'dbo.orders',rightTable:'dbo.departments',leftColumn:'department_id',rightColumn:'department_id',
      groupByTable:'right',groupBy:'department_name',groupKey:'department_id',aggregate:{operation:'count'},filters:[],order:'desc',limit:100});
    // Verification checks the computation the model planned; the label changes only how each group is shown.
    expect(describePlan([decoded], catalog)).toBe('SQL Server hospital: the number of dbo.orders records, for each department_id');
  });
  it('relabels a grouped join that groups by its own join key', () => {
    const byKey = {...perDepartment,kind:'grouped_join',join:'dbo.orders.department_id = dbo.departments.department_id',groupBy:'dbo.departments.department_id',
      declared:{...perDepartment.declared,grouping_column:'dbo.departments.department_id'}};
    expect(decode(byKey).intent).toMatchObject({kind:'grouped_join',groupByTable:'right',groupBy:'department_name',groupKey:'department_id'});
  });
  // K12: "each department" counts from the departments table, so a department with no orders shows 0.
  const every = (item: Record<string, unknown>, known: PlannerFacts = facts(), relations = joins) => decodePlannerOutput(wrap(item,{...declaration,grouping:'department',every_group:true}), catalog, relations, known).steps[0]!;
  it('counts from the dimension table when the question asks for every group (K12)', () => {
    const decoded = every(perDepartment);
    expect(decoded.intent).toMatchObject({kind:'grouped_join',leftTable:'dbo.orders',rightTable:'dbo.departments',groupByTable:'right',groupBy:'department_name',groupKey:'department_id',emptyGroups:'zero'});
    expect(describePlan([decoded], catalog)).toBe('SQL Server hospital: the number of dbo.orders records, for each department_id, including every dbo.departments record with none, counted as 0');
    // Without the declaration the plan is unchanged.
    expect(decode(perDepartment).intent).not.toHaveProperty('emptyGroups');
  });
  it('counts from the dimension key when there is no display name to show (K12)', () => {
    const noName = facts(); noName[0]!['dbo.departments']!.columns.department_name = stat(9, 9); noName[0]!['dbo.departments']!.columns.department_code = stat(9, 5);
    expect(every(perDepartment, noName).intent).toMatchObject({kind:'grouped_join',groupByTable:'right',groupBy:'department_id',emptyGroups:'zero'});
  });
  it('leaves the plan alone without a trusted relationship or a unique dimension key (K12)', () => {
    const inferred = [{...joins[0]!,evidence_method:'inferred',confidence_score:0.95}];
    expect(every(perDepartment, facts(), inferred).intent).not.toHaveProperty('emptyGroups');
    const repeatedKey = facts(); repeatedKey[0]!['dbo.departments']!.columns.department_id = stat(10);
    expect(every(perDepartment, repeatedKey).intent).not.toHaveProperty('emptyGroups');
    // A top-N question keeps its plan: the groups with none are not among the top.
    expect(every({...perDepartment,order:'desc',limit:3}).intent).not.toHaveProperty('emptyGroups');
  });
  it('attaches the join key when a grouped join groups by a unique name of the referenced table ("each department")', () => {
    const byName = {...perDepartment,kind:'grouped_join',join:'dbo.orders.department_id = dbo.departments.department_id',groupBy:'dbo.departments.department_name',
      declared:{...perDepartment.declared,grouping_column:'dbo.departments.department_name'}};
    expect(decode(byName).intent).toMatchObject({kind:'grouped_join',groupByTable:'right',groupBy:'department_name',groupKey:'department_id'});
    // A name that repeats is an attribute the person asked to group by, not one group per department: left as planned.
    const repeated = facts(); repeated[0]!['dbo.departments']!.columns.department_name = stat(9, 9);
    expect(decode(byName, repeated).intent).toMatchObject({groupBy:'department_name'});
    expect(decode(byName, repeated).intent).not.toHaveProperty('groupKey');
    expect(decode(byName, []).intent).toMatchObject({groupBy:'department_name'});
    expect(decode(byName, []).intent).not.toHaveProperty('groupKey');
  });
  it('keeps the conditions of a grouped count when the key is relabelled ("cancelled orders per department")', () => {
    const cancelled = {...perDepartment,filters:[{column:'dbo.orders.order_id',operator:'gt',value:0,upperExclusive:null}],
      declared:{...perDepartment.declared,filter_columns:['dbo.orders.order_id']}};
    expect(decode(cancelled).intent).toMatchObject({kind:'grouped_join',groupBy:'department_name',groupKey:'department_id',
      filters:[{table:'left',column:'order_id',operator:'gt',value:0}]});
  });
  it('keeps the key when the relationship or the label cannot be trusted', () => {
    const keep = (known: PlannerFacts, relations = joins) => decode(perDepartment, known, relations);
    const withNulls = facts(); withNulls[0]!['dbo.orders']!.columns.department_id = stat(12, null, 0.02);
    expect(keep(withNulls).display).toBeNull();
    expect(keep(facts(), [{...joins[0]!,evidence_method:'inferred',confidence_score:0.97}]).display).toBeNull();
    const repeated = facts(); repeated[0]!['dbo.departments']!.columns = {department_id:stat(12),department_code:stat(11,5),department_name:stat(11,9)};
    expect(keep(repeated).display).toBeNull();
    expect(keep([]).intent).toMatchObject({kind:'group_by',groupBy:'department_id'});
    const tagged = [{...catalog[0]!,assets:catalog[0]!.assets.map(asset => asset.qualified_name !== 'dbo.departments' ? asset
      : {...asset,columns:asset.columns.map(column => ({...column,sensitivity_tags:column.name === 'department_id' ? [] : ['personal']}))})}];
    expect(decodePlannerOutput(wrap(perDepartment,{...declaration,grouping:'department'}), tagged, joins, facts()).steps[0]!.display).toBeNull();
  });
  it('rejects grouping a table by a column that is unique in it', () => {
    // Q31 seen once: orders per department read from a one-row-per-department summary, so every cell was withheld.
    const summary = {...step,kind:'group_by',table:'dbo.department_order_summary',groupBy:'dbo.department_order_summary.department_id',operation:'sum',
      aggregateColumn:'dbo.department_order_summary.order_count',declared:{...declared,subject_table:'dbo.department_order_summary',measure:'sum',
        measure_column:'dbo.department_order_summary.order_count',grouping_column:'dbo.department_order_summary.department_id'}};
    expect(() => decode(summary)).toThrow('grouping_column_is_unique_in_its_table');
  });
});

describe('lineage requests', () => {
  const lineage = (value: Record<string, unknown>, intents: unknown[] = []) => JSON.stringify({lineage: value, declaration, intents});
  it('decodes a lineage request on a catalog table or column with no query intents', () => {
    expect(decodePlannerOutput(lineage({source_index:0,asset:'Charges.amount',direction:'upstream'}), catalog, []).lineage).toEqual({index:0,asset:'Charges.amount',direction:'upstream'});
    expect(decodePlannerOutput(lineage({source_index:0,asset:'Charges',direction:'downstream'}), catalog, []).steps).toEqual([]);
    expect(JSON.stringify(plannerSchema(catalog, []))).toContain('"Charges.amount"');
  });
  it('rejects a lineage request outside the catalog, with intents, or with an unknown direction', () => {
    expect(() => decodePlannerOutput(lineage({source_index:0,asset:'Visits.amount',direction:'upstream'}), catalog, [])).toThrow('lineage_asset_outside_catalog');
    expect(() => decodePlannerOutput(lineage({source_index:0,asset:'Charges',direction:'upstream'}, [step]), catalog, [])).toThrow('lineage_request_with_query_intents');
    expect(() => decodePlannerOutput(lineage({source_index:0,asset:'Charges',direction:'sideways'}), catalog, [])).toThrow('lineage_request_invalid');
  });
});

it('excludes sensitive columns from group options without excluding internal entity keys', () => {
  const schema = plannerSchema([{name:'Visits',assets:[{qualified_name:'visits',columns:[
    {name:'patient_id',sensitivity_tags:['identifier']},{name:'department'},
  ]}]}], []);
  const stepProperties = (schema as {properties:{intents:{items:{anyOf:Array<{properties:Record<string,unknown>}>}}}}).properties.intents.items.anyOf[0]!.properties;
  const declaredProperties = (stepProperties.declared as {properties:Record<string,unknown>}).properties;
  for (const option of [stepProperties.groupBy, stepProperties.groupKey, declaredProperties.grouping_column]) {
    expect(JSON.stringify(option)).toContain('visits.department');
    expect(JSON.stringify(option)).not.toContain('visits.patient_id');
  }
  expect(JSON.stringify(stepProperties.entityColumn)).toContain('visits.patient_id');
});

it('validates the named column for a privacy refusal', () => {
  const visits = [{name:'Visits',assets:[{qualified_name:'visits',columns:[
    {name:'patient_id',sensitivity_tags:['identifier']},{name:'department'},
  ]}]}];
  const response = (column: string) => JSON.stringify({
    declaration:{...declaration,answerable:false}, intents:[], privacy_refusal:column,
  });
  expect(() => decodePlannerOutput(response('visits.patient_id'),visits,[])).toThrow('grouping_by_a_sensitive_column_is_not_allowed: visits.patient_id is tagged identifier');
  expect(() => decodePlannerOutput(response('visits.department'),visits,[])).toThrow('privacy_refusal_column_not_sensitive');
});

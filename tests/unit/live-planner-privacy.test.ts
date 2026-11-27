import { expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { planLiveQuestion } from '../../apps/api/src/live-planner.js';

const { query, complete } = vi.hoisted(() => ({ query: vi.fn(), complete: vi.fn() }));
vi.mock('@scaleinsyght/db', () => ({
  withTenant: (_pool: object, _tenant: string, read: (client: { query: typeof query }) => unknown) => read({query}),
}));
vi.mock('@scaleinsyght/model-gateway', () => ({
  OpenAIModelGateway: class { complete = complete; },
}));

it('refuses encounters by patient ID after exactly one planning call', async () => {
  query.mockResolvedValue({rows:[]});
  query.mockResolvedValueOnce({rows:[{source_id:'source',assets:[{qualified_name:'public.encounters',columns:[
    {name:'patient_id',sensitivity_tags:['identifier']},{name:'visit_type',sensitivity_tags:[]},
  ]}]}]});
  complete.mockResolvedValueOnce({model:'planner',inputTokens:1,outputTokens:1,text:JSON.stringify({
    privacy_refusal:'public.encounters.patient_id',
    declaration:{subject:'encounters',grouping:'patient ID',conditions:[],comparison:false,answerable:false,exposed_columns:['public.encounters.patient_id'],read_columns:['public.encounters.patient_id']},
    intents:[],lineage:null,
  })});
  const result = await planLiveQuestion({} as Pool,'tenant','List the encounters per patient ID',[
    {source_id:'source',agent_id:'agent',group_id:'group',group_version:1,display_name:'Hospital',connector_type:'postgres'},
  ],[]);
  expect(result).toMatchObject({kind:'rejected',reason:'analytic_sensitive_column'});
  expect(complete).toHaveBeenCalledTimes(1);
  expect(complete).toHaveBeenCalledWith(expect.objectContaining({purpose:'plan'}));
});

// S2, 27 Nov 2026 13:10: the planning model answered "List the encounters per patient ID" with no privacy_refusal,
// answerable false and no plan, so the run ended analytic_query_unsupported. The refusal is decided by code from the
// tag on the resolved column, so the same response now ends as the privacy refusal, after the one planning call.
it('refuses by the column tag even when the planner declares the question unsupported', async () => {
  query.mockReset(); complete.mockReset();
  query.mockResolvedValue({rows:[]});
  query.mockResolvedValueOnce({rows:[{source_id:'source',assets:[{qualified_name:'dbo.encounters',columns:[
    {name:'encounter_id',sensitivity_tags:[]},{name:'patient_id',sensitivity_tags:['identifier']},{name:'provider_id',sensitivity_tags:[]},
  ]}]}]});
  complete.mockResolvedValueOnce({model:'planner',inputTokens:1,outputTokens:1,text:JSON.stringify({
    privacy_refusal:null,
    declaration:{subject:'encounters',grouping:'patient ID',conditions:[],comparison:false,answerable:false,exposed_columns:['dbo.encounters.patient_id'],read_columns:['dbo.encounters.patient_id']},
    intents:[],lineage:null,
  })});
  const result = await planLiveQuestion({} as Pool,'tenant','List the encounters per patient ID',[
    {source_id:'source',agent_id:'agent',group_id:'group',group_version:1,display_name:'SQL Server hospital',connector_type:'sql_server'},
  ],[]);
  expect(result).toMatchObject({kind:'rejected',reason:'analytic_sensitive_column'});
  expect(complete).toHaveBeenCalledTimes(1);
});

// Decision 65: a missing, empty or unknown column declaration is re-asked once with the validation error; a second one
// ends neutrally as a question that cannot be answered yet, and nothing is planned or run.
const s2Source = [{source_id:'source',agent_id:'agent',group_id:'group',group_version:1,display_name:'SQL Server hospital',connector_type:'sql_server'}];
const s2Catalog = {rows:[{source_id:'source',assets:[{qualified_name:'dbo.encounters',columns:[
  {name:'encounter_id',sensitivity_tags:[]},{name:'patient_id',sensitivity_tags:['identifier']},{name:'provider_id',sensitivity_tags:[]},{name:'visit_type',sensitivity_tags:[]},
]}]}]};
const reply = (declaration: Record<string, unknown>, intents: unknown[] = []) => ({model:'planner',inputTokens:1,outputTokens:1,text:JSON.stringify({privacy_refusal:null,lineage:null,intents,
  declaration:{subject:'encounters',grouping:null,conditions:[],comparison:false,answerable:false,...declaration}})});
async function plan(...responses: Array<ReturnType<typeof reply>>) {
  query.mockReset(); complete.mockReset();
  query.mockResolvedValue({rows:[]}); query.mockResolvedValueOnce(s2Catalog);
  for (const response of responses) complete.mockResolvedValueOnce(response);
  return planLiveQuestion({} as Pool,'tenant','List the encounters per patient ID',s2Source,[]);
}

it('re-asks once when an unanswerable declaration names no columns, then ends neutrally', async () => {
  const empty = reply({grouping:'patient ID',exposed_columns:[],read_columns:[]});
  expect(await plan(empty, empty)).toMatchObject({kind:'rejected',reason:'analytic_query_unsupported'});
  expect(complete).toHaveBeenCalledTimes(2);
  expect(complete.mock.calls[1]![0].question).toContain('Previous response failed validation: declared_grouping_without_exposed_column');
});

it('re-asks once with the error and refuses when the second answer names the tagged column', async () => {
  const resolved = reply({grouping:'patient ID',exposed_columns:['dbo.encounters.patient_id'],read_columns:['dbo.encounters.patient_id']});
  expect(await plan(reply({exposed_columns:[],read_columns:[]}), resolved)).toMatchObject({kind:'rejected',reason:'analytic_sensitive_column'});
  expect(complete).toHaveBeenCalledTimes(2);
  expect(complete.mock.calls[1]![0].question).toContain('unanswerable_without_resolved_columns');
});

it('re-asks once on an unknown column and ends neutrally when it is still unknown', async () => {
  const unknown = reply({grouping:'patient ID',exposed_columns:['dbo.encounters.patient_number'],read_columns:['dbo.encounters.patient_number']});
  expect(await plan(unknown, unknown)).toMatchObject({kind:'rejected',reason:'analytic_query_unsupported'});
  expect(complete).toHaveBeenCalledTimes(2);
  expect(complete.mock.calls[1]![0].question).toContain('outside_catalog: dbo.encounters.patient_number');
});

it('never runs a plan whose declared columns do not cover the columns it reads', async () => {
  const step = {source_index:0,kind:'filtered_count',table:'dbo.encounters',join:null,groupBy:null,groupKey:null,entityColumn:null,operation:'count',aggregateColumn:null,order:null,limit:null,
    filters:[{column:'dbo.encounters.visit_type',operator:'eq',value:'inpatient',upperExclusive:null}],
    declared:{subject_table:'dbo.encounters',measure:'count',measure_column:null,grouping_column:null,filter_columns:['dbo.encounters.visit_type']}};
  const uncovered = reply({answerable:true,conditions:['inpatient'],exposed_columns:[],read_columns:['dbo.encounters.provider_id']}, [step]);
  expect(await plan(uncovered, uncovered)).toMatchObject({kind:'rejected',reason:'analytic_query_unsupported'});
  expect(complete).toHaveBeenCalledTimes(2);
  expect(complete.mock.calls[1]![0].question).toContain('plan_reads_undeclared_columns: dbo.encounters.visit_type must be in read_columns');
});

// K16: a tagged group key with an untagged shown name ends in the privacy refusal after one planning call.
it('refuses a plan whose group key is tagged even though the shown name is not', async () => {
  query.mockReset(); complete.mockReset();
  query.mockResolvedValue({rows:[]});
  query.mockResolvedValueOnce({rows:[{source_id:'source',assets:[
    {qualified_name:'dbo.encounters',columns:[{name:'encounter_id',sensitivity_tags:[]},{name:'provider_id',sensitivity_tags:[]}]},
    {qualified_name:'dbo.providers',columns:[{name:'provider_id',sensitivity_tags:['identifier']},{name:'provider_name',sensitivity_tags:[]}]},
  ]}]});
  query.mockResolvedValueOnce({rows:[{source_index:0,from_name:'dbo.encounters.provider_id',to_name:'dbo.providers.provider_id',evidence_method:'declared',confidence_score:1}]});
  const step = {source_index:0,kind:'grouped_join',table:'dbo.encounters',join:'dbo.encounters.provider_id = dbo.providers.provider_id',groupBy:'dbo.providers.provider_name',groupKey:'dbo.providers.provider_id',
    entityColumn:null,operation:'count',aggregateColumn:null,order:'desc',limit:null,filters:[],
    declared:{subject_table:'dbo.encounters',measure:'count',measure_column:null,grouping_column:'dbo.providers.provider_name',filter_columns:[]}};
  complete.mockResolvedValueOnce({model:'planner',inputTokens:1,outputTokens:1,text:JSON.stringify({privacy_refusal:null,lineage:null,intents:[step],
    declaration:{subject:'encounters',grouping:'provider',conditions:[],comparison:false,answerable:true,
      exposed_columns:['dbo.providers.provider_name'],read_columns:['dbo.providers.provider_name','dbo.providers.provider_id','dbo.encounters.provider_id']}})});
  const result = await planLiveQuestion({} as Pool,'tenant','How many encounters does each provider have? Use provider names.',[
    {source_id:'source',agent_id:'agent',group_id:'group',group_version:1,display_name:'SQL Server hospital',connector_type:'sql_server'}],[]);
  expect(result).toMatchObject({kind:'rejected',reason:'analytic_sensitive_column'});
  expect(complete).toHaveBeenCalledTimes(1);
});

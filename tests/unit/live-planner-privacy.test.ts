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
    declaration:{subject:'encounters',grouping:'patient ID',conditions:[],comparison:false,answerable:false},
    intents:[],lineage:null,
  })});
  const result = await planLiveQuestion({} as Pool,'tenant','List the encounters per patient ID',[
    {source_id:'source',agent_id:'agent',group_id:'group',group_version:1,display_name:'Hospital',connector_type:'postgres'},
  ],[]);
  expect(result).toMatchObject({kind:'rejected',reason:'analytic_sensitive_column'});
  expect(complete).toHaveBeenCalledTimes(1);
  expect(complete).toHaveBeenCalledWith(expect.objectContaining({purpose:'plan'}));
});

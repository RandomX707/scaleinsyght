import { afterAll,describe,expect,it } from 'vitest';
import { config } from 'dotenv';
import { createPostgresConnector } from '@scaleinsyght/connectors';
import { parseQueryIntent } from '@scaleinsyght/contracts';

config({path:'.env'});
const url=process.env.DATABASE_URL_TESTBED;if(!url)throw new Error('DATABASE_URL_TESTBED is required; run pnpm testbed:up first.');
const connector=createPostgresConnector({connectionString:url,id:'testbed',name:'Testbed PostgreSQL',statementTimeoutMs:10_000,maxRows:1_000});
describe('contract 3 real PostgreSQL query intent execution',()=>{
  afterAll(async()=>connector.close());
  it('c3_compiles_five_typed_intents_to_read_only_sql_matching_truth',async()=>{
    expect(await connector.test()).toMatchObject({ok:true,readOnly:true});await connector.discover({mode:'profile'});
    const run=async(intent:unknown)=>{const parsed=parseQueryIntent(intent);return connector.executeQueryIntent!(parsed);};
    expect((await run({kind:'count',table:'public.patients'})).rows).toEqual([{value:'500'}]);
    expect((await run({kind:'filtered_count',table:'public.orders',column:'order_status',operator:'eq',value:'completed'})).rows).toEqual([{value:'400'}]);
    const grouped=await run({kind:'group_by',table:'public.orders',groupBy:'department_id',aggregate:{operation:'sum',column:'amount'}});expect(grouped.rows).toHaveLength(6);expect(grouped.rows.reduce((sum,row)=>sum+Number(row.value),0)).toBe(72900);
    expect((await run({kind:'join_aggregate',leftTable:'public.encounters',rightTable:'public.patients',leftColumn:'patient_id',rightColumn:'patient_id',aggregate:{operation:'count'}})).rows).toEqual([{value:'700'}]);
    expect((await run({kind:'compare_aggregates',table:'public.encounters',aggregate:{operation:'count'}})).rows).toEqual([{value:'700'}]);
  });
});

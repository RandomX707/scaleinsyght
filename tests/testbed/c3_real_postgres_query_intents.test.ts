import { afterAll,describe,expect,it } from 'vitest';
import { readFileSync } from 'node:fs';
import { config } from 'dotenv';
import { createPostgresConnector } from '@scaleinsyght/connectors';
import { parseQueryIntent } from '@scaleinsyght/contracts';

config({path:'.env'});
const truth=JSON.parse(readFileSync('testbed/truth.json','utf8')) as {rowCounts:Record<string,number>;metrics:Record<string,number>;answerChecks:{patientsWithPhone:{postgres:number};emergencyVisits2025:{postgres:number};ordersPerDepartmentTop5:{postgres:Array<{departmentId:number;departmentName:string;orderCount:number}>};averageEncountersPerPatientByProvider:{postgres:Array<{providerId:number;average:number}>}}};
const url=process.env.DATABASE_URL_TESTBED;if(!url)throw new Error('DATABASE_URL_TESTBED is required; run pnpm testbed:up first.');
const connector=createPostgresConnector({connectionString:url,id:'testbed',name:'Testbed PostgreSQL',statementTimeoutMs:10_000,maxRows:1_000});
describe('contract 3 real PostgreSQL query intent execution',()=>{
  afterAll(async()=>connector.close());
  it('c3_compiles_five_typed_intents_to_read_only_sql_matching_truth',async()=>{
    expect(await connector.test()).toMatchObject({ok:true,readOnly:true});await connector.discover({mode:'profile'});
    const run=async(intent:unknown)=>{const parsed=parseQueryIntent(intent);return connector.executeQueryIntent!(parsed);};
    expect((await run({kind:'count',table:'public.patients'})).rows).toEqual([{value:String(truth.rowCounts.patients)}]);
    expect((await run({kind:'filtered_count',table:'public.orders',column:'order_status',operator:'eq',value:'completed'})).rows).toEqual([{value:String(truth.metrics.completed_orders)}]);
    const grouped=await run({kind:'group_by',table:'public.orders',groupBy:'department_id',aggregate:{operation:'sum',column:'amount'}});expect(grouped.rows).toHaveLength(truth.rowCounts.departments!);expect(grouped.rows.reduce((sum,row)=>sum+Number(row.value),0)).toBeCloseTo(truth.metrics.order_amount!,2);
    expect((await run({kind:'join_aggregate',leftTable:'public.encounters',rightTable:'public.patients',leftColumn:'patient_id',rightColumn:'patient_id',aggregate:{operation:'count'}})).rows).toEqual([{value:String(truth.rowCounts.encounters)}]);
    expect((await run({kind:'compare_aggregates',table:'public.encounters',aggregate:{operation:'count'}})).rows).toEqual([{value:String(truth.rowCounts.encounters)}]);
    const emergency=await run({kind:'join_aggregate',leftTable:'public.encounters',rightTable:'public.departments',leftColumn:'department_id',rightColumn:'department_id',aggregate:{operation:'count'},filters:[{table:'public.departments',column:'department_name',operator:'eq',value:'Emergency'},{table:'public.encounters',column:'admitted_at',operator:'gte',value:'2025-01-01'},{table:'public.encounters',column:'admitted_at',operator:'lt',value:'2026-01-01'}]});expect(Number(emergency.rows[0]?.value)).toBe(truth.answerChecks.emergencyVisits2025.postgres);expect(emergency.sql).toContain('JOIN');
    const top=await run({kind:'grouped_join',leftTable:'public.orders',rightTable:'public.departments',leftColumn:'department_id',rightColumn:'department_id',groupByTable:'right',groupBy:'department_name',groupKey:'department_id',aggregate:{operation:'count'},filters:[],order:'desc',limit:5});expect(top.rows).toEqual(truth.answerChecks.ordersPerDepartmentTop5.postgres.map(row=>({group_value:row.departmentName,group_key:String(row.departmentId),value:String(row.orderCount)})));
    const byProvider=await run({kind:'average_count_by',table:'public.encounters',entityColumn:'patient_id',groupBy:'provider_id'});expect(byProvider.rows.map(row=>({providerId:Number(row.group_value),average:Number(row.value)}))).toEqual(truth.answerChecks.averageEncountersPerPatientByProvider.postgres);
    expect((await run({kind:'filtered_count',table:'public.patients',column:'phone',operator:'is_not_null'})).rows).toEqual([{value:String(truth.answerChecks.patientsWithPhone.postgres)}]);
  });
});

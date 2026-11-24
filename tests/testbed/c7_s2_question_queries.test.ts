import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import { createPostgresConnector, createSqlServerConnector, type ReadOnlyConnector } from '@scaleinsyght/connectors';
import { parseQueryIntent } from '@scaleinsyght/contracts';

config({ path: '.env' });
const pgUrl=process.env.DATABASE_URL_TESTBED;if(!pgUrl)throw new Error('DATABASE_URL_TESTBED is required; S2 query tests never skip.');
const sqlRequired=['SQLSERVER_TESTBED_HOST','SQLSERVER_TESTBED_PORT','SQLSERVER_TESTBED_DATABASE','SQLSERVER_TESTBED_USERNAME','SQLSERVER_TESTBED_PASSWORD'] as const;const missing=sqlRequired.filter(key=>!process.env[key]);if(missing.length)throw new Error(`${missing.join(', ')} is required; S2 query tests never skip.`);
const pg=createPostgresConnector({connectionString:pgUrl,id:'pg',name:'PostgreSQL testbed',statementTimeoutMs:10_000,maxRows:100});
const sqlServer=createSqlServerConnector({server:process.env.SQLSERVER_TESTBED_HOST!,port:Number(process.env.SQLSERVER_TESTBED_PORT),database:process.env.SQLSERVER_TESTBED_DATABASE!,username:process.env.SQLSERVER_TESTBED_USERNAME!,password:process.env.SQLSERVER_TESTBED_PASSWORD!,encrypt:true,trustServerCertificate:true,id:'mssql',name:'SQL Server testbed',statementTimeoutMs:10_000,maxRows:100});
const truth=JSON.parse(readFileSync('testbed/truth.json','utf8')) as {answerChecks:{emergencyVisits2025:{postgres:number;sqlServer:number};ordersPerDepartmentTop5:{postgres:Array<{departmentId:number;departmentName:string;orderCount:number}>};averageEncountersPerPatientByProvider:{postgres:Array<{providerId:number;average:number}>};patientCountComparison:{postgres:number;sqlServer:number};sharedPatientsCount:number};sqlServer:{answerMetrics:{emergencyVisits2025:number;ordersPerDepartmentTop5:Array<{departmentId:number;departmentName:string;orderCount:number}>;averageEncountersPerPatientByProvider:Array<{providerId:number;average:number}>}}};
const run=async(connector:ReadOnlyConnector,intent:unknown)=>connector.executeQueryIntent!(parseQueryIntent(intent));
const cases=(schema:string)=>({
 emergency:{kind:'join_aggregate',leftTable:`${schema}.encounters`,rightTable:`${schema}.departments`,leftColumn:'department_id',rightColumn:'department_id',aggregate:{operation:'count'},filters:[{table:`${schema}.departments`,column:'department_name',operator:'eq',value:'Emergency'},{table:`${schema}.encounters`,column:'admitted_at',operator:'gte',value:'2025-01-01'},{table:`${schema}.encounters`,column:'admitted_at',operator:'lt',value:'2026-01-01'}]},
 top:{kind:'grouped_join',leftTable:`${schema}.orders`,rightTable:`${schema}.departments`,leftColumn:'department_id',rightColumn:'department_id',groupByTable:'right',groupBy:'department_name',groupKey:'department_id',aggregate:{operation:'count'},filters:[],order:'desc',limit:5},
 average:{kind:'average_count_by',table:`${schema}.encounters`,entityColumn:'patient_id',groupBy:'provider_id',limit:100},
 count:{kind:'count',table:`${schema}.patients`},
 phone:{kind:'filtered_count',table:`${schema}.patients`,column:'phone',operator:'is_not_null'},
});

describe('contract 7 S2 typed answer queries against real PostgreSQL and SQL Server',()=>{
 beforeAll(async()=>{await pg.test();await pg.discover({mode:'profile'});await sqlServer.test();await sqlServer.discover({mode:'profile'});});
 afterAll(async()=>{await pg.close();await sqlServer.close();});
 it('c7_s2_emergency_2025_returns_the_truth_count_and_join_sql',async()=>{for(const [connector,schema,expected] of [[pg,'public',truth.answerChecks.emergencyVisits2025.postgres],[sqlServer,'dbo',truth.answerChecks.emergencyVisits2025.sqlServer]] as const){const result=await run(connector,cases(schema).emergency);expect(Number(result.rows[0]?.value)).toBe(expected);expect(result.sql).toContain('JOIN');expect(result.sql).toContain('admitted_at');expect(result.sql).toContain('department_name');}});
 it('c7_s2_top_five_department_orders_returns_labeled_rows_in_truth_order',async()=>{for(const [connector,schema,expected] of [[pg,'public',truth.answerChecks.ordersPerDepartmentTop5.postgres],[sqlServer,'dbo',truth.sqlServer.answerMetrics.ordersPerDepartmentTop5]] as const){const result=await run(connector,cases(schema).top);expect(result.rows.map(row=>({departmentId:Number(row.group_key),departmentName:row.group_value,orderCount:Number(row.value)}))).toEqual(expected);expect(result.sql).toContain('ORDER BY value DESC');}});
 it('c7_s2_average_encounters_per_patient_by_provider_matches_truth',async()=>{for(const [connector,schema,expected] of [[pg,'public',truth.answerChecks.averageEncountersPerPatientByProvider.postgres],[sqlServer,'dbo',truth.sqlServer.answerMetrics.averageEncountersPerPatientByProvider]] as const){const result=await run(connector,cases(schema).average);expect(result.rows.map(row=>({providerId:Number(row.group_value),average:Number(row.value)}))).toEqual(expected);expect(result.sql.toUpperCase()).toContain('COUNT');expect(result.sql.toUpperCase()).toContain('AVG');}});
 it('c7_s2_patient_count_comparison_matches_both_sources',async()=>{const [left,right]=await Promise.all([run(pg,cases('public').count),run(sqlServer,cases('dbo').count)]);expect(Number(left.rows[0]?.value)).toBe(truth.answerChecks.patientCountComparison.postgres);expect(Number(right.rows[0]?.value)).toBe(truth.answerChecks.patientCountComparison.sqlServer);expect(Number(left.rows[0]?.value)).toBe(Number(right.rows[0]?.value));});
 it('c7_s2_phone_number_follow_up_counts_non_null_phone_fields_in_both_sources',async()=>{for(const [connector,schema] of [[pg,'public'],[sqlServer,'dbo']] as const){const result=await run(connector,cases(schema).phone);expect(Number(result.rows[0]?.value)).toBe(500);expect(result.sql).toContain('phone');expect(result.sql).toContain('IS NOT NULL');}});
});

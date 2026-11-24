import { describe,expect,it } from 'vitest';
import { parseQueryIntent } from '@scaleinsyght/contracts';

describe('validated typed query intents',()=>{
  it('accepts count, filtered count, group-by, same-source join, and comparison intents',()=>{
    const intents=[
      {kind:'count',table:'public.patients'},
      {kind:'filtered_count',table:'public.orders',column:'order_status',operator:'eq',value:'completed'},
      {kind:'group_by',table:'public.orders',groupBy:'department_id',aggregate:{operation:'sum',column:'amount'}},
      {kind:'join_aggregate',leftTable:'public.encounters',rightTable:'public.patients',leftColumn:'patient_id',rightColumn:'patient_id',aggregate:{operation:'count'}},
      {kind:'compare_aggregates',table:'public.encounters',aggregate:{operation:'count'}},
      {kind:'join_aggregate',leftTable:'public.encounters',rightTable:'public.departments',leftColumn:'department_id',rightColumn:'department_id',aggregate:{operation:'count'},filters:[{table:'public.departments',column:'department_name',operator:'eq',value:'Emergency'},{table:'public.encounters',column:'admitted_at',operator:'gte',value:'2025-01-01'}]},
      {kind:'grouped_join',leftTable:'public.orders',rightTable:'public.departments',leftColumn:'department_id',rightColumn:'department_id',groupByTable:'right',groupBy:'department_name',aggregate:{operation:'count'},filters:[],order:'desc',limit:5},
      {kind:'average_count_by',table:'public.encounters',entityColumn:'patient_id',groupBy:'provider_id'},
      {kind:'filtered_count',table:'public.patients',column:'phone',operator:'is_not_null'},
    ];
    expect(intents.map(parseQueryIntent)).toEqual(intents);
  });
  it('rejects raw SQL, unknown fields, invalid operators, and dotted column expressions',()=>{
    for(const intent of [{sql:'SELECT * FROM patients'},{kind:'count',table:'public.patients',sql:'drop table patients'},{kind:'filtered_count',table:'public.orders',column:'amount);drop',operator:'=',value:1},{kind:'count',table:'public.patients'}]){
      if('sql'in intent||(intent as {kind:string}).kind!=='count')expect(()=>parseQueryIntent(intent)).toThrow('analytic_query_intent_invalid');
    }
  });
});

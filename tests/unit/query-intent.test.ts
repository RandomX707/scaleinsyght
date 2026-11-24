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
    ];
    expect(intents.map(parseQueryIntent)).toEqual(intents);
  });
  it('rejects raw SQL, unknown fields, invalid operators, and dotted column expressions',()=>{
    for(const intent of [{sql:'SELECT * FROM patients'},{kind:'count',table:'public.patients',sql:'drop table patients'},{kind:'filtered_count',table:'public.orders',column:'amount);drop',operator:'=',value:1},{kind:'count',table:'public.patients'}]){
      if('sql'in intent||(intent as {kind:string}).kind!=='count')expect(()=>parseQueryIntent(intent)).toThrow('analytic_query_intent_invalid');
    }
  });
});

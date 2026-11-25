import { expect, it } from 'vitest';
import { objectScope, type ControlsPolicy } from '@scaleinsyght/connectors';

const policy: ControlsPolicy = {
  groups:{table:'profile',view:'list_only'},
  nameRules:[
    {pattern:'public.audit_*',mode:'exclude',reason:'Audit records'},
    {pattern:'public.*',mode:'profile',reason:'Operational tables'},
  ],
  columnRules:[],newObjects:'approve',leavingScope:'keep',approval:true,
};

it('uses exact overrides before the first matching ordered name rule', () => {
  expect(objectScope({policy},'public.audit_daily','table')).toBe('exclude');
  expect(objectScope({policy,listOnly:['public.audit_daily']},'public.audit_daily','table')).toBe('list_only');
  expect(objectScope({policy},'other.events','view')).toBe('list_only');
  expect(objectScope({policy},'publicity.audit_daily','table')).toBe('profile');
});

it('keeps new objects out of profiling until approved when the policy requires it', () => {
  expect(objectScope({policy,knownObjects:new Set()},'public.orders','table')).toBe('list_only');
  expect(objectScope({policy,knownObjects:new Set()},'public.audit_daily','table')).toBe('exclude');
  expect(objectScope({policy:{...policy,newObjects:'rules'},knownObjects:new Set()},'public.orders','table')).toBe('profile');
  expect(objectScope({policy:{...policy,newObjects:'ignore'},knownObjects:new Set()},'public.orders','table')).toBe('list_only');
  expect(objectScope({policy:{...policy,newObjects:'ignore'},knownObjects:new Set()},'public.audit_daily','table')).toBe('exclude');
});

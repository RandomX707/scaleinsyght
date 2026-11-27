import type { ConnectorScope, ScopeMode } from './index.js';

export type NameScopeRule = {pattern:string;mode:ScopeMode;reason:string};
export type ColumnScopeRule = {qualifiedName:string;mode:'mask'|'exclude'};
export type ControlsPolicy = {
  groups: Record<string, ScopeMode>;
  nameRules: NameScopeRule[];
  columnRules: ColumnScopeRule[];
  newObjects: 'approve'|'rules'|'ignore';
  leavingScope: 'keep';
  approval: boolean;
};

function matches(pattern: string, name: string): boolean {
  const expression=pattern.split('*').map(part=>part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*');
  return new RegExp(`^${expression}$`,'i').test(name);
}

/** Apply exact overrides first, then the first matching name rule, then the group default. */
export function objectScope(scope: ConnectorScope | undefined, name: string, type: string): ScopeMode {
  if (scope?.exclude?.includes(name)) return 'exclude';
  if (scope?.listOnly?.includes(name)) return 'list_only';
  if (scope?.profile?.includes(name)) return 'profile';
  if (!scope?.policy) return scope?.profile?.length ? 'exclude' : 'profile';
  const {policy,knownObjects}=scope;
  const rule=policy.nameRules.find(entry=>matches(entry.pattern,name));
  if (knownObjects && !knownObjects.has(name)) {
    // "Ignore until added by hand": recorded as found (list only), nothing else, unless a name rule excludes it.
    if (policy.newObjects==='ignore') return rule?.mode==='exclude'?'exclude':'list_only';
    if (policy.newObjects==='approve') return rule?.mode==='exclude'?'exclude':'list_only';
    return rule?.mode??'list_only';
  }
  return rule?.mode??policy.groups[type]??'profile';
}

export function columnScope(scope: ConnectorScope | undefined, table: string, column: string) {
  return scope?.policy?.columnRules.find(rule=>rule.qualifiedName===`${table}.${column}`)?.mode;
}

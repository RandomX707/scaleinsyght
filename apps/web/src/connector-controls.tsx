import React, { useEffect, useState } from 'react';
import { Badge, Button, ChoiceSegments, EmptyState, Input, Select, Table } from '@scaleinsyght/ui';
import './connector-controls.css';

type Request = <T>(url:string,init?:RequestInit)=>Promise<T>;
type Mode = 'profile'|'list_only'|'exclude';
type Rule = {qualifiedName:string;objectType:string;scopeMode:Mode};
type Policy = {
  groups:Record<string,Mode>;
  nameRules:Array<{pattern:string;mode:Mode;reason:string}>;
  columnRules:Array<{qualifiedName:string;mode:'mask'|'exclude'}>;
  newObjects:'approve'|'rules'|'ignore';
  leavingScope:'keep';
  approval:boolean;
};
type Controls = {revision:number;policy:Policy;overrides:Rule[];nightlyEstimateMs:number|null;objects:Array<{name:string;type:string;mode:Mode;inaccessible:boolean}>};
const labels:Record<Mode,string>={profile:'Profile and query',list_only:'List only',exclude:'Exclude'};
const modeOptions=Object.entries(labels).map(([key,label])=><option key={key} value={key}>{label}</option>);
const json={ 'content-type':'application/json' };
const groupLabel=(type:string)=>({table:'Tables',view:'Views',procedure:'Stored procedures',function:'Functions'}[type]??type);

const MODES: Array<{ id: Mode; label: string; tone: 'good' | 'primary' | 'bad'; title: string }> = [
  { id: 'profile', label: 'Profile and query', tone: 'good', title: 'Profiled every night and usable in answers' },
  { id: 'list_only', label: 'List only', tone: 'primary', title: 'Names and types shown in the catalog; never sampled or queried' },
  { id: 'exclude', label: 'Exclude', tone: 'bad', title: 'Hidden from the catalog and answers; the name is kept only for the record' },
];
const lower = (mode: Mode) => labels[mode].toLowerCase();
function estimate(ms: number | null): string {
  if (ms === null) return 'Not measured yet';
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) return `~${seconds} s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `~${minutes} min` : `~${Math.round(minutes / 6) / 10} h`;
}

/** The unsaved changes, in words, as the sticky bar lists them (prototype scChanges). */
export function describeChanges(baseline: Controls, draft: Controls): string[] {
  const out: string[] = [];
  for (const [type, mode] of Object.entries(draft.policy.groups)) {
    const before = baseline.policy.groups[type] ?? 'profile';
    if (before !== mode) out.push(`${groupLabel(type)}: ${lower(before)} → ${lower(mode)}`);
  }
  const was = new Map(baseline.overrides.map((rule) => [rule.qualifiedName, rule.scopeMode]));
  const now = new Map(draft.overrides.map((rule) => [rule.qualifiedName, rule.scopeMode]));
  const changed = [...new Set([...was.keys(), ...now.keys()])].filter((name) => was.get(name) !== now.get(name)).sort();
  if (changed.length) out.push(`${changed.length} single-object ${changed.length === 1 ? 'override' : 'overrides'} (${changed.map((name) => `${name}: ${now.has(name) ? lower(now.get(name)!) : 'back to group'}`).join(', ')})`);
  if (JSON.stringify(baseline.policy.nameRules) !== JSON.stringify(draft.policy.nameRules)) out.push(`name rules changed (${draft.policy.nameRules.length} now)`);
  if (JSON.stringify(baseline.policy.columnRules) !== JSON.stringify(draft.policy.columnRules)) out.push(`column rules changed (${draft.policy.columnRules.length} now)`);
  if (baseline.policy.newObjects !== draft.policy.newObjects || baseline.policy.approval !== draft.policy.approval) out.push('change handling updated');
  return out;
}

export function ConnectorControls({connectionId,request}:{connectionId:string;request:Request}) {
  const [baseline,setBaseline]=useState<Controls|null>(null);
  const [draft,setDraft]=useState<Controls|null>(null);
  const [open,setOpen]=useState<Record<string,boolean>>({});
  const [status,setStatus]=useState('');
  const [error,setError]=useState('');
  const [saving,setSaving]=useState(false);
  const route=`/api/connections/${encodeURIComponent(connectionId)}/controls`;
  useEffect(()=>{
    let active=true;
    void request<Controls>(route).then(value=>{
      if(active){setBaseline(value);setDraft(value);}
    }).catch(()=>{if(active)setError('Could not load connector controls.');});
    return ()=>{active=false;};
  },[request,route]);
  const update=(patch:Partial<Policy>)=>setDraft(current=>current&&({...current,policy:{...current.policy,...patch}}));
  if(!draft||!baseline)return error?<p role="alert">{error}</p>:<p role="status">Loading connector controls…</p>;
  const policy=draft.policy;
  const groupTypes=[...new Set(draft.objects.map(object=>object.type))];
  const groups=groupTypes.map(type=>({type,objects:draft.objects.filter(object=>object.type===type)}));
  const changes=describeChanges(baseline,draft);
  const needsApproval=baseline.policy.approval||policy.approval;
  const count=(mode:Mode)=>baseline.objects.filter(item=>item.mode===mode).length;
  function setObject(object:Controls['objects'][number],mode:string){
    const rest=draft!.overrides.filter(rule=>rule.qualifiedName!==object.name);
    setDraft({...draft!,overrides:mode===''?rest:[...rest,{qualifiedName:object.name,objectType:object.type,scopeMode:mode as Mode}]});
  }
  async function save(){
    setSaving(true);setError('');setStatus('');
    try {
      const result=await request<{status:string}>(route,{method:'PUT',headers:json,body:JSON.stringify({revision:draft!.revision,policy,overrides:draft!.overrides})});
      if(result.status==='pending'){
        setDraft(baseline);
        setStatus('Sent to the Approval matrix. It applies from the next refresh once approved.');
      }else{
        const updated=await request<Controls>(route);
        setBaseline(updated);setDraft(updated);setStatus('Controls saved. They apply from the next refresh.');
      }
    }catch(reason){setError(reason instanceof Error?reason.message:'Could not save controls.');}
    finally{setSaving(false);}
  }
  const radio=(name:string,checked:boolean,onChange:()=>void,title:string,detail:string)=><label className="control-radio">
    <Input type="radio" name={name} checked={checked} onChange={onChange}/><span><b>{title}</b><span>{detail}</span></span></label>;
  return <div className="connector-controls">
    <div className="control-totals" aria-label="Current approved scope">
      <article><strong>{count('profile').toLocaleString('en-US')}</strong><span>objects profiled and queryable</span></article>
      <article><strong>{count('list_only').toLocaleString('en-US')}</strong><span>listed only</span></article>
      <article><strong>{count('exclude').toLocaleString('en-US')}</strong><span>excluded</span></article>
      <article><strong>{estimate(baseline.nightlyEstimateMs)}</strong><span>nightly profile time, changed tables only</span></article>
    </div>
    <p className="control-boundary"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z"/></svg>
      <span>The connector’s read-only login is the real access boundary. These controls can only narrow it, never widen it: anything the login cannot see stays out whatever you choose here.</span></p>
    {changes.length>0&&<div className="control-diff" role="region" aria-label="Unsaved changes"><div><strong>{changes.length} unsaved {changes.length===1?'change':'changes'}</strong><p>{changes.join(' · ')}</p></div><div className="control-actions">
      <Button size="small" disabled={saving} onClick={()=>{setDraft(baseline);setError('');setStatus('Changes discarded.');}}>Discard</Button>
      <Button size="small" disabled={saving} variant="primary" onClick={()=>void save()}>{needsApproval?'Send for approval':'Save controls'}</Button>
    </div></div>}
    {status&&<p role="status">{status}</p>}{error&&<p role="alert">{error}</p>}
    <article className="control-card"><div className="control-card-head"><h2>What to include</h2><span>Open a group to set single objects</span></div>
      <div className="control-legend">{MODES.map(mode=><span key={mode.id}><b>{mode.label}:</b> {mode.title.charAt(0).toLowerCase()+mode.title.slice(1)}</span>)}</div>
      {groups.length===0&&<EmptyState title="No objects listed yet" description="Refresh this connector to list its objects."/>}
      {groups.map(({type,objects})=>{
        const mode=policy.groups[type]??'profile';const changed=mode!==(baseline.policy.groups[type]??'profile');const isOpen=Boolean(open[type]);
        return <div className={`control-group${changed?' is-changed':''}`} key={type}>
          <div className="control-row">
            <Button variant="ghost" className="control-toggle" aria-expanded={isOpen} onClick={()=>setOpen({...open,[type]:!isOpen})}>
              <span aria-hidden="true" className="control-chevron">{isOpen?'▾':'▸'}</span><span><b>{groupLabel(type)}</b> <span className="control-count">{objects.length.toLocaleString('en-US')}</span></span>
            </Button>
            <ChoiceSegments label={`Scope for ${groupLabel(type)}`} value={mode} options={MODES} onChange={value=>update({groups:{...policy.groups,[type]:value}})}/>
          </div>
          {isOpen&&<div className="control-items">{objects.map(item=>{
            const override=draft.overrides.find(rule=>rule.qualifiedName===item.name)?.scopeMode;
            return <div className="control-item" key={item.name}><code>{item.name}</code>
              {item.inaccessible?<span className="control-muted">Not visible to the login</span>:<Select aria-label={`Override for ${item.name}`} value={override??''} onChange={event=>setObject(item,event.target.value)}>
                <option value="">Same as group</option>{modeOptions}</Select>}
              {override&&<Badge tone="warn">override</Badge>}<span className="control-muted">now {lower(item.mode)}</span></div>;
          })}</div>}
        </div>;
      })}
    </article>
    <article className="control-card"><div className="control-card-head"><h2>Name rules</h2><span>Checked in order; first match wins</span></div>
      <p>Rules decide what happens to objects by name, including ones that appear in future runs. Use * as a wildcard.</p>
      {policy.nameRules.length?<Table caption="Name rules, in order" headers={['Pattern','Then','Why','']} rows={policy.nameRules.map((rule,index)=>[
        <code key="pattern">{rule.pattern}</code>,<Badge key="mode" tone={rule.mode==='exclude'?'bad':rule.mode==='list_only'?'muted':'good'}>{labels[rule.mode]}</Badge>,rule.reason||'—',
        <div className="control-actions" key="actions">{index>0&&<Button size="small" onClick={()=>{
          const reordered=[...policy.nameRules];[reordered[index-1],reordered[index]]=[reordered[index]!,reordered[index-1]!];update({nameRules:reordered});
        }}>Move up</Button>}<Button size="small" aria-label={`Remove rule ${rule.pattern}`} onClick={()=>update({nameRules:policy.nameRules.filter((_,position)=>position!==index)})}>Remove</Button></div>,
      ])}/>:<p className="control-muted">No rules yet.</p>}
      <form className="control-rule-form" onSubmit={event=>{
        event.preventDefault();const form=event.currentTarget;const value=new FormData(form);const pattern=String(value.get('pattern')).trim();
        if(!pattern){setError('Type a name pattern, for example *_backup.');return;}
        update({nameRules:[...policy.nameRules,{pattern,mode:value.get('mode') as Mode,reason:String(value.get('reason')).trim()}]});
        form.reset();
      }}><Input name="pattern" aria-label="Pattern" placeholder="Pattern, e.g. *_backup"/><Select name="mode" aria-label="Then" defaultValue="exclude">{modeOptions}</Select><Input name="reason" aria-label="Reason" placeholder="Why (optional)"/><Button size="small" type="submit">Add rule</Button></form>
    </article>
    <article className="control-card"><div className="control-card-head"><h2>Columns</h2><span>{policy.columnRules.length} {policy.columnRules.length===1?'rule':'rules'}</span></div>
      <p>Hide or mask single columns without dropping the whole table. Masked columns keep their name and type for joins, but their values are never sampled or sent to the AI model.</p>
      {policy.columnRules.length>0&&<Table caption="Column rules" headers={['Column','Treatment','']} rows={policy.columnRules.map((rule,index)=>[
        <code key="name">{rule.qualifiedName}</code>,
        <Select key="mode" aria-label={`Treatment for ${rule.qualifiedName}`} value={rule.mode} onChange={event=>update({columnRules:policy.columnRules.map((item,position)=>position===index?{...item,mode:event.target.value as 'mask'|'exclude'}:item)})}>
          <option value="mask">Mask values</option><option value="exclude">Exclude the column</option></Select>,
        <span key="effect" className="control-muted">{rule.mode==='exclude'?'Not recorded or queryable':'Types only; usable as a join key'} <Button size="small" aria-label={`Remove column rule ${rule.qualifiedName}`} onClick={()=>update({columnRules:policy.columnRules.filter((_,position)=>position!==index)})}>Remove</Button></span>,
      ])}/>}
      <form className="control-rule-form" onSubmit={event=>{
        event.preventDefault();const form=event.currentTarget;const value=new FormData(form);const qualifiedName=String(value.get('column')).trim();
        if(!/^[\w$]+(\.[\w$]+){1,3}$/.test(qualifiedName)){setError('Use table.column, for example public.patients.phone.');return;}
        update({columnRules:[...policy.columnRules.filter(rule=>rule.qualifiedName!==qualifiedName),{qualifiedName,mode:value.get('treatment') as 'mask'|'exclude'}]});
        form.reset();
      }}><Input name="column" aria-label="Column" placeholder="table.column, e.g. public.patients.phone"/><Select name="treatment" aria-label="Treatment"><option value="mask">Mask values</option><option value="exclude">Exclude</option></Select><Button size="small" type="submit">Add column rule</Button></form>
    </article>
    <article className="control-card"><h2>When things change</h2>
      <div className="control-columns">
        <div><h3>New objects found in a nightly run</h3>
          {radio('new-objects',policy.newObjects==='approve',()=>update({newObjects:'approve'}),'Send to the Approval matrix','Recommended. Name rules suggest the setting; a person confirms')}
          {radio('new-objects',policy.newObjects==='rules',()=>update({newObjects:'rules'}),'Apply name rules automatically','No match: listed only until someone decides')}
          {radio('new-objects',policy.newObjects==='ignore',()=>update({newObjects:'ignore'}),'Ignore until added by hand','Recorded as found, nothing else')}
        </div>
        <div><h3>When something leaves scope</h3>
          {radio('leaving-scope',true,()=>undefined,'Keep its history, marked out of scope','Old profiles and lineage stay readable for audits')}
          <p className="control-muted">Deleting history is not offered: assets and assertions are never deleted, only marked out of scope.</p>
        </div>
      </div>
      <label className="control-radio"><Input type="checkbox" checked={policy.approval} onChange={event=>update({approval:event.target.checked})}/><span><b>Changes need approval</b><span>Saving creates an item in the Approval matrix instead of applying straight away</span></span></label>
    </article>
  </div>;
}

type Change = {changeId:string;connectionName:string;status:string;proposedAt:string;newObjects:string[];overrides:Rule[];policy:Policy};

export function ControlChanges({request}:{request:Request}) {
  const [changes,setChanges]=useState<Change[]>([]);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState('');
  const reload=()=>request<{changes:Change[]}>('/api/control-changes').then(result=>setChanges(result.changes));
  useEffect(()=>{void request<{changes:Change[]}>('/api/control-changes').then(result=>setChanges(result.changes)).catch(()=>setError('Could not load Controls changes.'));},[request]);
  async function decide(changeId:string,decision:'approved'|'rejected'){
    setBusy(changeId);setError('');
    try{await request(`/api/control-changes/${changeId}/decision`,{method:'POST',headers:json,body:JSON.stringify({decision})});await reload();}
    catch(reason){setError(reason instanceof Error?reason.message:'Could not review Controls changes.');}
    finally{setBusy('');}
  }
  return <article><h2>Controls changes</h2>{error&&<p role="alert">{error}</p>}
    {!changes.length?<p>No changes submitted.</p>:changes.map(change=><section key={change.changeId} className="control-group">
      <h3>{change.connectionName} · scope changes</h3><Badge tone={change.status==='pending'?'warn':'muted'}>{change.status}</Badge>
      <details><summary>Review proposed settings</summary><ul>
        {change.newObjects.map(name=><li key={`new-${name}`}>New object · {name}</li>)}
        {change.overrides.map(rule=><li key={rule.qualifiedName}>{rule.qualifiedName} · {labels[rule.scopeMode]}</li>)}
        {Object.entries(change.policy.groups).map(([type,mode])=><li key={type}>{groupLabel(type)} · {labels[mode]}</li>)}
        {change.policy.nameRules.map((rule,index)=><li key={`rule-${index}`}>Name rule {index+1} · {rule.pattern} · {labels[rule.mode]}</li>)}
        {change.policy.columnRules.map(rule=><li key={rule.qualifiedName}>{rule.qualifiedName} · {rule.mode==='mask'?'Mask values':'Exclude column'}</li>)}
        <li>New objects · {change.policy.newObjects==='approve'?'Send for approval':change.policy.newObjects==='rules'?'Apply name rules':'Ignore'}</li>
        <li>Changes need approval · {change.policy.approval?'On':'Off'}</li>
      </ul></details>
      {change.status==='pending'&&<div className="actions"><Button disabled={Boolean(busy)} onClick={()=>void decide(change.changeId,'approved')}>Approve controls</Button><Button disabled={Boolean(busy)} onClick={()=>void decide(change.changeId,'rejected')}>Reject controls</Button></div>}
    </section>)}
  </article>;
}

import React, { useEffect, useState } from 'react';
import { Badge, Button, EmptyState, Input, Select, Table } from '@scaleinsyght/ui';
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

export function ConnectorControls({connectionId,request}:{connectionId:string;request:Request}) {
  const [baseline,setBaseline]=useState<Controls|null>(null);
  const [draft,setDraft]=useState<Controls|null>(null);
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
  const differences=[
    ...Object.keys(policy).filter(key=>JSON.stringify(policy[key as keyof Policy])!==JSON.stringify(baseline.policy[key as keyof Policy]))
      .map(key=>({groups:'Group access',nameRules:'Name rules',columnRules:'Column rules',newObjects:'New objects',approval:'Approval',leavingScope:'History'}[key]??key)),
    ...(JSON.stringify(draft.overrides)!==JSON.stringify(baseline.overrides)?['Object overrides']:[]),
  ];
  const needsApproval=baseline.policy.approval||policy.approval;
  function setObject(object:Controls['objects'][number],mode:string){
    const rest=draft!.overrides.filter(rule=>rule.qualifiedName!==object.name);
    setDraft({...draft!,overrides:mode==='inherit'?rest:[...rest,{qualifiedName:object.name,objectType:object.type,scopeMode:mode as Mode}]});
  }
  async function save(){
    setSaving(true);setError('');setStatus('');
    try {
      const result=await request<{status:string}>(route,{method:'PUT',headers:json,body:JSON.stringify({revision:draft!.revision,policy,overrides:draft!.overrides})});
      if(result.status==='pending'){
        setDraft(baseline);
        setStatus('Sent to the Approval matrix. Current controls stay in effect until approved.');
      }else{
        const updated=await request<Controls>(route);
        setBaseline(updated);setDraft(updated);setStatus('Controls saved.');
      }
    }catch(reason){setError(reason instanceof Error?reason.message:'Could not save controls.');}
    finally{setSaving(false);}
  }
  return <div className="connector-controls">
    <div className="control-totals" aria-label="Current approved scope">
      {(['profile','list_only','exclude'] as const).map(mode=><article key={mode}><strong>{baseline.objects.filter(item=>item.mode===mode).length.toLocaleString()}</strong><span>{mode==='profile'?'Profiled and queryable':mode==='exclude'?'Excluded':'Listed only'}</span></article>)}
      <article><strong>{baseline.nightlyEstimateMs===null?'Unavailable':`${Math.max(1,Math.round(baseline.nightlyEstimateMs/1000))} s`}</strong><span>Estimated nightly time</span></article>
    </div>
    <p className="control-boundary">The connector’s read-only login is the access boundary. These controls can only narrow that access.</p>
    {differences.length>0&&<div className="control-diff"><div><strong>{differences.length} unsaved {differences.length===1?'change':'changes'}</strong><p>{differences.join(' · ')}</p></div><div className="actions">
      <Button disabled={saving} onClick={()=>{setDraft(baseline);setError('');}}>Discard</Button>
      <Button disabled={saving} variant="primary" onClick={()=>void save()}>{needsApproval?'Send for approval':'Save controls'}</Button>
    </div></div>}
    {status&&<p role="status">{status}</p>}{error&&<p role="alert">{error}</p>}
    <article><h2>What to include</h2><p>Open a group to override access for individual objects.</p>
      {groups.length===0&&<EmptyState title="No objects listed yet" description="Refresh this connector to list its objects."/>}
      {groups.map(({type,objects})=><div className="control-group" key={type}>
        <label>{groupLabel(type)} access<Select value={policy.groups[type]??'profile'} onChange={event=>update({groups:{...policy.groups,[type]:event.target.value as Mode}})}>{modeOptions}</Select></label>
        <details><summary>{groupLabel(type)} · {objects.length.toLocaleString()} objects</summary>
          <Table caption={groupLabel(type)} headers={['Object','Approved access','Override']} rows={objects.map(item=>[
            <code key="name">{item.name}</code>,item.inaccessible?'Unavailable to the login':labels[item.mode],
            <Select key="override" aria-label={`Scope for ${item.name}`} disabled={item.inaccessible} value={draft.overrides.find(rule=>rule.qualifiedName===item.name)?.scopeMode??'inherit'} onChange={event=>setObject(item,event.target.value)}><option value="inherit">Use rules and group</option>{modeOptions}</Select>,
          ])}/>
        </details>
      </div>)}
    </article>
    <article><h2>Name rules</h2><p>Checked in order. The first matching rule wins. Use * as a wildcard.</p>
      {policy.nameRules.length>0&&<Table caption="Ordered name rules" headers={['Pattern','Then','Why','Actions']} rows={policy.nameRules.map((rule,index)=>[
        rule.pattern,labels[rule.mode],rule.reason,
        <div className="actions" key="actions"><Button size="small" disabled={index===0} onClick={()=>{
          const reordered=[...policy.nameRules];[reordered[index-1],reordered[index]]=[reordered[index]!,reordered[index-1]!];update({nameRules:reordered});
        }}>Move up</Button><Button size="small" onClick={()=>update({nameRules:policy.nameRules.filter((_,position)=>position!==index)})}>Remove</Button></div>,
      ])}/>}
      <form className="control-rule-form" onSubmit={event=>{
        event.preventDefault();const form=event.currentTarget;const value=new FormData(form);const pattern=String(value.get('pattern')).trim();
        if(pattern)update({nameRules:[...policy.nameRules,{pattern,mode:value.get('mode') as Mode,reason:String(value.get('reason')).trim()}]});
        form.reset();
      }}><label>Pattern<Input name="pattern" required placeholder="public.*_backup"/></label><label>Then<Select name="mode" defaultValue="exclude">{modeOptions}</Select></label><label>Why<Input name="reason"/></label><Button type="submit">Add name rule</Button></form>
    </article>
    <article><h2>Column rules</h2><p>Mask values or exclude a column entirely.</p>
      {policy.columnRules.length>0&&<Table caption="Column rules" headers={['Column','Treatment','']} rows={policy.columnRules.map(rule=>[
        rule.qualifiedName,rule.mode==='mask'?'Mask values':'Exclude',
        <Button key="remove" size="small" onClick={()=>update({columnRules:policy.columnRules.filter(item=>item.qualifiedName!==rule.qualifiedName)})}>Remove</Button>,
      ])}/>}
      <form className="control-rule-form" onSubmit={event=>{
        event.preventDefault();const form=event.currentTarget;const value=new FormData(form);const qualifiedName=String(value.get('column')).trim();
        if(qualifiedName)update({columnRules:[...policy.columnRules.filter(rule=>rule.qualifiedName!==qualifiedName),{qualifiedName,mode:value.get('treatment') as 'mask'|'exclude'}]});
        form.reset();
      }}><label>Column<Input name="column" required placeholder="public.patients.phone"/></label><label>Treatment<Select name="treatment"><option value="mask">Mask values</option><option value="exclude">Exclude</option></Select></label><Button type="submit">Add column rule</Button></form>
    </article>
    <article><h2>When things change</h2>
      <label>New objects<Select value={policy.newObjects} onChange={event=>update({newObjects:event.target.value as Policy['newObjects']})}><option value="approve">Send to the Approval matrix</option><option value="rules">Apply name rules automatically</option><option value="ignore">Ignore until added by hand</option></Select></label>
      <p><b>When something leaves scope</b><br/>Keep its history, marked out of scope.</p>
      <label className="checkbox-label"><Input type="checkbox" checked={policy.approval} onChange={event=>update({approval:event.target.checked})}/>Changes need approval</label>
      <p>With approval on, saving creates an Approval matrix item.</p>
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

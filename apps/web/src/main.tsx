import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import './phase1.css';

type Usage = { active_users: number; active_connectors: { by_type: Record<string, number> } };
type NavGroups = { workspace: boolean; platform: boolean };
type Connection = { connectionId: string; connectorType: string; status: string; agentId: string | null; lastJobState: string | null };
type Source = { id: string; type: string; name: string };
type Notification = { notificationId: string; type: string; summary: Record<string, unknown>; readAt: string | null };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (response.status === 401) throw new Error('unauthorized');
  if (!response.ok) {
    const result = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(result.error ?? `request_failed_${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError('');
    try {
      await api('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
      location.assign('/');
    } catch { setError('Email or password is incorrect.'); }
  }
  return <main className="login"><form onSubmit={submit}><div className="brandmark">S</div><h1>Welcome to Scale Insyght</h1><p>Sign in to your workspace</p><label>Email<input autoComplete="username" type="email" required value={email} onChange={event => setEmail(event.target.value)} /></label><label>Password<input autoComplete="current-password" type="password" required value={password} onChange={event => setPassword(event.target.value)} /></label>{error && <p role="alert" className="error">{error}</p>}<button type="submit">Sign in</button><p className="muted">Single sign-on will be available in a later release.</p></form></main>;
}

function loadGroups(): NavGroups {
  try { return { workspace: localStorage.getItem('nav-workspace') !== 'false', platform: localStorage.getItem('nav-platform') !== 'false' }; }
  catch { return { workspace: true, platform: true }; }
}

function ConnectorsPage(props: { connections: Connection[]; reload: () => Promise<void>; navigate: (path: string) => void }) {
  const [sources, setSources] = useState<Source[]>([]);
  const [sourceId, setSourceId] = useState('');
  const [connectionId, setConnectionId] = useState('');
  const [stage, setStage] = useState<'closed' | 'choose' | 'scope' | 'complete'>('closed');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { void api<{ sources: Source[] }>('/api/sources').then(result => setSources(result.sources)); }, []);

  async function createDraft() {
    setError(''); setMessage('');
    try {
      const created = await api<{ connectionId: string }>('/api/connections', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceId }) });
      await api(`/api/connections/${created.connectionId}/test`, { method: 'POST' });
      setConnectionId(created.connectionId); setStage('scope');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Connection test failed.'); }
  }

  async function activate() {
    setError('');
    try {
      const result = await api<{ profile: { profiled: number; listed: number; inaccessible: number } }>(`/api/connections/${connectionId}/activate`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: [] }),
      });
      setMessage(`Connector agent created. Profile complete: ${result.profile.profiled} objects profiled from ${result.profile.listed} listed; ${result.profile.inaccessible} inaccessible.`);
      setStage('complete'); await props.reload();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Activation failed.'); }
  }

  return <section><div className="page-heading"><div><h1>Connectors</h1><p>Read-only sources and their connector agents.</p></div><button onClick={() => { setStage('choose'); setError(''); setMessage(''); }}>Add connector</button></div>
    {props.connections.length === 0 ? <p>No sources connected.</p> : <div className="cards">{props.connections.filter(connection => connection.status === 'active').map(connection => <article key={connection.connectionId}><span>{connection.connectorType.replaceAll('_', ' ')}</span><strong>{connection.agentId ? 'Connector agent active' : 'Connection active'}</strong><p>Last profile: {connection.lastJobState ?? 'Not started'}</p><button onClick={() => props.navigate(`/profile/${connection.connectionId}`)}>View profile</button><button onClick={() => props.navigate(`/dictionary?connection=${connection.connectionId}`)}>Open Dictionary</button><button onClick={() => props.navigate(`/er?connection=${connection.connectionId}`)}>Show ER diagram</button></article>)}</div>}
    {stage === 'choose' && <div className="modal" role="dialog" aria-modal="true" aria-labelledby="add-source-title"><div className="modal-card"><h2 id="add-source-title">Add a connector</h2><label>Source<select aria-label="Source" value={sourceId} onChange={event => setSourceId(event.target.value)}><option value="">Choose a synthetic source</option>{sources.map(source => <option key={source.id} value={source.id}>{source.name} ({source.type.replaceAll('_', ' ')})</option>)}</select></label><p>Only the synthetic golden dataset is available in this local demo.</p><div className="actions"><button onClick={() => setStage('closed')}>Cancel</button><button disabled={!sourceId} onClick={() => void createDraft()}>Test connection</button></div>{error && <p role="alert" className="error">{error}</p>}</div></div>}
    {stage === 'scope' && <div className="modal" role="dialog" aria-modal="true" aria-labelledby="scope-title"><div className="modal-card"><h2 id="scope-title">Choose scope</h2><p>Profile all discovered objects. Out-of-scope objects are never profiled, sampled, fingerprinted or queried.</p><label><input type="checkbox" defaultChecked /> Profile objects in the selected synthetic source</label><div className="actions"><button onClick={() => setStage('closed')}>Cancel</button><button onClick={() => void activate()}>Start profiling</button></div>{error && <p role="alert" className="error">{error}</p>}</div></div>}
    {stage === 'complete' && <div className="modal" role="dialog" aria-modal="true" aria-labelledby="complete-title"><div className="modal-card"><h2 id="complete-title">Discovery complete</h2><p role="status">{message}</p><div className="actions"><button onClick={() => setStage('closed')}>Close</button></div></div></div>}
  </section>;
}

function ProfilePage(props: { connectionId: string; navigate: (path: string) => void }) {
  const [profile, setProfile] = useState<Record<string, unknown> | null>(null);
  useEffect(() => { void api<{ profile: Record<string, unknown> | null }>(`/api/connections/${props.connectionId}/profile`).then(result => setProfile(result.profile)); }, [props.connectionId]);
  return <section><h1>Profile</h1>{profile ? <><p>Profiling complete</p><div className="cards"><article><span>Objects listed</span><strong>{String(profile.listed_count)}</strong></article><article><span>Tables profiled</span><strong>{String(profile.dataset_count)}</strong></article><article><span>Fields profiled</span><strong>{String(profile.field_count)}</strong></article><article><span>Inaccessible</span><strong>{String(profile.inaccessible_count)}</strong></article></div><div className="actions"><button onClick={() => props.navigate(`/dictionary?connection=${props.connectionId}`)}>Open Dictionary</button><button onClick={() => props.navigate(`/er?connection=${props.connectionId}`)}>Show ER diagram</button></div></> : <p>Profile is not available yet.</p>}</section>;
}

function DictionaryPage(props: { connectionId: string }) {
  const [tables, setTables] = useState<Array<{ asset_id: string; qualified_name: string; fields: Array<{ name: string; dataType: string; nullable: boolean; tags: string[] }> }>>([]);
  useEffect(() => { void api<{ tables: typeof tables }>(`/api/connections/${props.connectionId}/dictionary`).then(result => setTables(result.tables)); }, [props.connectionId]);
  return <section><h1>Dictionary</h1><p>Structural and statistical metadata only. No source rows are stored.</p><div className="dictionary-list">{tables.map(table => <details key={table.asset_id}><summary>{table.qualified_name}</summary><ul>{table.fields.map(field => <li key={field.name}><strong>{field.name.split('.').at(-1)}</strong> · {field.dataType}{field.nullable ? ' · nullable' : ''}{field.tags.length ? ` · ${field.tags.join(', ')}` : ''}</li>)}</ul></details>)}</div></section>;
}

function ControlsPage(props: { connectionId: string }) {
  const [scope, setScope] = useState<Array<{ qualifiedName: string; objectType: string; scopeMode: 'profile' | 'list_only' | 'exclude' }>>([]);
  const [saved, setSaved] = useState(false);
  useEffect(() => { void api<{ scope: typeof scope }>(`/api/connections/${props.connectionId}/scope`).then(result => setScope(result.scope)); }, [props.connectionId]);
  async function save() { await api(`/api/connections/${props.connectionId}/scope`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rules: scope }) }); setSaved(true); }
  return <section><h1>Controls</h1><p>Scope changes control which objects the next profile can inspect.</p><ul>{scope.map(rule => <li key={rule.qualifiedName}>{rule.qualifiedName} · {rule.scopeMode}</li>)}</ul><button onClick={() => void save()}>Save scope</button>{saved && <p role="status">Scope saved.</p>}</section>;
}

function CatalogueQuestion() {
  const [question, setQuestion] = useState('');
  const [matches, setMatches] = useState<string[]>([]);
  const [error, setError] = useState('');
  async function search(event: React.FormEvent) {
    event.preventDefault(); setError('');
    try {
      const result = await api<{ matches: string[] }>(`/api/catalogue/search?q=${encodeURIComponent(question)}`);
      setMatches(result.matches);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Search failed.'); }
  }
  return <div className="catalogue-question"><h2>Ask about your catalog</h2><p>Searches stored structural metadata without a model call.</p><form onSubmit={event => void search(event)}><label>Catalog question<input value={question} onChange={event => setQuestion(event.target.value)} placeholder="For example: which tables contain orders?" required /></label><button type="submit">Search catalog</button></form>{error && <p role="alert" className="error">{error}</p>}{matches.length > 0 && <ul aria-label="Catalog matches">{matches.map(match => <li key={match}>{match}</li>)}</ul>}{question && matches.length === 0 && <p role="status">No matching catalog objects.</p>}</div>;
}

type AnalyticRun = { runId: string; state: string; stateVersion:number; plan: { question: string; steps: Array<{ source_id: string; agent_id: string }> }; answer: { answer: { claims?: Array<{ statement: string; evidence_ids: string[] }>; evidence?: Array<{ evidence_id: string; locator: string; redacted_summary: string }>; bySource?: Array<{ value: number; sourceId?: string }> }; presentation: { title: string; layout: string } } | null };

function AnalyticWorkspace(props: { connections: Connection[]; navigate: (path: string) => void; runId?:string|undefined }) {
  const [question,setQuestion]=useState('');const [selected,setSelected]=useState<string[]>([]);const [authorized,setAuthorized]=useState<string[]>([]);const [run,setRun]=useState<AnalyticRun|null>(null);const [events,setEvents]=useState<Array<{sequence:number;event_type:string}>>([]);const [error,setError]=useState('');const [feedback,setFeedback]=useState('');
  const active=props.connections.filter(item=>item.status==='active'&&authorized.includes(item.connectionId));
  useEffect(()=>{void api<{sources:Array<{id:string}>}>('/api/analytic/sources').then(result=>{const ids=result.sources.map(item=>item.id);setAuthorized(ids);setSelected(ids);}).catch(()=>setError('Authorized sources could not be loaded.'));},[]);
  useEffect(()=>{if(props.runId)void api<AnalyticRun>(`/api/runs/${props.runId}`).then(setRun).catch(()=>setError('Saved run could not be loaded.'));},[props.runId]);
  useEffect(()=>{if(!run)return;const after=events.at(-1)?.sequence??0;void api<{events:Array<{sequence:number;event_type:string}>}>(`/api/runs/${run.runId}/events?after=${after}`).then(result=>{if(result.events.length)setEvents(previous=>[...previous,...result.events]);}).catch(()=>setError('Run events could not be resumed.'));},[run?.runId,run?.stateVersion]);
  useEffect(()=>{if(run&&!['COMPLETED','PARTIAL','FAILED','CANCELLED','POLICY_BLOCKED'].includes(run.state)){const timer=setTimeout(()=>{void api<AnalyticRun>(`/api/runs/${run.runId}`).then(setRun).catch(()=>setError('Run status could not be refreshed.'));},600);return()=>clearTimeout(timer);}},[run]);
  async function ask(event:React.FormEvent){event.preventDefault();setError('');setFeedback('');try{const result=await api<{runId:string}>('/api/runs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({question,sourceIds:selected})});props.navigate(`/runs/${result.runId}`);const detail=await api<AnalyticRun>(`/api/runs/${result.runId}`);setRun(detail);setEvents([]);}catch(reason){setError(reason instanceof Error?reason.message:'Question could not be started.');}}
  async function rate(verdict:'useful'|'not_useful'){if(!run)return;try{await api(`/api/runs/${run.runId}/feedback`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({verdict})});setFeedback('Feedback saved to your personal agent.');}catch(reason){setError(reason instanceof Error?reason.message:'Feedback could not be saved.');}}
  return <section className="analytic-workspace"><div className="page-heading"><div><h1>What would you like to understand?</h1><p>Ask across your authorized synthetic sources. Analytic mode is read-only.</p></div><button onClick={()=>props.navigate('/agents')}>Agents</button></div>{!props.runId&&<form onSubmit={event=>void ask(event)}><label>Your question<textarea required value={question} onChange={event=>setQuestion(event.target.value)} placeholder="Compare the synthetic source totals" /></label><fieldset><legend>Sources</legend>{active.map(item=><label key={item.connectionId}><input type="checkbox" checked={selected.includes(item.connectionId)} onChange={event=>setSelected(old=>event.target.checked?[...old,item.connectionId]:old.filter(id=>id!==item.connectionId))}/>{item.connectorType.replaceAll('_',' ')}</label>)}</fieldset><button type="submit" disabled={!selected.length}>Ask question</button></form>}{active.length===0&&!props.runId&&<p>Connect a synthetic source to start an analytic run.</p>}{error&&<p role="alert" className="error">{error}</p>}{run&&<article aria-live="polite" className="run-card"><h2>Run {run.state.toLowerCase()}</h2><p>{run.plan.question}</p><h3>Validated plan</h3><ol>{run.plan.steps.map((step,index)=><li key={`${step.source_id}-${index}`}>Read authorized source · {step.source_id.slice(0,8)}</li>)}</ol><h3>Run progress</h3><ol>{events.map(item=><li key={item.sequence}>{item.event_type.replaceAll('_',' ')}</li>)}</ol>{run.answer&&<><h3>Answer: {run.answer.presentation.title}</h3>{run.answer.answer.claims?.map((claim,index)=><p key={index}>{claim.statement} <small>Evidence: {claim.evidence_ids.map(id=>run.answer?.answer.evidence?.find(item=>item.evidence_id===id)?.locator??id).join(', ')}</small></p>)}{run.answer.answer.bySource?.map((item,index)=><p key={index}>Synthetic result: {item.value}</p>)}<p><strong>Trust:</strong> evidence-backed · read-only</p><button onClick={()=>void rate('useful')}>Useful</button><button onClick={()=>void rate('not_useful')}>Not useful</button>{feedback&&<p role="status">{feedback}</p>}</>}</article>}{!props.runId&&<CatalogueQuestion/>}</section>;
}

function AgentGroups(){
  const [groups,setGroups]=useState<Array<{groupId:string;version:number;connectionId:string;connectorType:string}>>([]);const [target,setTarget]=useState<Record<string,string>>({});const [error,setError]=useState('');
  async function reload(){const result=await api<{groups:typeof groups}>('/api/agents');setGroups(result.groups);}
  useEffect(()=>{void reload().catch(()=>setError('Agent groups could not be loaded.'));},[]);
  const unique=[...new Map(groups.map(group=>[group.groupId,group])).values()];
  return <article><h2>Source groups</h2>{groups.map(group=><div key={group.connectionId}><span>{group.connectorType.replaceAll('_',' ')} · group {group.groupId.slice(0,8)} v{group.version}</span><label>Move to<select aria-label={`Move ${group.connectorType} source group`} value={target[group.connectionId]??''} onChange={event=>setTarget({...target,[group.connectionId]:event.target.value})}><option value="">Choose a group</option>{unique.filter(item=>item.groupId!==group.groupId).map(item=><option key={item.groupId} value={item.groupId}>{item.groupId.slice(0,8)} v{item.version}</option>)}</select></label><button disabled={!target[group.connectionId]} onClick={async()=>{try{await api(`/api/groups/${target[group.connectionId]}/members/${group.connectionId}`,{method:'POST'});await reload();}catch(reason){setError(reason instanceof Error?reason.message:'Group move failed.');}}}>Move source</button></div>)}{groups.length===0&&<p>No active source groups.</p>}{error&&<p role="alert">{error}</p>}</article>;
}

function AgentsPage(){
  const [memory,setMemory]=useState<{vocabulary:Record<string,string>;defaultSources:string[];answerStyle:string|null}>({vocabulary:{},defaultSources:[],answerStyle:'concise'});const [governed,setGoverned]=useState<Array<{governedId:string;name:string;version:number;approvedBy:string|null}>>([]);const [name,setName]=useState('');const [question,setQuestion]=useState('');const [sources,setSources]=useState<string[]>([]);const [draft,setDraft]=useState<{governedId:string;version:number}|null>(null);const [message,setMessage]=useState('');const [error,setError]=useState('');
  async function loadGoverned(){const result=await api<{governed:typeof governed}>('/api/agents');setGoverned(result.governed);}
  useEffect(()=>{void Promise.all([api<{memory:typeof memory}>('/api/me/agent'),api<{sources:Array<{id:string}>}>('/api/analytic/sources'),api<{governed:typeof governed}>('/api/agents')]).then(([saved,connected,agentData])=>{setMemory(saved.memory);setSources(connected.sources.map(item=>item.id));setGoverned(agentData.governed);}).catch(()=>setError('Agent settings could not be loaded.'));},[]);
  async function save(){try{const result=await api<{memory:typeof memory}>('/api/me/agent',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(memory)});setMemory(result.memory);setMessage('Personal agent settings saved.');}catch(reason){setError(reason instanceof Error?reason.message:'Settings could not be saved.');}}
  async function create(){try{const result=await api<{governedId:string;version:number}>('/api/governed-agents',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name,question,sourceIds:sources})});setDraft(result);setMessage(`Draft version ${result.version} saved. A different tenant member must approve it.`);await loadGoverned();}catch(reason){setError(reason instanceof Error?reason.message:'Draft could not be saved.');}}
  async function approve(){if(!draft)return;try{await api(`/api/governed-agents/${draft.governedId}/approve`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({version:draft.version})});setMessage(`Version ${draft.version} approved.`);}catch(reason){setError(reason instanceof Error?reason.message:'Approval requires a different member.');}}
  async function rerun(){if(!draft)return;try{const result=await api<{runId:string}>(`/api/governed-agents/${draft.governedId}/runs`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({version:draft.version})});setMessage(`Governed run ${result.runId} started.`);}catch(reason){setError(reason instanceof Error?reason.message:'Governed run could not be started.');}}
  return <section><h1>Agents</h1><p>Personal settings shape presentation only. Governed definitions are immutable by version.</p><AgentGroups/><article><h2>My agent</h2><label>Answer style<select value={memory.answerStyle??'concise'} onChange={event=>setMemory({...memory,answerStyle:event.target.value})}><option value="concise">Concise</option><option value="detailed">Detailed</option><option value="sql_first">SQL first</option><option value="lineage_first">Lineage first</option></select></label><label>Vocabulary term<input id="vocabulary-term" /></label><label>Meaning<input id="vocabulary-meaning" /></label><button onClick={()=>{const term=(document.getElementById('vocabulary-term') as HTMLInputElement).value;const meaning=(document.getElementById('vocabulary-meaning') as HTMLInputElement).value;if(term&&meaning){const updated={...memory,vocabulary:{...memory.vocabulary,[term]:meaning}};setMemory(updated);void api('/api/me/agent',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(updated)}).then(()=>setMessage('Personal agent settings saved.')).catch(()=>setError('Settings could not be saved.'));}else void save();}}>Save my agent</button><button onClick={async()=>{await api('/api/me/agent',{method:'DELETE'});setMemory({vocabulary:{},defaultSources:[],answerStyle:null});setMessage('Personal memory deleted.');}}>Delete my memory</button></article><article><h2>Governed definition</h2><label>Name<input value={name} onChange={event=>setName(event.target.value)} /></label><label>Question<input value={question} onChange={event=>setQuestion(event.target.value)} /></label><button disabled={!name||!question||!sources.length} onClick={()=>void create()}>Save draft version</button>{draft&&<><p>Draft {draft.governedId}, version {draft.version}</p><button onClick={()=>void approve()}>Approve version</button><button onClick={()=>void rerun()}>Run approved version</button></>}</article><article><h2>Saved governed versions</h2>{governed.map(item=><div key={`${item.governedId}-${item.version}`}><p>{item.name} · version {item.version} · {item.approvedBy?'Approved':'Awaiting approval'}</p>{item.approvedBy&&<button onClick={async()=>{try{const result=await api<{runId:string}>(`/api/governed-agents/${item.governedId}/runs`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({version:item.version})});setMessage(`Governed run ${result.runId} started.`);}catch(reason){setError(reason instanceof Error?reason.message:'Governed run could not be started.');}}}>Run version {item.version}</button>}</div>)}</article>{error&&<p role="alert" className="error">{error}</p>}{message&&<p role="status">{message}</p>}</section>;
}

function ErPage(props: { connectionId: string | undefined; connections: Connection[]; navigate: (path: string) => void }) {
  const [relationships, setRelationships] = useState<Array<{ relationship_type: string; from_name: string; to_name: string; evidence_method: string | null; review_status: string | null; verification: string | null }>>([]);
  useEffect(() => {
    if (props.connectionId) void api<{ relationships: typeof relationships }>(`/api/connections/${props.connectionId}/er`).then(result => setRelationships(result.relationships));
  }, [props.connectionId]);
  if (!props.connectionId) return <section><h1>ER explorer</h1><p>Select a connector to inspect its structural relationships.</p>{props.connections.filter(connection => connection.status === 'active').map(connection => <button key={connection.connectionId} onClick={() => props.navigate(`/er?connection=${connection.connectionId}`)}>{connection.connectorType.replaceAll('_', ' ')}</button>)}</section>;
  return <section><h1>ER explorer</h1><p>Structural references are distinct from data-flow lineage.</p>{relationships.length === 0 ? <p>No relationships found.</p> : <ul>{relationships.map((item, index) => <li key={`${item.from_name}-${item.to_name}-${index}`}>{item.from_name} — {item.relationship_type} → {item.to_name} · {item.evidence_method ?? 'unreviewed'} · {item.verification ?? 'unverified'}</li>)}</ul>}</section>;
}

function ApprovalMatrix() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [governed,setGoverned]=useState<Array<{governedId:string;name:string;ownerId:string;version:number;approvedBy:string|null}>>([]);const [evaluation,setEvaluation]=useState<{count:number;questionIds:string[]}>({count:0,questionIds:[]});const [message,setMessage]=useState('');
  async function refresh(){const agentData=await api<{governed:typeof governed}>('/api/agents');setGoverned(agentData.governed);void api<typeof evaluation>('/api/evaluation').then(setEvaluation).catch(()=>setEvaluation({count:0,questionIds:[]}));void api<{notifications:Notification[]}>('/api/notifications').then(result=>setNotifications(result.notifications)).catch(()=>setNotifications([]));}
  useEffect(() => { void refresh(); }, []);
  return <section><h1>Approval matrix</h1><p>Review exact governed versions and lineage feedback summaries.</p><article><h2>Governed definitions</h2>{governed.map(item=><div key={`${item.governedId}-${item.version}`}><p>{item.name} · version {item.version} · {item.approvedBy?'Approved':'Awaiting approval'}</p>{!item.approvedBy&&<button onClick={async()=>{try{await api(`/api/governed-agents/${item.governedId}/approve`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({version:item.version})});setMessage(`Version ${item.version} approved.`);await refresh();}catch(reason){setMessage(reason instanceof Error?reason.message:'Approval failed.');}}}>Approve version {item.version}</button>}</div>)}{governed.length===0&&<p>No governed definitions yet.</p>}</article><article><h2>Evaluation set</h2><p>{evaluation.count} synthetic cases</p><ul>{evaluation.questionIds.map(id=><li key={id}>{id}</li>)}</ul></article><p role="status">{message}</p><h2>Discovery and profile findings</h2>{notifications.length === 0 ? <p>No findings yet.</p> : <ul>{notifications.map(item => <li key={item.notificationId}>{item.type === 'nightly' ? 'Nightly schema change' : 'Discovery completed'} · {String(item.summary.profiled ?? 0)} profiled objects · {item.readAt ? 'Earlier' : 'New'}</li>)}</ul>}</section>;
}

function NotificationPanel(props: { notifications: Notification[]; close: () => void; markRead: (id: string) => Promise<void> }) {
  return <aside className="notification-panel" aria-label="Notifications"><div className="page-heading"><h2>Notifications</h2><button aria-label="Close notifications" onClick={props.close}>×</button></div><h3>New</h3>{props.notifications.filter(item => !item.readAt).map(item => <button className="notification-item" key={item.notificationId} onClick={() => void props.markRead(item.notificationId)}>{item.type === 'nightly' ? 'Nightly profile updated' : 'Discovery completed'} · {String(item.summary.profiled ?? 0)} profiled</button>)}<h3>Earlier</h3>{props.notifications.filter(item => item.readAt).map(item => <p className="muted" key={item.notificationId}>{item.type === 'nightly' ? 'Nightly profile updated' : 'Discovery completed'}</p>)}</aside>;
}

function App() {
  const [path, setPath] = useState(location.pathname + location.search);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [unauthorized, setUnauthorized] = useState(false);
  const [groups, setGroups] = useState<NavGroups>(loadGroups);
  const [profileOpen, setProfileOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [error, setError] = useState('');
  async function reloadConnections() { const result = await api<{ connections: Connection[] }>('/api/connections'); setConnections(result.connections); }
  async function reloadNotifications() { const result = await api<{ notifications: Notification[] }>('/api/notifications'); setNotifications(result.notifications); }
  useEffect(() => {
    void Promise.all([api<Usage>('/api/usage').then(setUsage), reloadConnections()]).catch(reason => {
      if (reason instanceof Error && reason.message === 'unauthorized') setUnauthorized(true);
      else setError('Workspace data could not be loaded.');
    });
  }, []);
  useEffect(() => { try { localStorage.setItem('nav-workspace', String(groups.workspace)); localStorage.setItem('nav-platform', String(groups.platform)); } catch { /* Navigation still works when storage is disabled. */ } }, [groups]);
  useEffect(() => { const pop = () => setPath(location.pathname + location.search); addEventListener('popstate', pop); return () => removeEventListener('popstate', pop); }, []);
  if (path.startsWith('/login') || unauthorized) return <Login />;
  const navigate = (url: string) => { history.pushState({}, '', url); setPath(url); setError(''); };
  const toggle = (group: keyof NavGroups) => setGroups(value => ({ ...value, [group]: !value[group] }));
  async function signOut() { await fetch('/api/auth/logout', { method: 'POST' }); location.assign('/login'); }
  async function markRead(id: string) { await api(`/api/notifications/${id}/read`, { method: 'POST' }); await reloadNotifications(); }
  const currentConnection = new URLSearchParams(path.split('?')[1] ?? '').get('connection') ?? path.split('/')[2];
  let page: React.ReactNode;
  if (path.startsWith('/usage')) page = <section><h1>Usage</h1><p>Counts are derived from activity events for this billing period.</p><div className="cards"><article><span>Active users</span><strong>{usage?.active_users ?? 0}</strong></article>{Object.entries(usage?.active_connectors.by_type ?? {}).map(([type, count]) => <article key={type}><span>Active {type.replaceAll('_', ' ')} connectors</span><strong>{count}</strong></article>)}</div></section>;
  else if (path.startsWith('/connectors')) page = <ConnectorsPage connections={connections} reload={reloadConnections} navigate={navigate} />;
  else if (path.startsWith('/profile/')) page = <ProfilePage connectionId={currentConnection ?? ''} navigate={navigate} />;
  else if (path.startsWith('/dictionary')) page = currentConnection ? <DictionaryPage connectionId={currentConnection} /> : <section><h1>Dictionary</h1><p>Choose a connector to browse its Dictionary.</p>{connections.filter(connection => connection.status === 'active').map(connection => <button key={connection.connectionId} onClick={() => navigate(`/dictionary?connection=${connection.connectionId}`)}>{connection.connectorType.replaceAll('_', ' ')}</button>)}</section>;
  else if (path.startsWith('/controls')) page = currentConnection ? <ControlsPage connectionId={currentConnection} /> : <section><h1>Controls</h1><p>Choose a connector to manage its scope.</p>{connections.filter(connection => connection.status === 'active').map(connection => <button key={connection.connectionId} onClick={() => navigate(`/controls?connection=${connection.connectionId}`)}>{connection.connectorType.replaceAll('_', ' ')}</button>)}</section>;
  else if (path.startsWith('/er')) page = <ErPage connectionId={currentConnection} connections={connections} navigate={navigate} />;
  else if (path.startsWith('/approval-matrix')) page = <ApprovalMatrix />;
  else if (path.startsWith('/agents') || path.startsWith('/my-agent')) page = <AgentsPage />;
  else if(path.startsWith('/runs/'))page=<AnalyticWorkspace connections={connections} navigate={navigate} runId={path.split('/')[2]}/>;
  else page = <AnalyticWorkspace connections={connections} navigate={navigate} />;

  return <div className="app"><aside>
    <div className="brand"><span className="brandmark">S</span><b>Scale Insyght</b></div>
    <button className="new-chat" disabled aria-label="New chat available in a later phase">＋ New chat</button>
    <nav aria-label="Main navigation">
      <button className="section-toggle" aria-expanded={groups.workspace} onClick={() => toggle('workspace')}>WORKSPACE <span aria-hidden="true">{groups.workspace ? '⌄' : '›'}</span></button>
      {groups.workspace && <div className="nav-items"><a href="/" aria-current={path === '/' ? 'page' : undefined} onClick={event => { event.preventDefault(); navigate('/'); }}>⌂ <span>Home</span></a><a href="/connectors" aria-current={path.startsWith('/connectors') ? 'page' : undefined} onClick={event => { event.preventDefault(); navigate('/connectors'); }}>◫ <span>Connectors</span></a><a href="/dictionary" aria-current={path.startsWith('/dictionary') ? 'page' : undefined} onClick={event => { event.preventDefault(); navigate('/dictionary'); }}>▤ <span>Dictionary</span></a><a href="/er" aria-current={path.startsWith('/er') ? 'page' : undefined} onClick={event => { event.preventDefault(); navigate('/er'); }}>⌘ <span>Lineage</span></a></div>}
      <button className="section-toggle" aria-expanded={groups.platform} onClick={() => toggle('platform')}>PLATFORM <span aria-hidden="true">{groups.platform ? '⌄' : '›'}</span></button>
      {groups.platform && <div className="nav-items"><a href="/agents" onClick={event=>{event.preventDefault();navigate('/agents');}}>◉ <span>Agents</span></a><a href="/bi-reports">▧ <span>BI reports</span></a><a href="/approval-matrix" onClick={event => { event.preventDefault(); navigate('/approval-matrix'); }}>✓ <span>Approval matrix</span></a><a href="/controls" onClick={event => { event.preventDefault(); navigate('/controls'); }}>⚙ <span>Controls</span></a></div>}
    </nav>
    <div className="recent"><p>RECENT</p><span>No recent conversations</span></div>
    <div className="profile"><button aria-haspopup="menu" aria-expanded={profileOpen} onClick={() => setProfileOpen(value => !value)}><span className="avatar">A</span><span>Workspace profile</span><span aria-hidden="true">⋯</span></button>{profileOpen && <div role="menu"><button role="menuitem" onClick={() => navigate('/usage')}>Usage</button><button role="menuitem" onClick={signOut}>Sign out</button></div>}</div>
  </aside><main><header><span>Analytic mode · read-only</span><button aria-label="Notifications" title="Notifications" onClick={() => { setNotificationsOpen(value => !value); if (!notificationsOpen) void reloadNotifications(); }}>♧ {notifications.filter(item => !item.readAt).length || ''}</button></header>{error && <p className="error" role="alert">{error}</p>}{page}{notificationsOpen && <NotificationPanel notifications={notifications} close={() => setNotificationsOpen(false)} markRead={markRead} />}</main></div>;
}

createRoot(document.getElementById('root')!).render(<App />);

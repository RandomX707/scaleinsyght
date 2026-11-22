import React,{useEffect,useState}from'react';
import{createRoot}from'react-dom/client';
import'./style.css';

type Usage={active_users:number;active_connectors:{by_type:Record<string,number>}};
type NavGroups={workspace:boolean;platform:boolean};
function Login(){
 const[email,setEmail]=useState('');const[password,setPassword]=useState('');const[error,setError]=useState('');
 async function submit(event:React.FormEvent){event.preventDefault();setError('');const response=await fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password})});if(response.ok){location.assign('/');return;}setError('Email or password is incorrect.');}
 return <main className="login"><form onSubmit={submit}><div className="brandmark">S</div><h1>Welcome to Scale Insyght</h1><p>Sign in to your workspace</p><label>Email<input autoComplete="username" type="email" required value={email} onChange={event=>setEmail(event.target.value)}/></label><label>Password<input autoComplete="current-password" type="password" required value={password} onChange={event=>setPassword(event.target.value)}/></label>{error&&<p role="alert" className="error">{error}</p>}<button type="submit">Sign in</button><p className="muted">Single sign-on will be available in a later release.</p></form></main>;
}
function loadGroups():NavGroups{try{return{workspace:localStorage.getItem('nav-workspace')!=='false',platform:localStorage.getItem('nav-platform')!=='false'};}catch{return{workspace:true,platform:true};}}
function App(){
 const[path,setPath]=useState(location.pathname);const[usage,setUsage]=useState<Usage|null>(null);const[unauthorized,setUnauthorized]=useState(false);const[groups,setGroups]=useState<NavGroups>(loadGroups);const[profileOpen,setProfileOpen]=useState(false);
 useEffect(()=>{fetch('/api/usage').then(async response=>{if(response.status===401){setUnauthorized(true);return;}if(response.ok)setUsage(await response.json());}).catch(()=>setUnauthorized(true));},[]);
 useEffect(()=>{try{localStorage.setItem('nav-workspace',String(groups.workspace));localStorage.setItem('nav-platform',String(groups.platform));}catch{/* Storage may be disabled; navigation still works. */}},[groups]);
 useEffect(()=>{const pop=()=>setPath(location.pathname);addEventListener('popstate',pop);return()=>removeEventListener('popstate',pop);},[]);
 if(path==='/login'||unauthorized)return <Login/>;
 const navigate=(url:string)=>{history.pushState({},'',url);setPath(url);};
 const toggle=(group:keyof NavGroups)=>setGroups(value=>({...value,[group]:!value[group]}));
 async function signOut(){await fetch('/api/auth/logout',{method:'POST'});location.assign('/login');}
 return <div className="app"><aside>
  <div className="brand"><span className="brandmark">S</span><b>Scale Insyght</b></div>
  <button className="new-chat" disabled aria-label="New chat available in a later phase">＋ New chat</button>
  <nav aria-label="Main navigation">
   <button className="section-toggle" aria-expanded={groups.workspace} onClick={()=>toggle('workspace')}>WORKSPACE <span aria-hidden="true">{groups.workspace?'⌄':'›'}</span></button>
   {groups.workspace&&<div className="nav-items"><a href="/" aria-current={path==='/'?'page':undefined} onClick={event=>{event.preventDefault();navigate('/');}}>⌂ <span>Home</span></a><a href="/usage" aria-current={path==='/usage'?'page':undefined} onClick={event=>{event.preventDefault();navigate('/usage');}}>▤ <span>Usage</span></a></div>}
   <button className="section-toggle" aria-expanded={groups.platform} onClick={()=>toggle('platform')}>PLATFORM <span aria-hidden="true">{groups.platform?'⌄':'›'}</span></button>
   {groups.platform&&<div className="nav-items"><span className="muted nav-placeholder">No sources connected</span></div>}
  </nav>
  <div className="recent"><p>RECENT</p><span>No recent conversations</span></div>
  <div className="profile"><button aria-haspopup="menu" aria-expanded={profileOpen} onClick={()=>setProfileOpen(value=>!value)}><span className="avatar">A</span><span>Workspace profile</span><span aria-hidden="true">⋯</span></button>{profileOpen&&<div role="menu"><button role="menuitem" onClick={signOut}>Sign out</button></div>}</div>
 </aside><main><header><span>Analytic mode · read-only</span><button aria-label="Notifications" title="Notifications">♧</button></header>{path==='/usage'?<section><h1>Usage</h1><p>Counts are derived from activity events for this billing period.</p><div className="cards"><article><span>Active users</span><strong>{usage?.active_users??0}</strong></article>{Object.entries(usage?.active_connectors.by_type??{}).map(([type,count])=><article key={type}><span>Active {type.replaceAll('_',' ')} connectors</span><strong>{count}</strong></article>)}</div></section>:<section className="empty"><div className="spark" aria-hidden="true">✦</div><h1>What would you like to understand?</h1><p>Your workspace is ready. Connect a source to begin exploring its metadata.</p><button disabled>New chat · available in a later phase</button></section>}</main></div>;
}
const page=location.pathname==='/login'?<Login/>:<App/>;createRoot(document.getElementById('root')!).render(<React.StrictMode>{page}</React.StrictMode>);

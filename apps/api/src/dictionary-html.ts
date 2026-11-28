import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * "Export as interactive HTML" (item 5): one self-contained file that looks and behaves like the in-app Dictionary,
 * offline. The page's own stylesheets (design tokens, shared components, Dictionary) and fonts are embedded, the data is
 * the same JSON the page's API returns (one code path: listObjects, groupFor and objectDetail), and a
 * Content-Security-Policy forbids every network request. Metadata only: no row data, statistics withheld in the product
 * stay withheld, SQL shows literal values as placeholders, and out-of-scope objects appear by name and type only.
 */
export type HtmlObject = { name: string; kind: string; origin: string; group: { key: string; label: string; order: number }; copyOf?: string; copySimilarity?: number; descriptionState: string | null };
export type HtmlSource = { connectionId: string; name: string; type: string; objects: HtmlObject[]; details: Record<string, unknown>; outOfScope: Array<{ name: string; type: string }> };

/** JSON safe to place inside a <script> element: no "</script", "<!--" or line separators can end or confuse it. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

let assets: { styles: string; fonts: string } | null = null;
/** The page's stylesheets and fonts, read once from their packages. */
export function exportAssets(): { styles: string; fonts: string } {
  if (assets) return assets;
  const require = createRequire(import.meta.url);
  // @import lines are dropped: every stylesheet they name is embedded here, and the file must make no requests.
  const css = (path: string) => readFileSync(require.resolve(path), 'utf8').replace(/^\s*@import[^;]*;\s*$/gm, '');
  const font = (pkg: string, family: string, file: string, weight: number) => {
    const bytes = readFileSync(join(dirname(require.resolve(`${pkg}/package.json`)), 'files', file));
    return `@font-face{font-family:"${family}";font-style:normal;font-weight:${weight};font-display:swap;src:url(data:font/woff2;base64,${bytes.toString('base64')}) format("woff2")}`;
  };
  const fonts = [
    '/* Inter, latin subset. Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter).',
    '   This Font Software is licensed under the SIL Open Font License, Version 1.1 (https://openfontlicense.org). */',
    ...[400, 500, 600, 700].map((weight) => font('@fontsource/inter', 'Inter', `inter-latin-${weight}-normal.woff2`, weight)),
    '/* JetBrains Mono, latin subset. Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono).',
    '   This Font Software is licensed under the SIL Open Font License, Version 1.1 (https://openfontlicense.org). */',
    ...[400, 500].map((weight) => font('@fontsource/jetbrains-mono', 'JetBrains Mono', `jetbrains-mono-latin-${weight}-normal.woff2`, weight)),
  ].join('\n');
  // The export has no app shell, so the page gets the shell's padding and background here.
  const frame = 'body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--font);font-size:14px;line-height:1.45}.export-page{padding:24px 28px;max-width:1500px;margin:0 auto}'
    + '.dict-state{margin-left:6px;font-size:11px;color:var(--faint);white-space:nowrap}.dict-schema{color:var(--faint);font-size:11px;margin-left:6px;white-space:nowrap}'
    + '.export-note{color:var(--muted);font-size:12.5px;margin:4px 0 0}@media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}';
  assets = { styles: [css('@scaleinsyght/ui/tokens.css'), css('@scaleinsyght/ui/components.css'), css('@scaleinsyght/ui/dictionary.css'), frame].join('\n'), fonts };
  return assets;
}

const VIEWER = String.raw`(function(){
var data=JSON.parse(document.getElementById('dictionary-data').textContent);
var KIND={table:'Table',view:'View',materialized_view:'Materialized view',procedure:'Stored procedure',function:'Function',package:'SSIS package',sheet:'Sheet',model:'dbt model',source:'dbt source',datasource:'Data source',worksheet:'Worksheet',calculated_field:'Calculated field'};
var PROCKIND={fact_loader:'Fact loaders',report:'Report procedures',data_check:'Data checks',archive:'Archive',utility:'Utilities'};
var HOW={'truncate-insert':'TRUNCATE + INSERT',merge:'MERGE',insert:'INSERT',update:'UPDATE','delete':'DELETE'};
var TYPE={postgres:'PostgreSQL',sql_server:'SQL Server',snowflake:'Snowflake',excel:'Excel',dbt:'dbt',tableau:'Tableau',power_bi:'Power BI'};
var DEFAULT={dbo:1,public:1,PUBLIC:1};
function el(tag,attrs,children){var n=document.createElement(tag);for(var k in attrs||{}){var v=attrs[k];if(v===null||v===undefined||v===false)continue;if(k==='text')n.textContent=v;else if(k.indexOf('on')===0)n.addEventListener(k.slice(2),v);else n.setAttribute(k,v===true?'':v);}(children||[]).forEach(function(c){if(c!==null&&c!==undefined&&c!==false)n.appendChild(typeof c==='string'?document.createTextNode(c):c);});return n;}
function num(v){return Number(v).toLocaleString('en-US');}
function bare(n){return n.replace(/\([\s\S]*\)$/,'');}
function title(n){var b=bare(n).split('.');return b[b.length-1]||n;}
function schemaOf(n){var b=bare(n).split('.');return b.length>1?b.slice(0,-1).join('.'):'';}
function shortName(n){var p=n.split('.');return p.length===2&&DEFAULT[p[0]]?p[1]:n;}
function badge(text,tone){return el('span',{'class':'ui-badge'+(tone&&tone!=='primary'?' ui-badge--'+tone:''),text:text});}
function button(text,opts,on){opts=opts||{};return el('button',{type:'button','class':'ui-button ui-button--'+(opts.variant||'secondary')+(opts.small?' ui-button--small':'')+(opts.cls?' '+opts.cls:''),'aria-label':opts.label||null,title:opts.title||null,'aria-current':opts.current||null,onclick:on},typeof text==='string'?[text]:text);}
var state={source:0,tab:null,q:'',open:[],active:'',cards:{},defTab:{}};
var root=document.getElementById('app');
function src(){return data.sources[state.source];}
function stateLabel(s){return s==='drafted'?'Drafted':s==='approved'?'Approved':s==='edited'?'Edited':s==='imported'?'Imported':s==='dbt'?'From dbt':'';}
function matches(o){var q=state.q.toLowerCase();if(!q)return true;if(o.name.toLowerCase().indexOf(q)>=0)return true;var d=src().details[o.name];return !!(d&&d.columns&&d.columns.some(function(c){return c.name.toLowerCase().indexOf(q)>=0;}));}
function sqlHits(){var q=state.q.toLowerCase();if(!q)return [];var out=[];src().objects.forEach(function(o){var d=src().details[o.name];var t=d&&d.definition&&d.definition.text;if(!t)return;var count=t.toLowerCase().split(q).length-1;if(!count)return;var lines=t.split(/\r?\n/);var line=0;for(var i=0;i<lines.length;i++){if(lines[i].toLowerCase().indexOf(q)>=0){line=i;break;}}out.push({name:o.name,matches:count,line:line+1,text:lines[line].trim().slice(0,140)});});return out;}
function render(){
  var s=src();var counts={standard:0,custom:0};s.objects.forEach(function(o){counts[o.origin]++;});
  if(!state.tab)state.tab=counts.standard?'standard':'custom';
  root.textContent='';
  var heading=el('div',{'class':'page-heading dict-heading'},[el('div',{},[el('h1',{text:'Dictionary'}),el('p',{text:'Every table, procedure, view and package in a source, described in plain language, with what the last profile found.'}),
    el('p',{'class':'export-note',text:'Exported from Scale Insyght on '+new Date(data.generatedAt).toLocaleString(undefined,{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})+'. Metadata only: no row data. Statistics withheld in the product are withheld here. SQL shows literal values as placeholders.'})]),
    data.sources.length>1?el('label',{'class':'dict-source'},['Source',el('select',{'class':'ui-select','aria-label':'Source',onchange:function(e){state.source=Number(e.target.value);state.tab=null;state.open=[];state.active='';render();}},data.sources.map(function(x,i){var o=el('option',{value:String(i),text:x.name+' · '+(TYPE[x.type]||x.type)});if(i===state.source)o.selected=true;return o;}))]):null]);
  var side=el('nav',{'class':'dict-side','aria-label':'Objects'});
  side.appendChild(el('div',{'class':'dict-source-card'},[el('strong',{text:s.name}),el('p',{text:(TYPE[s.type]||s.type)+' · '+num(s.objects.length)+' objects'}),button('Details',{small:true},function(){state.active='';render();})]));
  side.appendChild(el('div',{'class':'ui-segmented',role:'tablist','aria-label':'Standard or custom'},['standard','custom'].map(function(t){return el('button',{'class':'ui-segmented__item',type:'button',role:'tab','aria-selected':String(state.tab===t),onclick:function(){state.tab=t;render();}},[t==='standard'?'Standard ':'Custom ',el('span',{'class':'dict-seg-count',text:num(counts[t])})]);})));
  var search=el('input',{'class':'ui-input',type:'search','aria-label':'Search tables, columns or SQL code',placeholder:'Search tables, columns or SQL code',value:state.q});
  var list=el('div',{});
  search.addEventListener('input',function(e){state.q=e.target.value;renderList(list);});
  side.appendChild(search);side.appendChild(list);renderList(list);
  var main=el('div',{'class':'dict-main'});
  var tabs=el('div',{'class':'ui-pill-tabs',role:'tablist','aria-label':'Open objects'},[{id:'',label:'Overview'}].concat(state.open.map(function(n){return {id:n,label:title(n),closable:true};})).map(function(item){
    return el('span',{'class':'ui-pill-tab'+(state.active===item.id?' is-selected':'')},[el('button',{type:'button',role:'tab','aria-selected':String(state.active===item.id),onclick:function(){state.active=item.id;render();},text:item.label}),
      item.closable?el('button',{type:'button','class':'ui-pill-tab__close','aria-label':'Close '+item.label,onclick:function(){state.open=state.open.filter(function(x){return x!==item.id;});if(state.active===item.id)state.active=state.open[state.open.length-1]||'';render();},text:'×'}):null]);}));
  main.appendChild(el('div',{'class':'dict-tabs-row'},[tabs,el('div',{'class':'dict-tabs-actions'},[button('Collapse all',{small:true},function(){setAll(false);}),button('Expand all',{small:true},function(){setAll(true);})])]));
  main.appendChild(state.active&&s.details[state.active]?objectView(s,s.details[state.active]):landing(s,counts));
  root.appendChild(el('section',{'class':'export-page dictionary-page'},[heading,el('div',{'class':'dict-layout'},[side,main])]));
}
function renderList(list){
  var s=src();list.textContent='';
  var shown=s.objects.filter(function(o){return o.origin===state.tab&&matches(o);});
  var groups={};shown.forEach(function(o){(groups[o.group.key]=groups[o.group.key]||{label:o.group.label,order:o.group.order,items:[]}).items.push(o);});
  var keys=Object.keys(groups).sort(function(a,b){return groups[a].order-groups[b].order;});
  if(!keys.length&&!state.q)list.appendChild(el('p',{'class':'dict-note',text:state.tab==='custom'?'No views, procedures, functions or packages in this source.':'No tables in this source.'}));
  keys.forEach(function(k){var g=groups[k];g.items.sort(function(a,b){return title(a.name).localeCompare(title(b.name))||a.name.localeCompare(b.name);});
    list.appendChild(el('div',{'class':'dict-group'},[el('h3',{},[el('span',{text:g.label}),el('span',{text:num(g.items.length)})]),el('ul',{},g.items.map(function(o){
      var schema=schemaOf(o.name);
      return el('li',{},[button([el('span',{'class':'mono',text:title(o.name)}),schema?el('span',{'class':'dict-schema',text:schema}):null,o.copyOf?el('span',{'class':'dict-copy',title:'Copy of '+title(o.copyOf)+(o.copySimilarity?' · '+Math.round(o.copySimilarity*100)+'% similar':''),text:'Copy'}):null,o.descriptionState?el('span',{'class':'dict-state',text:stateLabel(o.descriptionState)}):null],{variant:'ghost',small:true,cls:'dict-item'+(state.active===o.name?' is-active':''),title:o.name,current:state.active===o.name?'true':null},function(){openObject(o.name);})]);}))]));});
  var hits=sqlHits();
  if(hits.length)list.appendChild(el('div',{'class':'dict-group'},[el('h3',{},[el('span',{text:'In SQL code · '+hits.length}),el('span',{text:num(hits.reduce(function(t,h){return t+h.matches;},0))+' matches'})]),el('ul',{},hits.map(function(h){return el('li',{},[button([el('span',{'class':'dict-hit-head'},[el('span',{'class':'mono',text:title(h.name)}),el('span',{'class':'dict-count',text:String(h.matches)})]),el('span',{'class':'dict-snippet mono',text:'line '+h.line+': '+h.text})],{variant:'ghost',small:true,cls:'dict-item dict-sql-hit'},function(){openObject(h.name);})]);}))]));
  if(!shown.length&&!hits.length&&state.q)list.appendChild(el('p',{'class':'dict-note',text:'Nothing matches “'+state.q+'” here.'}));
}
function openObject(name){if(state.open.indexOf(name)<0)state.open.push(name);state.active=name;render();}
function isOpen(id){return state.cards[id]!==undefined?state.cards[id]:true;}
function setAll(v){['cols','used','keys','joins','tests','def-what','def-params','def-tables','def-calls','def-sql','dict-summary'].forEach(function(id){state.cards[id]=v;});render();}
function section(id,heading,children,aside){var d=el('details',{'class':'dict-card'},[el('summary',{},[el('span',{'class':'dict-card-title',text:heading}),aside?el('span',{'class':'dict-card-aside'},[aside]):null]),el('div',{'class':'dict-card-body'},children)]);d.open=isOpen(id);d.addEventListener('toggle',function(){state.cards[id]=d.open;});return d;}
function kv(rows){return el('dl',{'class':'dict-kv'},rows.filter(Boolean).map(function(r){return el('div',{},[el('dt',{text:r[0]}),el('dd',{},[r[1]])]);}));}
function names(list){return el('span',{'class':'dict-names'},list.map(function(n){var known=!!src().details[n];return known?button(shortName(n),{variant:'ghost',small:true,cls:'dict-name mono'},function(){openObject(n);}):el('span',{'class':'mono',text:shortName(n)});}));}
function table(headers,rows){return el('table',{'class':'dict-table'},[el('thead',{},[el('tr',{},headers.map(function(h){return el('th',{scope:'col',text:h});}))]),el('tbody',{},rows.map(function(r){return el('tr',{},r.map(function(c){return el('td',{},[c===null||c===undefined?'—':c]);}));}))]);}
function landing(s,counts){var o=s.objects;var cnt=function(k){return o.filter(function(x){return k.indexOf(x.kind)>=0;}).length;};
  var stats=[[num(cnt(['table','sheet','source','datasource'])),'tables'],[num(cnt(['view','materialized_view'])),'views'],[num(cnt(['procedure','function'])),'procedures and functions'],[num(counts.custom),'custom objects']];
  var states={};o.forEach(function(x){if(x.descriptionState)states[x.descriptionState]=(states[x.descriptionState]||0)+1;});
  var line=Object.keys(states).map(function(k){return num(states[k])+' '+stateLabel(k).toLowerCase();}).join(', ');
  return el('div',{},[section('dict-summary','This source',[el('p',{'class':'dict-eyebrow',text:s.name}),el('div',{'class':'dict-stats'},stats.map(function(x){return el('div',{},[el('strong',{text:x[0]}),el('span',{text:x[1]})]);})),
    line?el('p',{'class':'dict-note',text:'Descriptions: '+line+'.'}):null,
    el('p',{'class':'dict-note',text:'Standard objects are the source’s tables. Custom objects are what is built over them: views, materialized views, procedures, functions and packages.'}),
    s.outOfScope.length?el('details',{},[el('summary',{text:'Out of scope ('+num(s.outOfScope.length)+'), name and type only'}),el('ul',{},s.outOfScope.map(function(x){return el('li',{'class':'mono',text:x.name+' · '+x.type});}))]):null])]);}
function reviewChip(d){var o=d.description&&d.description.origin;return o==='drafted'?badge('Drafted','muted'):o==='approved'?badge('Approved'+(d.description.by?' by '+d.description.by:''),'good'):o==='edited'?badge('Edited'+(d.description.by?' by '+d.description.by:''),'good'):o==='dbt'?badge('From the dbt project','muted'):o==='imported'?badge('From the imported dictionary','muted'):null;}
function statTiles(d){var def=d.definition;var tiles=[];
  if(def&&['view','materialized_view','calculated_field'].indexOf(def.kind)<0)tiles=[[def.encrypted?'Unknown':num(def.reads.length),def.reads.length===1?'table it reads':'tables it reads'],[def.encrypted?'Unknown':num(def.writes.length),def.writes.length===1?'table it writes':'tables it writes'],[num(def.calledBy.length),'called by'],[num(def.parameters.length),def.parameters.length===1?'parameter':'parameters']];
  else if(d.stats)tiles=[[d.stats.rows===null?'—':(d.stats.rowsEstimated?'≈ ':'')+num(d.stats.rows),d.stats.rowsEstimated?'rows (estimated)':'rows'],[d.stats.lastProfiled?new Date(d.stats.lastProfiled).toLocaleString(undefined,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}):'—','last profiled'],[num(d.stats.dependentReports),d.stats.dependentReports===1?'report depends on it':'reports depend on it'],[d.stats.builtBy.length?d.stats.builtBy.map(title).join(', '):'—','built by']];
  return tiles.length?el('div',{'class':'dict-stats'},tiles.map(function(t){return el('div',{},[el('strong',{text:t[0]}),el('span',{text:t[1]})]);})):null;}
function objectView(s,d){var def=d.definition;
  var chip=reviewChip(d);
  var header=el('article',{'class':'dict-header'},[el('div',{'class':'dict-header-top'},[el('div',{},[el('p',{'class':'dict-eyebrow',text:s.name}),el('h2',{'class':'mono',text:title(d.name)})]),
    el('div',{'class':'dict-chips'},[badge((d.custom?'Custom ':'Standard ')+(KIND[d.kind]||d.kind).toLowerCase(),d.custom?'warn':'primary'),d.copyOf?el('span',{title:'Copy of '+title(d.copyOf)+(d.copySimilarity?' · '+Math.round(d.copySimilarity*100)+'% similar':'')},[badge('Copy of '+title(d.copyOf),'muted')]):null,
      d.procedureKind&&d.kind==='procedure'?badge(PROCKIND[d.procedureKind]||d.procedureKind,'muted'):null,def&&def.encrypted?badge('Encrypted','bad'):null])]),
    el('p',{'class':'dict-description',text:d.description?d.description.text:'No description yet.'}),chip?el('div',{'class':'dict-review'},[chip]):null,
    kv([['Type',KIND[d.kind]||d.kind],[/\([\s\S]*\)$/.test(d.name)?'Full signature':'Full name',el('span',{'class':'mono',text:d.name})],
      def&&def.parameters.length?['Parameters',el('span',{'class':'mono',text:def.parameters.map(function(p){return p.name;}).join(', ')})]:null,
      def&&def.returns&&def.returns.length?['Returns','A table with '+num(def.returns.length)+' '+(def.returns.length===1?'column':'columns')]:null,
      def?['Definition captured',new Date(def.capturedAt).toLocaleString(undefined,{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})+' · version '+def.version]:null]),
    statTiles(d)]);
  var out=el('div',{},[header]);
  if(def&&def.kind!=='calculated_field'){var tabs=[['overview','Overview'],['parameters','Parameters '+def.parameters.length],['tables','Tables and columns '+def.tablesAndColumns.length],['calls','Calls'],['sql','SQL']];var cur=state.defTab[d.name]||'overview';
    out.appendChild(el('div',{'class':'ui-tabs',role:'tablist','aria-label':'Definition'},tabs.map(function(t){return el('button',{'class':'ui-tab',type:'button',role:'tab','aria-selected':String(cur===t[0]),onclick:function(){state.defTab[d.name]=t[0];render();},text:t[1]});})));
    if(cur==='overview')out.appendChild(section('def-what','What it does',[def.encrypted?(def.usesFromCatalog&&((def.uses||[]).length||def.calls.length)?el('div',{},[kv([['Uses',(def.uses||[]).length?names(def.uses):'No tables or views'],['Runs',def.calls.length?names(def.calls):'Nothing']]),el('p',{'class':'dict-note'},[badge('From the database catalog','muted'),' The catalog records which objects this module refers to, not whether it reads or writes them.'])]):el('p',{text:'The source encrypts this definition, so what it reads and writes is unknown.'})):kv([['Writes',def.writes.length?names(def.writes.map(function(w){return w.table;})):'Nothing; it returns a result'],
      def.writes.length?['How',el('span',{},[Array.from(new Set(def.writes.map(function(w){return HOW[w.mode]||w.mode;}))).join(', ')+' ',badge('Parsed from SQL','muted')])]:null,['Reads',def.reads.length?names(def.reads):'No tables'],
      def.unresolved&&def.unresolved.length?['Unresolved',el('span',{},[el('span',{'class':'mono',text:def.unresolved.map(shortName).join(', ')}),' ',el('span',{'class':'dict-note',text:'named in the SQL but not found in this source'})])]:null]),
      def.steps.length?el('h4',{text:'Logic, parsed from the SQL'}):null,def.steps.length?el('ol',{'class':'dict-steps'},def.steps.map(function(x){return el('li',{text:x});})):null]));
    if(cur==='parameters')out.appendChild(section('def-params','Parameters',[def.parameters.length?table(['#','Name','Type','Direction','Source'],def.parameters.map(function(p,i){return [String(i+1),el('span',{'class':'mono',text:p.name}),el('span',{'class':'mono',text:p.dataType}),p.mode==='in'?'Input':p.mode==='out'?'Output':'Input and output',badge('Declared','good')];})):el('p',{text:'No parameters.'}),
      def.returns&&def.returns.length?el('h4',{text:'Returns a table with '+num(def.returns.length)+' '+(def.returns.length===1?'column':'columns')}):null,def.returns&&def.returns.length?table(['#','Column','Type'],def.returns.map(function(c,i){return [String(i+1),el('span',{'class':'mono',text:c.name}),el('span',{'class':'mono',text:c.dataType})];})):null]));
    if(cur==='tables')out.appendChild(section('def-tables','Tables and columns',def.tablesAndColumns.length?def.tablesAndColumns.map(function(t){return el('div',{'class':'dict-touch'},[el('h4',{},[names([t.table]),' ',el('span',{'class':'dict-note',text:t.access})]),el('p',{'class':'dict-columns'},t.columns.map(function(c){return el('span',{'class':'mono dict-col'+(c.used?' is-used':'')+(c.dropped?' is-dropped':''),text:c.name+(c.dropped?' (dropped)':'')});}))]);}):[el('p',{text:'No tables found in the SQL.'})]));
    if(cur==='calls')out.appendChild(section('def-calls','Calls',[kv([['Calls',def.calls.length?names(def.calls):'Nothing'],['Called by',def.calledBy.length?names(def.calledBy):'Nothing in this source'],['Run by',def.runBy.length?def.runBy.join(', '):'Not known: SQL Agent, SSIS and SSRS schedules are not read yet']])]));
    if(cur==='sql')out.appendChild(section('def-sql','SQL',def.encrypted?[el('div',{'class':'dict-encrypted'},[badge('Encrypted','bad'),el('p',{text:'The source stores this definition encrypted, so its SQL cannot be read.'})])]:[el('p',{'class':'dict-note',text:'Literal values hidden: strings and numbers are shown as placeholders.'}),el('pre',{'class':'dict-code',text:(def.text||'').replace(/^\s*\n/,'')})]));
  } else if(def&&def.kind==='calculated_field'){out.appendChild(section('def-sql','Formula',[el('pre',{'class':'dict-code',text:def.text||''})]));}
  var tableLike=!def||def.kind==='view'||def.kind==='materialized_view';
  if(d.columns.length||tableLike)out.appendChild(section('cols',d.kind==='sheet'?'Columns, with original headers':'Columns',[d.columns.length?table(['#','Column','Type','Nulls','Distinct','Used by','Tags'],d.columns.map(function(c,i){return [String(i+1),el('span',{},[el('span',{'class':'mono dict-colname',text:c.name}),c.key?badge('key'):null]),c.dataType?el('span',{'class':'mono',text:c.dataType+(c.nullable===false?' not null':'')}):null,
    c.statsWithheld?'Withheld':c.nullRate===null?null:(c.statisticsEstimated?'≈ ':'')+(c.nullRate*100).toLocaleString('en-US',{maximumFractionDigits:1})+'%',c.statsWithheld?'Withheld':c.distinctCount===null?null:(c.statisticsEstimated?'≈ ':'')+num(c.distinctCount),c.usedBy?num(c.usedBy):null,el('span',{},c.tags.map(function(t){return badge(t,'bad');}))];})):el('p',{text:'No columns recorded.'}),
    d.columns.some(function(c){return c.statsWithheld;})?el('p',{'class':'dict-note',text:'Withheld: tagged columns are never sampled, so their statistics are not collected.'}):null]));
  if(tableLike||d.usedBy.length)out.appendChild(section('used','Used by '+d.usedBy.length,[d.usedBy.length?el('ul',{'class':'dict-list'},d.usedBy.map(function(u){return el('li',{},[names([u.name]),' ',el('span',{'class':'dict-note',text:u.how+(u.source!==s.name?' · '+u.source:'')})]);})):el('p',{text:'Nothing in the graph reads this yet.'})]));
  if(tableLike&&d.stats){var ix=d.indexes,other=ix?ix.indexes.filter(function(i){return !i.primary;}):[];
    out.appendChild(section('keys','Keys and indexes',[d.kind==='sheet'?el('p',{text:'A workbook sheet has no keys or indexes.'}):!ix?el('p',{'class':'dict-note',text:'Primary key and indexes are read on this source\'s next profile.'}):el('div',{},[
      el('h4',{text:'Primary key'}),ix.primaryKey.length?el('p',{},[el('span',{'class':'mono',text:ix.primaryKey.join(', ')}),' ',badge('Primary key','good')]):el('p',{text:'No primary key.'}),
      el('h4',{text:'Indexes '+other.length}),other.length?table(['Index','Columns','Kind'],other.map(function(i){return [el('span',{'class':'mono',text:i.name}),el('span',{'class':'mono',text:i.columns.join(', ')}),i.unique?badge('Unique','primary'):'Index'];})):el('p',{text:'No other indexes.'})]),
      el('h4',{text:'Foreign keys '+d.keys.length}),d.keys.length?el('ul',{'class':'dict-list'},d.keys.map(function(k){return el('li',{},[el('span',{'class':'mono',text:k.column}),' → ',el('span',{'class':'mono',text:shortName(k.references)}),' ',badge('Declared foreign key','good')]);})):el('p',{text:'No declared foreign keys.'})]));}
  if(tableLike&&d.stats)out.appendChild(section('joins','Joins to other tables '+d.joins.length,[d.joins.length?table(['Column','Joins to','Evidence','Review'],d.joins.map(function(j){return [el('span',{'class':'mono',text:j.column}),el('span',{'class':'mono',text:shortName(j.otherTable)+'.'+j.otherColumn}),el('span',{},[el('span',{'class':'evidence-chip evidence-'+j.evidenceMethod,text:j.evidenceMethod}),j.probable?badge('Probable','warn'):null]),j.reviewStatus==='approved'?'Approved · still unverified':j.reviewStatus.replace(/_/g,' ')];})):el('p',{text:'No joins found.'})]));
  if(d.tests&&d.tests.length)out.appendChild(section('tests','dbt tests '+d.tests.length,[el('ul',{'class':'dict-list'},d.tests.map(function(t){return el('li',{text:(t.column||'model')+' · '+t.test});}))]));
  return out;}
render();
})();`;

export function renderDictionaryHtml(input: { generatedAt: string; sources: HtmlSource[] }): string {
  const { styles, fonts } = exportAssets();
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; img-src data:; base-uri 'none'; form-action 'none'">
<title>Data dictionary</title><style>
${fonts}
${styles}
</style></head>
<body><div id="app"></div>
<noscript><p>This dictionary needs JavaScript to show its objects.</p></noscript>
<script type="application/json" id="dictionary-data">${scriptJson({ generatedAt: input.generatedAt, sources: input.sources })}</script>
<script>${VIEWER}</script></body></html>`;
}

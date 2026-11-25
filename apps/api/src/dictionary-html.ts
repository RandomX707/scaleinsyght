/**
 * "Export as interactive HTML" (spec 2.5). One self-contained file: inline CSS and JavaScript, the data embedded as
 * JSON, and a Content-Security-Policy that forbids every network request, so it works offline and cannot call home.
 * It carries metadata only: names, types, descriptions, scrubbed definitions, relationships and the statistics the
 * product shows. Withheld statistics are absent, and out-of-scope objects appear by name and type only.
 */
export type HtmlColumn = { name: string; label: string | null; dataType: string | null; tags: string[]; statsWithheld: boolean; nullRate: number | null; distinctCount: number | null; description: string | null };
export type HtmlObject = { name: string; kind: string; custom: boolean; group: string; description: string | null; columns: HtmlColumn[];
  definition?: { encrypted: boolean; text: string | null; writes: Array<{ table: string; mode: string }>; reads: string[]; calls: string[] } };
export type HtmlSource = { name: string; type: string; objects: HtmlObject[]; relationships: Array<{ from: string; to: string; evidence: string; review: string }>; outOfScope: Array<{ name: string; type: string }> };

/** JSON safe to place inside a <script> element: no "</script", "<!--" or line separators can end or confuse it. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}
/** A form control in the exported file. The file is a standalone document, not the React app, so it cannot use the
 * shared components; controls are built here so their markup stays in one place. */
const control = (tag: 'input' | 'select' | 'button', attributes: string, inner = '') => tag === 'input' ? `<${tag} ${attributes}>` : `<${tag} ${attributes}>${inner}</${tag}>`;
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);

const STYLE = `
:root{--primary:#5A67D8;--ink:#1F2340;--muted:#5B6078;--line:#E3E5EE;--tint:#EEF0FC;--bg:#F7F8FB;--good:#15803D;--warn:#B45309;--bad:#B91C1C;font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink)}
*{box-sizing:border-box}body{margin:0;background:var(--bg);font-size:14px;line-height:1.45}
header{background:#fff;border-bottom:1px solid var(--line);padding:16px 24px}h1{font-size:20px;margin:0 0 4px}header p{margin:0;color:var(--muted)}
main{display:grid;grid-template-columns:300px 1fr;gap:16px;padding:16px 24px;max-width:1400px}
@media(max-width:800px){main{grid-template-columns:1fr;padding:16px}}
.panel{background:#fff;border:1px solid var(--line);border-radius:10px;padding:12px}
label{display:block;font-size:12px;color:var(--muted);margin:10px 0 4px}input,select{width:100%;padding:8px;border:1px solid var(--line);border-radius:8px;font:inherit}
input:focus,select:focus,button:focus,summary:focus{outline:2px solid var(--primary);outline-offset:2px}
.count{color:var(--muted);font-size:12px;margin-top:10px}
details.object{background:#fff;border:1px solid var(--line);border-radius:10px;margin-bottom:8px}
details.object>summary{cursor:pointer;padding:10px 12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.name{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:600}.chip{font-size:11px;border-radius:999px;padding:2px 8px;background:var(--tint);color:var(--primary)}
.chip.custom{background:#FEF3C7;color:var(--warn)}.chip.tag{background:#FEE2E2;color:var(--bad)}
.body{padding:0 12px 12px}table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;padding:6px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:500}
pre{background:#0F172A;color:#E2E8F0;padding:12px;border-radius:8px;overflow:auto;font-size:12px}.note{color:var(--muted);font-size:12px}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}button{font:inherit;border:1px solid var(--line);background:#fff;border-radius:8px;padding:6px 10px;cursor:pointer}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}`;

const SCRIPT = `
(function(){
var data=JSON.parse(document.getElementById('dictionary-data').textContent);
var list=document.getElementById('objects'),q=document.getElementById('q'),src=document.getElementById('source'),kind=document.getElementById('kind'),side=document.getElementById('side'),count=document.getElementById('count');
function el(tag,attrs,children){var n=document.createElement(tag);for(var k in attrs||{}){if(k==='text')n.textContent=attrs[k];else n.setAttribute(k,attrs[k]);}(children||[]).forEach(function(c){if(c)n.appendChild(c);});return n;}
var kinds={};data.sources.forEach(function(s,si){src.appendChild(el('option',{value:String(si),text:s.name+' ('+s.type+')'}));s.objects.forEach(function(o){kinds[o.group]=1;});});
Object.keys(kinds).sort().forEach(function(k){kind.appendChild(el('option',{value:k,text:k}));});
function pct(v){return v===null?'':(Math.round(v*1000)/10)+'%';}
function fmt(v){return v===null?'':Number(v).toLocaleString();}
function render(){
  var text=q.value.trim().toLowerCase(),shown=0;list.textContent='';
  data.sources.forEach(function(s,si){
    if(src.value!=='all'&&src.value!==String(si))return;
    s.objects.forEach(function(o){
      if(kind.value!=='all'&&o.group!==kind.value)return;
      if(side.value!=='all'&&(side.value==='custom')!==o.custom)return;
      var cols=o.columns.filter(function(c){return !text||c.name.toLowerCase().indexOf(text)>=0;});
      var inSql=o.definition&&o.definition.text&&text&&o.definition.text.toLowerCase().indexOf(text)>=0;
      if(text&&o.name.toLowerCase().indexOf(text)<0&&!cols.length&&!inSql)return;
      shown++;if(shown>500)return;
      var summary=el('summary',{},[el('span',{'class':'name',text:o.name}),el('span',{'class':'chip',text:o.group}),o.custom?el('span',{'class':'chip custom',text:'Custom'}):null,el('span',{'class':'note',text:s.name})]);
      var body=el('div',{'class':'body'});
      if(o.description)body.appendChild(el('p',{text:o.description}));
      if(o.columns.length){
        var rows=o.columns.map(function(c){return el('tr',{},[el('td',{'class':'mono',text:c.name}),el('td',{text:c.label&&c.label!==c.name?c.label:''}),el('td',{text:c.dataType||''}),
          el('td',{},c.tags.map(function(t){return el('span',{'class':'chip tag',text:t});})),el('td',{text:c.statsWithheld?'Withheld':pct(c.nullRate)}),el('td',{text:c.statsWithheld?'Withheld':fmt(c.distinctCount)}),el('td',{text:c.description||''})]);});
        body.appendChild(el('table',{},[el('thead',{},[el('tr',{},['Column','Header','Type','Tags','Nulls','Distinct','Description'].map(function(h){return el('th',{text:h});}))]),el('tbody',{},rows)]));
      }
      if(o.definition){
        var d=o.definition;
        if(d.writes.length)body.appendChild(el('p',{text:'Writes: '+d.writes.map(function(w){return w.table+' ('+w.mode+')';}).join(', ')}));
        if(d.reads.length)body.appendChild(el('p',{text:'Reads: '+d.reads.join(', ')}));
        if(d.calls.length)body.appendChild(el('p',{text:'Calls: '+d.calls.join(', ')}));
        body.appendChild(d.encrypted?el('p',{'class':'note',text:'Encrypted: the source withholds this definition.'}):d.text?el('div',{},[el('p',{'class':'note',text:'Literal values hidden.'}),el('pre',{text:d.text})]):null);
      }
      var rel=s.relationships.filter(function(r){return r.from.indexOf(o.name+'.')===0||r.to.indexOf(o.name+'.')===0;});
      if(rel.length)body.appendChild(el('div',{},[el('p',{text:'Relationships'}),el('ul',{},rel.map(function(r){return el('li',{'class':'mono',text:r.from+' → '+r.to+' · '+r.evidence+(r.evidence==='inferred'&&r.review!=='approved'?' (probable)':'')});}))]));
      list.appendChild(el('details',{'class':'object','data-name':o.name},[summary,body]));
    });
  });
  count.textContent=shown.toLocaleString()+' objects'+(shown>500?' (first 500 shown; narrow the search)':'');
}
[q,src,kind,side].forEach(function(n){n.addEventListener('input',render);});
document.getElementById('expand').addEventListener('click',function(){list.querySelectorAll('details').forEach(function(d){d.open=true;});});
document.getElementById('collapse').addEventListener('click',function(){list.querySelectorAll('details').forEach(function(d){d.open=false;});});
render();
})();`;

export function renderDictionaryHtml(input: { generatedAt: string; sources: HtmlSource[] }): string {
  const outOfScope = input.sources.flatMap((source) => source.outOfScope.map((item) => ({ source: source.name, ...item })));
  const objectCount = input.sources.reduce((total, source) => total + source.objects.length, 0);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
<title>Data dictionary</title><style>${STYLE}</style></head>
<body><header><h1>Data dictionary</h1><p>Exported from Scale Insyght on ${escapeHtml(input.generatedAt.slice(0, 16).replace('T', ' '))} UTC · ${input.sources.length.toLocaleString('en-US')} ${input.sources.length === 1 ? 'source' : 'sources'} · ${objectCount.toLocaleString('en-US')} objects.
Metadata only: no row data. Statistics withheld in the product are withheld here. Definitions show literal values as placeholders.</p></header>
<main><aside class="panel" aria-label="Filters">
<label for="q">Search names, columns and SQL</label>${control('input', 'id="q" type="search" autocomplete="off"')}
<label for="source">Source</label>${control('select', 'id="source"', '<option value="all">All sources</option>')}
<label for="side">Standard or custom</label>${control('select', 'id="side"', '<option value="all">All</option><option value="standard">Standard</option><option value="custom">Custom</option>')}
<label for="kind">Kind</label>${control('select', 'id="kind"', '<option value="all">All kinds</option>')}
<p class="count" id="count" role="status"></p>
<p>${control('button', 'type="button" id="expand"', 'Expand all')} ${control('button', 'type="button" id="collapse"', 'Collapse all')}</p>
${outOfScope.length ? `<details><summary>Out of scope (${outOfScope.length.toLocaleString('en-US')}), name and type only</summary><ul>${outOfScope.map((item) => `<li class="mono">${escapeHtml(item.source)} · ${escapeHtml(item.name)} · ${escapeHtml(item.type)}</li>`).join('')}</ul></details>` : ''}
</aside><section id="objects" aria-label="Objects"></section></main>
<script type="application/json" id="dictionary-data">${scriptJson({ sources: input.sources.map((source) => ({ ...source, outOfScope: undefined })) })}</script>
<script>${SCRIPT}</script></body></html>`;
}

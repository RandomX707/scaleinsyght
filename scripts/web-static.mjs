import { createReadStream } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { resolve, extname } from 'node:path';

const root=resolve(process.cwd(),'apps/web/dist');
const indexPath=resolve(root,'index.html');
const apiTarget=new URL(process.env.API_PROXY_TARGET??'http://api:3000');
const types={'.css':'text/css; charset=utf-8','.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'};
const server=createServer(async(request,response)=>{
  try{
    const path=request.url??'/';
    if(path==='/healthz'){response.writeHead(200,{'content-type':'text/plain'});response.end('ok');return;}
    if(path.startsWith('/api/')){
      const headers=new Headers();for(const [key,value] of Object.entries(request.headers)){if(['host','connection','content-length','transfer-encoding'].includes(key)||value===undefined)continue;headers.set(key,Array.isArray(value)?value.join(', '):value);}
      const method=request.method??'GET';const init={method,headers,redirect:'manual'};
      if(!['GET','HEAD'].includes(method)){Object.assign(init,{body:Readable.toWeb(request),duplex:'half'});}
      const upstream=await fetch(new URL(path,apiTarget),init);response.statusCode=upstream.status;
      for(const [key,value] of upstream.headers){if(['connection','transfer-encoding','content-encoding','set-cookie'].includes(key))continue;response.setHeader(key,value);}
      const cookies=upstream.headers.getSetCookie();if(cookies.length)response.setHeader('set-cookie',cookies);
      if(!upstream.body){response.end();return;}Readable.fromWeb(upstream.body).pipe(response);return;
    }
    const pathname=decodeURIComponent(new URL(path,'http://local').pathname);const candidate=resolve(root,`.${pathname}`);
    if(candidate!==root&&!candidate.startsWith(`${root}/`)){response.writeHead(400);response.end();return;}
    const file=candidate===root?indexPath:candidate;
    try{await access(file);response.writeHead(200,{'content-type':types[extname(file)]??'application/octet-stream','x-content-type-options':'nosniff'});if(request.method==='HEAD'){response.end();return;}createReadStream(file).pipe(response);}
    catch{response.writeHead(200,{'content-type':'text/html; charset=utf-8','x-content-type-options':'nosniff'});response.end(await readFile(indexPath));}
  }catch{if(!response.headersSent){response.writeHead(502,{'content-type':'text/plain; charset=utf-8'});response.end('Service unavailable');}else response.destroy();}
});
server.listen(Number(process.env.WEB_PORT??4173),'0.0.0.0');
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit(0)));

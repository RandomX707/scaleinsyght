import { createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { withTenant, getUsage } from '@scaleinsyght/db';

export interface GoldenAccount { tenantId: string; email: string; }
export interface ServerOptions { pool: Pool; sessionSecret: string; goldenAccounts: GoldenAccount[]; }
const sessionLifetimeMs = 8 * 60 * 60 * 1000;
export function hashPassword(password: string, salt = randomBytes(16).toString('hex')): string {
  return `${salt}:${scryptSync(password,salt,64).toString('hex')}`;
}
function verifyPassword(password:string,encoded:string):boolean{
  const [salt,hash]=encoded.split(':');if(!salt||!hash)return false;
  const actual=scryptSync(password,salt,64);const expected=Buffer.from(hash,'hex');
  return expected.length===actual.length && timingSafeEqual(actual,expected);
}
function digest(value:string):Buffer{return createHash('sha256').update(value).digest();}
function sign(value:string,secret:string):string{return createHmac('sha256',secret).update(value).digest('base64url');}

export async function buildServer(options:ServerOptions):Promise<FastifyInstance>{
  if(options.sessionSecret.length<32)throw new Error('SESSION_SECRET must contain at least 32 characters');
  const app=Fastify({logger:false});
  app.get('/api/health',async()=>({status:'ok'}));
  app.post<{Body:{email?:string;password?:string}}>('/api/auth/login',async(request,reply)=>{
    const email=request.body?.email?.trim().toLowerCase();const password=request.body?.password;
    if(!email||!password)return reply.code(400).send({error:'invalid_credentials'});
    const account=options.goldenAccounts.find(item=>item.email.toLowerCase()===email);
    if(!account)return reply.code(401).send({error:'invalid_credentials'});
    const token=randomBytes(32).toString('base64url');const sessionId=randomUUID();
    const user=await withTenant(options.pool,account.tenantId,async(client)=>{
      const result=await client.query<{user_id:string;password_hash:string;is_active:boolean}>(
        'SELECT user_id,password_hash,is_active FROM core.users WHERE tenant_id=$1 AND email=$2',[account.tenantId,email]);
      const row=result.rows[0];if(!row||!row.is_active||!verifyPassword(password,row.password_hash))return null;
      await client.query(`INSERT INTO core.sessions(tenant_id,session_id,user_id,token_hash,expires_at)
        VALUES($1,$2,$3,$4,clock_timestamp()+interval '8 hours')`,[account.tenantId,sessionId,row.user_id,digest(token)]);
      await client.query(`INSERT INTO core.activity_events(tenant_id,event_type,principal_id) VALUES($1,'user_active',$2)`,[account.tenantId,row.user_id]);
      return row;
    });
    if(!user)return reply.code(401).send({error:'invalid_credentials'});
    const payload=Buffer.from(JSON.stringify({tenantId:account.tenantId,userId:user.user_id,sessionId,token})).toString('base64url');
    const cookie=`${payload}.${sign(payload,options.sessionSecret)}`;
    reply.header('set-cookie',`si_session=${cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionLifetimeMs/1000}`);
    return reply.send({user:{email}});
  });
  async function session(request: {headers:Record<string,string|string[]|undefined>}):Promise<{tenantId:string;userId:string;sessionId:string;token:string}|null>{
    const cookieHeader=request.headers.cookie;if(!cookieHeader||Array.isArray(cookieHeader))return null;
    const cookie=cookieHeader.split(';').map(part=>part.trim()).find(part=>part.startsWith('si_session='))?.slice('si_session='.length);
    if(!cookie)return null;const [payload,signature]=cookie.split('.');if(!payload||!signature)return null;
    const expected=Buffer.from(sign(payload,options.sessionSecret));const actual=Buffer.from(signature);
    if(expected.length!==actual.length||!timingSafeEqual(expected,actual))return null;
    try{return JSON.parse(Buffer.from(payload,'base64url').toString()) as {tenantId:string;userId:string;sessionId:string;token:string};}catch{return null;}
  }
  app.post('/api/auth/logout',async(request,reply)=>{
    const current=await session(request);if(current)await withTenant(options.pool,current.tenantId,async(client)=>{
      await client.query('UPDATE core.sessions SET revoked_at=clock_timestamp() WHERE session_id=$1 AND user_id=$2',[current.sessionId,current.userId]);
    });
    reply.header('set-cookie','si_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return reply.code(204).send();
  });
  app.get('/api/usage',async(request,reply)=>{
    const current=await session(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const valid=await withTenant(options.pool,current.tenantId,async(client)=>{
      const result=await client.query('SELECT 1 FROM core.sessions WHERE session_id=$1 AND user_id=$2 AND token_hash=$3 AND revoked_at IS NULL AND expires_at>clock_timestamp()',
        [current.sessionId,current.userId,digest(current.token)]);return Boolean(result.rowCount);
    });
    if(!valid)return reply.code(401).send({error:'unauthorized'});
    const from=new Date();from.setUTCDate(1);from.setUTCHours(0,0,0,0);const to=new Date(from);to.setUTCMonth(to.getUTCMonth()+1);
    return reply.send(await getUsage(options.pool,current.tenantId,from,to));
  });
  return app;
}

import { config } from 'dotenv';
import { Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';
import phase4 from '../tests/golden/phase4.json' with { type: 'json' };

config({ path: '.env' });
const baseUrl = process.env.API_BASE_URL ?? 'http://127.0.0.1:3000';
const email = process.env.DEMO_EMAIL ?? 'analyst@north.example';
const password = 'golden-local-only';
const tenantId = 'golden-tenant-north';
const migratePool = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
const appPool = new Pool({ connectionString: process.env.DATABASE_URL });

async function request<T>(path: string, cookie: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers: { ...(init?.headers ?? {}), cookie } });
  if (!response.ok) throw new Error(`Demo seed request ${path} failed with HTTP ${response.status}`);
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

try {
  await withTenant(migratePool, tenantId, client => client.query("UPDATE core.tenants SET name='Riverside Health' WHERE tenant_id=$1", [tenantId]));
  await withTenant(migratePool, tenantId, async client => {
    for (const adapter of phase4.adapters) {
      await client.query(`INSERT INTO hub.adapters(tenant_id,product,connected,current_version) VALUES($1,$2,true,$3)
        ON CONFLICT(tenant_id,product) DO UPDATE SET connected=true,current_version=EXCLUDED.current_version,updated_at=clock_timestamp()`, [tenantId, adapter.product, adapter.version]);
      await client.query(`INSERT INTO hub.adapter_versions(tenant_id,product,version,fixture_key,capabilities) VALUES($1,$2,$3,$4,$5::jsonb)
        ON CONFLICT(tenant_id,product,version) DO NOTHING`, [tenantId, adapter.product, adapter.version, adapter.fixtureKey, JSON.stringify(adapter.capabilities)]);
    }
    const semantics = phase4.adapters.find(adapter => adapter.product === 'semantics');
    if (semantics) for (const metric of phase4.metrics) {
      await client.query(`INSERT INTO hub.certified_metrics(tenant_id,metric_id,adapter_product,adapter_version,name,description,dimensions,unit,certified,fixture_key,source_asset)
        VALUES($1,$2,'semantics',$3,$4,$5,$6::jsonb,$7,true,$8,$9)
        ON CONFLICT(tenant_id,metric_id) DO UPDATE SET adapter_version=EXCLUDED.adapter_version,name=EXCLUDED.name,description=EXCLUDED.description,dimensions=EXCLUDED.dimensions,unit=EXCLUDED.unit,certified=true,fixture_key=EXCLUDED.fixture_key,source_asset=EXCLUDED.source_asset`,
      [tenantId, metric.id, semantics.version, metric.name, metric.description, JSON.stringify(metric.dimensions), metric.unit, metric.fixtureKey, metric.sourceAsset]);
    }
    await client.query("INSERT INTO registry.capabilities(tenant_id,capability_id,active_version,effect_class,effect_safety,enabled) VALUES($1,'semantics.metric.read',1,'READ','not_applicable',true) ON CONFLICT(tenant_id,capability_id) DO UPDATE SET enabled=true", [tenantId]);
    await client.query("INSERT INTO registry.capability_versions(tenant_id,capability_id,version,input_schema,output_schema) VALUES($1,'semantics.metric.read',1,'{}','{}') ON CONFLICT DO NOTHING", [tenantId]);
    const user = await client.query<{ user_id: string }>('SELECT user_id FROM core.users WHERE tenant_id=$1 AND email=$2', [tenantId, email]);
    if (user.rows[0]) for (const metric of phase4.metrics) await client.query("INSERT INTO core.entitlements(tenant_id,principal_id,capability_id,resource_id) SELECT $1,$2,'semantics.metric.read',$3 WHERE NOT EXISTS(SELECT 1 FROM core.entitlements WHERE tenant_id=$1 AND principal_id=$2 AND capability_id='semantics.metric.read' AND resource_id=$3)", [tenantId, user.rows[0].user_id, metric.id]);
  });
  const login = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  if (!login.ok) throw new Error('Demo account is not seeded. Run pnpm db:seed:golden and start the API first.');
  const setCookie = login.headers.get('set-cookie');
  if (!setCookie) throw new Error('Demo sign-in did not return a session cookie.');
  const cookie = setCookie.split(';', 1)[0]!;
  const sourceList = await request<{ sources: Array<{ id: string; type: string }> }>('/api/sources', cookie);
  const primarySources = ['local-hospital', 'golden-postgres', 'golden-sqlserver', 'golden-snowflake', 'golden-excel'];
  for (const source of sourceList.sources.filter(item => primarySources.includes(item.id))) {
    const current = await withTenant(appPool, tenantId, client => client.query<{ connection_id: string; status: string }>(
      `SELECT connection_id,status FROM registry.connections WHERE tenant_id=$1 AND source_ref=$2 AND status IN ('draft','active') ORDER BY (status='active') DESC,created_at LIMIT 1`, [tenantId, source.id]));
    let connectionId = current.rows[0]?.connection_id;
    if (!connectionId) connectionId = (await request<{ connectionId: string }>('/api/connections', cookie, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceId: source.id }) })).connectionId;
    const status = await withTenant(appPool, tenantId, client => client.query<{ status: string }>('SELECT status FROM registry.connections WHERE tenant_id=$1 AND connection_id=$2', [tenantId, connectionId]));
    if (status.rows[0]?.status !== 'active') {
      await request(`/api/connections/${connectionId}/test`, cookie, { method: 'POST' });
      await request(`/api/connections/${connectionId}/activate`, cookie, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: [] }) });
    }
    const profile = await request<{ profile: unknown }>(`/api/connections/${connectionId}/profile`, cookie);
    if (!profile.profile) await request(`/api/connections/${connectionId}/discover`, cookie, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobType: 'profile' }) });
  }
  const nightlyConnection = await withTenant(appPool, tenantId, client => client.query<{ connection_id: string; alreadyRan: boolean }>(
    `SELECT c.connection_id,EXISTS(SELECT 1 FROM profiler.jobs j WHERE j.tenant_id=c.tenant_id AND j.connection_id=c.connection_id AND j.job_type='nightly' AND j.created_at::date=current_date) AS "alreadyRan"
     FROM registry.connections c WHERE c.tenant_id=$1 AND c.source_ref='golden-postgres' AND c.status='active' ORDER BY c.created_at LIMIT 1`, [tenantId]));
  if (nightlyConnection.rows[0] && !nightlyConnection.rows[0].alreadyRan) await request(`/api/connections/${nightlyConnection.rows[0].connection_id}/discover`, cookie, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobType: 'nightly' }) });
  for (const [sourceId, fixtureKey] of [['golden-dbt', 'dbt-manifest'], ['golden-tableau', 'tableau-reports'], ['golden-powerbi', 'power-bi-reports']] as const) {
    const draft = await request<{ connectionId: string }>('/api/metadata/connections', cookie, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceId }) });
    await request(`/api/metadata/connections/${draft.connectionId}/activate`, cookie, { method: 'POST' });
    await request(`/api/metadata/import/${draft.connectionId}`, cookie, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fixtureKey }) });
  }
  const saved = await request<{ questions: Array<{ planId: string }> }>('/api/me/saved-questions', cookie);
  if (saved.questions.length < 3) {
    const sources = await request<{ sources: Array<{ id: string }> }>('/api/analytic/sources', cookie);
    const sourceIds = sources.sources.slice(0, 2).map(source => source.id);
    const prompts = [
      'How many catalog objects are available in Meridian Lumen?',
      'Which catalog objects changed during the latest profile?',
      'How many objects are ready for analysis in Riverside Health?',
    ];
    for (const question of prompts.slice(0, 3 - saved.questions.length)) {
      const run = await request<{ runId: string }>('/api/runs', cookie, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question, sourceIds }) });
      let state = '';
      for (let attempt = 0; attempt < 80; attempt++) {
        const detail = await request<{ state: string }>(`/api/runs/${run.runId}`, cookie);
        state = detail.state;
        if (['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED', 'POLICY_BLOCKED'].includes(state)) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (state !== 'COMPLETED') throw new Error(`Demo analytic example ended in ${state || 'an unknown state'}.`);
      await request(`/api/runs/${run.runId}/feedback`, cookie, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verdict: 'useful' }) });
    }
  }
  const agentData = await request<{ governed: Array<{ name: string; governedId: string; approvedBy: string | null }> }>('/api/agents', cookie);
  if (!agentData.governed.some(item => item.name === 'Riverside morning briefing' && !item.approvedBy)) {
    const active = await request<{ sources: Array<{ id: string }> }>('/api/analytic/sources', cookie);
    if (active.sources.length) await request('/api/governed-agents', cookie, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Riverside morning briefing', question: 'Summarize the latest profile changes.', sourceIds: active.sources.slice(0, 2).map(source => source.id) }) });
  }
  const reports = await request<{ reports: Array<{ name: string; reportId: string }> }>('/api/me/reports', cookie);
  if (!reports.reports.some(item => item.name === 'Riverside profile summary')) {
    let agent = agentData.governed.find(item => item.name === 'Riverside profile summary' && !item.approvedBy);
    if (!agent) {
      const active = await request<{ sources: Array<{ id: string }> }>('/api/analytic/sources', cookie);
      const created = await request<{ governedId: string }>('/api/governed-agents', cookie, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Riverside profile summary', question: 'How many catalog objects are available in Meridian Lumen?', sourceIds: active.sources.slice(0, 1).map(source => source.id) }) });
      agent = { name: 'Riverside profile summary', governedId: created.governedId, approvedBy: null };
    }
    const approverLogin = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'approver@north.example', password }) });
    const approverCookie = approverLogin.headers.get('set-cookie')?.split(';', 1)[0];
    if (!approverLogin.ok || !approverCookie) throw new Error('The demo approver account could not sign in.');
    await request(`/api/governed-agents/${agent.governedId}/approve`, approverCookie, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: 1 }) });
    const approved = await request<{ governed: Array<{ governedId: string; name: string; version: number; approvedBy: string | null }> }>('/api/agents', cookie);
    const reportAgent = approved.governed.find(item => item.name === 'Riverside profile summary' && item.approvedBy);
    if (reportAgent) {
      const report = await request<{ reportId: string }>('/api/me/reports', cookie, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Riverside profile summary', governedId: reportAgent.governedId, version: reportAgent.version }) });
      await request(`/api/me/reports/${report.reportId}/run`, cookie, { method: 'POST' });
    }
  }
  const updates = await request<{ notifications: Array<{ notificationId: string; readAt: string | null }> }>('/api/notifications', cookie);
  for (const older of updates.notifications.filter(item => !item.readAt).slice(3)) await request(`/api/notifications/${older.notificationId}/read`, cookie, { method: 'POST' });
  process.stdout.write('Riverside Health demo data is ready for analyst@north.example.\n');
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Demo seed failed.'}\n`);
  process.exitCode = 1;
} finally {
  await appPool.end();
  await migratePool.end();
}

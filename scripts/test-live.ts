import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool, Client } from 'pg';
import { buildServer, hashPassword } from '@scaleinsyght/api/server';
import { assertLiveModelTestAllowed, OpenAIModelGateway } from '@scaleinsyght/model-gateway';
import { withTenant } from '@scaleinsyght/db';
import { containsExpectedNumbers, extractNumbers } from './live-result-check.mjs';

config({ path: '.env' });

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_required`);
  return value;
}

assertLiveModelTestAllowed(process.env);
required('OPENAI_API_KEY');
required('MODEL_DEFAULT');
required('MODEL_CHEAP');
required('MODEL_PRICING_JSON');
const appUrl = required('DATABASE_URL');
const migrateUrl = required('DATABASE_URL_MIGRATE');
const sourceUrl = required('DATABASE_URL_SAMPLE_SOURCE');
const tenantId = `live-${randomUUID()}`;
const loginEmail = `${tenantId}@synthetic.example`;
const secret = 'phase5b-live-local-session-secret-0123456789';
const appPool = new Pool({ connectionString: appUrl });
const migratePool = new Pool({ connectionString: migrateUrl });
const source = new Client({ connectionString: sourceUrl });

try {
  const manifestPath = resolve('.local/dbt/target/manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
  await withTenant(migratePool, tenantId, async (db) => {
    await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)', [tenantId]);
    await db.query('INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,$3)', [tenantId, loginEmail, hashPassword('synthetic-local-password')]);
  });

  const server = await buildServer({ pool: appPool, sessionSecret: secret, testAccounts: [{ tenantId, email: loginEmail }] });
  try {
    const login = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email: loginEmail, password: 'synthetic-local-password' } });
    if (login.statusCode !== 200) throw new Error('live_demo_login_failed');
    const cookie = String(login.headers['set-cookie']);
    const draft = await server.inject({ method: 'POST', url: '/api/connections', headers: { cookie }, payload: { sourceId: 'local-hospital' } });
    if (draft.statusCode !== 201) throw new Error('live_demo_source_connection_failed');
    const sourceConnectionId = (draft.json() as { connectionId: string }).connectionId;
    const activated = await server.inject({ method: 'POST', url: `/api/connections/${sourceConnectionId}/activate`, headers: { cookie }, payload: { scope: [] } });
    if (activated.statusCode !== 200) throw new Error('live_demo_source_activation_failed');

    const dbtDraft = await server.inject({ method: 'POST', url: '/api/metadata/connections', headers: { cookie }, payload: { sourceId: 'local-dbt-manifest' } });
    if (dbtDraft.statusCode !== 201) throw new Error('live_demo_dbt_connection_failed');
    const dbtConnectionId = (dbtDraft.json() as { connectionId: string }).connectionId;
    const dbtActivated = await server.inject({ method: 'POST', url: `/api/metadata/connections/${dbtConnectionId}/activate`, headers: { cookie } });
    if (dbtActivated.statusCode !== 200) throw new Error('live_demo_dbt_activation_failed');
    const imported = await server.inject({ method: 'POST', url: `/api/metadata/import/${dbtConnectionId}`, headers: { cookie }, payload: { manifest, sourceConnectionId } });
    if (imported.statusCode !== 200) throw new Error('live_demo_manifest_import_failed');

    await source.connect();
    const aggregate = await source.query<{ encounter_count: string; department_count: string; average_per_department: string }>(
      `SELECT sum(encounter_count)::text AS encounter_count,count(*)::text AS department_count,
        round(avg(encounter_count),2)::text AS average_per_department
       FROM (SELECT department_id,count(*) AS encounter_count FROM public.encounters GROUP BY department_id HAVING count(*) >= 10) groups_by_department`,
    );
    const metrics = aggregate.rows[0];
    if (!metrics) throw new Error('live_analytic_aggregate_missing');
    const assetsResult = await server.inject({ method: 'GET', url: '/api/lineage/assets', headers: { cookie } });
    if (assetsResult.statusCode !== 200) throw new Error('live_lineage_assets_failed');
    const assets = (assetsResult.json() as { assets: Array<{ asset_id: string; qualified_name: string; asset_type: string }> }).assets;
    const modelAsset = assets.find((asset) => asset.qualified_name.startsWith('dbt.'));
    if (!modelAsset) throw new Error('live_dbt_model_not_imported');
    const lineageResult = await server.inject({ method: 'GET', url: `/api/lineage?assetId=${encodeURIComponent(modelAsset.asset_id)}&direction=upstream`, headers: { cookie } });
    if (lineageResult.statusCode !== 200) throw new Error('live_lineage_query_failed');
    const lineage = lineageResult.json() as { assets?: Array<{ asset_id: string; qualified_name: string }>; edges?: Array<{ from_asset_id: string; to_asset_id: string; granularity: string }> };
    if (!lineage.assets?.length) throw new Error('live_lineage_path_empty');

    const gateway = new OpenAIModelGateway(appPool);
    const analytic = await gateway.complete({
      tenantId, alias: 'cheap', question: 'Summarize the synthetic hospital encounter aggregate. Return only a JSON object with numeric fields encounter_count, department_count, and average_per_department. Use the exact values and do not use thousands separators or prose.',
      metadata: { classification: 'METADATA_STATISTICAL', structural: { source: 'public.encounters', grouping: 'department_id' }, descriptive: {}, statistical: { encounter_count: Number(metrics.encounter_count), department_count: Number(metrics.department_count), average_per_department: Number(metrics.average_per_department) }, sensitivityTags: [], groupSize: Number(metrics.encounter_count), minimumCellSize: 10 },
      maxOutputTokens: 300,
    });
    const expectedAnalytic = `encounter_count=${metrics.encounter_count}; department_count=${metrics.department_count}; average_per_department=${metrics.average_per_department}`;
    const expectedAnalyticValues = [metrics.encounter_count, metrics.department_count, metrics.average_per_department];
    const analyticMatches = containsExpectedNumbers(analytic.text, expectedAnalyticValues);

    const lineageNames = lineage.assets.map((asset) => asset.qualified_name);
    const lineageEdges = lineage.edges ?? [];
    const namesById = new Map(lineage.assets.map((asset) => [asset.asset_id, asset.qualified_name]));
    const lineageAnswer = await gateway.complete({
      tenantId, alias: 'default', question: `Explain the upstream lineage for ${modelAsset.qualified_name}. Name the source objects and describe the relationship path.`,
      metadata: { classification: 'METADATA_STRUCTURAL', structural: { selected_model: modelAsset.qualified_name, assets: lineageNames, relationships: lineageEdges.map((edge) => ({ from: namesById.get(edge.from_asset_id), to: namesById.get(edge.to_asset_id), granularity: edge.granularity })) }, descriptive: {}, statistical: {}, sensitivityTags: [] },
      maxOutputTokens: 400,
    });
    const expectedLineage = lineageNames.join(', ');
    const lineageMatches = lineageNames.every((name) => lineageAnswer.text.includes(name));
    const usage = await withTenant(appPool, tenantId, async (db) => db.query<{ input_tokens: string; output_tokens: string; cost_usd: string }>(
      `SELECT sum(input_tokens)::text AS input_tokens,sum(output_tokens)::text AS output_tokens,sum(cost_usd)::text AS cost_usd FROM core.model_usage WHERE tenant_id=$1 AND outcome='completed'`, [tenantId],
    ));
    const totals = usage.rows[0]!;
    process.stdout.write(`Analytic deterministic baseline: ${expectedAnalytic}\n`);
    process.stdout.write(`Analytic model ${analytic.model}: ${analyticMatches ? 'matched all values' : 'differed from baseline'} (${analytic.inputTokens + analytic.outputTokens} tokens)\n`);
    process.stdout.write(`Analytic model numeric values observed: ${extractNumbers(analytic.text).join(', ')}\n`);
    process.stdout.write(`Lineage deterministic path: ${expectedLineage}\n`);
    process.stdout.write(`Lineage model ${lineageAnswer.model}: ${lineageMatches ? 'named every source object' : 'omitted or changed a source object'} (${lineageAnswer.inputTokens + lineageAnswer.outputTokens} tokens)\n`);
    process.stdout.write(`Total live model usage: ${totals.input_tokens} input tokens, ${totals.output_tokens} output tokens, USD ${Number(totals.cost_usd).toFixed(6)}\n`);
    if (!analyticMatches || !lineageMatches) process.exitCode = 2;
  } finally {
    await server.close();
  }
} catch (error) {
  const code = error instanceof Error ? error.message : 'live_model_test_failed';
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
} finally {
  await source.end().catch(() => undefined);
  await appPool.end();
  await migratePool.end();
}

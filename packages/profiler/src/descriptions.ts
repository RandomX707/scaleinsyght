import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';

/**
 * Decision 66: plain-language Dictionary descriptions drafted by the model gateway, in the background after a profile.
 * Input is metadata only (contract 7): names, column names, declared keys, parameters and returned columns, the parsed
 * Reads, Writes and Calls, and scrubbed SQL (literals already placeholders) cut to a bounded length. Never data values,
 * never statistics of any column, never imported vendor text. Objects with an imported or dbt description, or one a
 * person approved or edited, are never drafted. When a call fails, the budget is used up or the gateway is not
 * configured, objects keep the code template (stale model drafts are removed so the template shows).
 */
export type DescribeRequest = {
  tenantId: string; alias: 'cheap'; purpose: 'describe'; question: string; maxOutputTokens: number; responseSchema: Record<string, unknown>;
  metadata: { classification: 'METADATA_DESCRIPTIVE'; structural: Record<string, unknown>; descriptive: Record<string, string>; statistical: Record<string, never>; sensitivityTags: string[] };
};
export type DescribeCall = (request: DescribeRequest) => Promise<{ text: string }>;

export const DESCRIPTION_LIMITS = { dataPerCall: 25, codePerCall: 6, charsPerCall: 24_000, sqlChars: 6_000, columns: 80, minLength: 20, maxLength: 320 };

export type DescriptionSubject = {
  name: string; kind: string; columns: string[]; keys: string[]; parameters: string[]; returns: string[];
  reads: string[]; writes: string[]; calls: string[]; sql: string | null;
};
const CODE_KINDS = new Set(['view', 'materialized_view', 'procedure', 'function', 'package']);

/** Exactly what is sent for one object, and so what its hash covers. */
export function describeInput(subject: DescriptionSubject) {
  return { name: subject.name, kind: subject.kind, columns: subject.columns.slice(0, DESCRIPTION_LIMITS.columns), keys: subject.keys, parameters: subject.parameters,
    returns: subject.returns, reads: subject.reads, writes: subject.writes, calls: subject.calls, sql: subject.sql ? subject.sql.slice(0, DESCRIPTION_LIMITS.sqlChars) : null };
}
export const inputHash = (subject: DescriptionSubject) => createHash('sha256').update(JSON.stringify(describeInput(subject))).digest();

/** Batches by kind: tables many per call, code objects a few, both bounded by the characters sent. */
export function descriptionBatches(subjects: DescriptionSubject[]): DescriptionSubject[][] {
  const batches: DescriptionSubject[][] = [];
  for (const code of [false, true]) {
    let current: DescriptionSubject[] = []; let size = 0;
    for (const subject of subjects.filter((item) => CODE_KINDS.has(item.kind) === code)) {
      const length = JSON.stringify(describeInput(subject)).length;
      if (current.length && (current.length >= (code ? DESCRIPTION_LIMITS.codePerCall : DESCRIPTION_LIMITS.dataPerCall) || size + length > DESCRIPTION_LIMITS.charsPerCall)) { batches.push(current); current = []; size = 0; }
      current.push(subject); size += length;
    }
    if (current.length) batches.push(current);
  }
  return batches;
}

/** One or two plain sentences in sentence case, bounded length, no line breaks or markup. */
export function validDraft(text: unknown): text is string {
  if (typeof text !== 'string') return false;
  const value = text.trim();
  if (value.length < DESCRIPTION_LIMITS.minLength || value.length > DESCRIPTION_LIMITS.maxLength || /[\n\r`*#<>]/.test(value)) return false;
  if (!/^[A-Z]/.test(value) || !/[.!?]$/.test(value)) return false;
  return value.split(/(?<=[.!?])\s+(?=[A-Z])/).length <= 2;
}

export function describeRequest(tenantId: string, batch: DescriptionSubject[]): DescribeRequest {
  const names = batch.map((subject) => subject.name);
  return {
    tenantId, alias: 'cheap', purpose: 'describe', maxOutputTokens: 120 * batch.length + 200,
    question: `Describe each listed object in one or two plain sentences: what it holds or does and what it is for, as a business reader would understand it. Do not list its columns or tables. Use only the metadata given. Objects: ${names.join(', ')}`,
    metadata: {
      classification: 'METADATA_DESCRIPTIVE',
      // SQL travels only as descriptive text, under a "definition" key so the gateway's boundary scrubs it again; the
      // structure leaves the key out (the gateway rejects undefined values).
      structural: { objects: batch.map((subject) => Object.fromEntries(Object.entries(describeInput(subject)).filter(([key]) => key !== 'sql'))) },
      descriptive: Object.fromEntries(batch.filter((subject) => subject.sql).map((subject) => [`definition ${subject.name}`, describeInput(subject).sql!])),
      statistical: {}, sensitivityTags: [],
    },
    responseSchema: { type: 'object', additionalProperties: false, required: ['descriptions'], properties: { descriptions: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['name', 'text'], properties: { name: { type: 'string', enum: names }, text: { type: 'string' } } } } } },
  };
}

/** Every object of a source that Scale Insyght describes, with the metadata a description may use. */
export async function descriptionSubjects(pool: Pool, tenantId: string, connectionId: string): Promise<DescriptionSubject[]> {
  return withTenant(pool, tenantId, async (client) => {
    const type = (await client.query<{ connector_type: string }>('SELECT connector_type FROM registry.connections WHERE tenant_id=$1 AND connection_id=$2', [tenantId, connectionId])).rows[0]?.connector_type;
    if (!type || type === 'dbt' || type === 'tableau' || type === 'power_bi') return [];
    const datasets = (await client.query<{ name: string; object_type: string | null; columns: string[] | null }>(
      `SELECT d.qualified_name AS name,(SELECT structural_attributes->>'object_type' FROM graph.asset_versions v WHERE v.tenant_id=d.tenant_id AND v.asset_id=d.asset_id ORDER BY version DESC LIMIT 1) AS object_type,
         (SELECT array_agg(split_part(f.qualified_name,'.',array_length(string_to_array(f.qualified_name,'.'),1)) ORDER BY f.qualified_name) FROM graph.relationships c JOIN graph.assets f ON f.tenant_id=c.tenant_id AND f.asset_id=c.to_asset_id AND f.active
           WHERE c.tenant_id=d.tenant_id AND c.family='structural' AND c.relationship_type='CONTAINS' AND c.from_asset_id=d.asset_id) AS columns
       FROM graph.assets d WHERE d.tenant_id=$1 AND d.source_id=$2 AND d.active AND d.asset_type='dataset' ORDER BY d.qualified_name`, [tenantId, connectionId])).rows;
    const keys = new Map<string, string[]>();
    for (const row of (await client.query<{ from_table: string; from_name: string; to_name: string }>(
      `SELECT DISTINCT fd.qualified_name AS from_table,f.qualified_name AS from_name,t.qualified_name AS to_name FROM graph.assets fd
         JOIN graph.relationships fc ON fc.tenant_id=fd.tenant_id AND fc.family='structural' AND fc.relationship_type='CONTAINS' AND fc.from_asset_id=fd.asset_id
         JOIN graph.relationships r ON r.tenant_id=fc.tenant_id AND r.family='structural' AND r.relationship_type='REFERENCES' AND r.from_asset_id=fc.to_asset_id
         JOIN graph.assets f ON f.tenant_id=r.tenant_id AND f.asset_id=r.from_asset_id AND f.active JOIN graph.assets t ON t.tenant_id=r.tenant_id AND t.asset_id=r.to_asset_id AND t.active
       WHERE fd.tenant_id=$1 AND fd.source_id=$2 AND fd.active AND EXISTS(SELECT 1 FROM graph.assertions s WHERE s.tenant_id=r.tenant_id AND s.relationship_id=r.relationship_id AND s.valid_to IS NULL AND s.evidence_method='declared' AND s.review_status NOT IN ('rejected','stale','disputed'))
       ORDER BY 1,2,3`, [tenantId, connectionId])).rows) keys.set(row.from_table, [...(keys.get(row.from_table) ?? []), `${row.from_name.split('.').at(-1)} references ${row.to_name}`]);
    const definitions = new Map((await client.query<{ qualified_name: string; kind: string; scrubbed_text: string | null; encrypted: boolean; parameters: Array<{ name: string }>; returned_columns: Array<{ name: string }>; analysis: { reads?: string[]; writes?: Array<{ table: string }>; calls?: string[] } }>(
      `SELECT qualified_name,kind,scrubbed_text,encrypted,parameters,returned_columns,analysis FROM graph.definitions WHERE tenant_id=$1 AND source_id=$2 AND active AND kind<>'calculated_field'`, [tenantId, connectionId])).rows.map((row) => [row.qualified_name, row]));
    const subject = (name: string, kind: string, columns: string[]): DescriptionSubject => {
      const definition = definitions.get(name);
      return { name, kind, columns, keys: keys.get(name) ?? [], parameters: (definition?.parameters ?? []).map((item) => item.name), returns: (definition?.returned_columns ?? []).map((item) => item.name),
        reads: definition?.analysis.reads ?? [], writes: (definition?.analysis.writes ?? []).map((item) => item.table), calls: definition?.analysis.calls ?? [], sql: definition && !definition.encrypted ? definition.scrubbed_text : null };
    };
    const subjects = datasets.map((row) => subject(row.name, type === 'excel' ? 'sheet' : row.object_type === 'view' || row.object_type === 'materialized_view' ? row.object_type : 'table', row.columns ?? []));
    const seen = new Set(subjects.map((item) => item.name));
    for (const definition of definitions.values()) if (!seen.has(definition.qualified_name) && definition.kind !== 'view') subjects.push(subject(definition.qualified_name, definition.kind, []));
    return subjects;
  });
}

/**
 * Drafts what needs drafting for one source and stores it as "drafted" with its input hash. Returns counts only.
 * A budget or configuration failure stops further calls; any other failed batch keeps the template for its objects.
 */
export async function draftModelDescriptions(pool: Pool, input: { tenantId: string; connectionId: string; complete: DescribeCall }) {
  const subjects = await descriptionSubjects(pool, input.tenantId, input.connectionId);
  const state = await withTenant(pool, input.tenantId, async (client) => ({
    described: new Set((await client.query<{ name: string }>(`SELECT table_name AS name FROM graph.dictionary_descriptions WHERE tenant_id=$1 AND source_id=$2 AND column_name=''
      UNION SELECT qualified_name FROM graph.description_reviews WHERE tenant_id=$1 AND source_id=$2 AND field_name='' AND status<>'draft'`, [input.tenantId, input.connectionId])).rows.map((row) => row.name)),
    drafts: new Map((await client.query<{ qualified_name: string; input_hash: Buffer | null }>(`SELECT qualified_name,input_hash FROM graph.description_reviews
      WHERE tenant_id=$1 AND source_id=$2 AND field_name='' AND status='draft' AND drafted_by='model'`, [input.tenantId, input.connectionId])).rows.map((row) => [row.qualified_name, row.input_hash])),
  }));
  const pending = subjects.filter((subject) => !state.described.has(subject.name) && !(state.drafts.get(subject.name)?.equals(inputHash(subject))));
  const result = { objects: subjects.length, pending: pending.length, drafted: 0, kept: 0, failedBatches: 0, calls: 0, stopped: null as string | null };
  const failed: DescriptionSubject[] = [];
  for (const batch of descriptionBatches(pending)) {
    if (result.stopped) { failed.push(...batch); continue; }
    let parsed: { descriptions?: Array<{ name?: unknown; text?: unknown }> };
    try { result.calls++; parsed = JSON.parse((await input.complete(describeRequest(input.tenantId, batch))).text) as typeof parsed; }
    catch (error) {
      const code = error instanceof Error ? (error as Error & { code?: string }).code ?? error.message : 'describe_failed';
      if (/budget|cap_reached|not_configured|OPENAI_API_KEY|MODEL_CHEAP|pricing/i.test(code)) result.stopped = /^[\w:-]{1,80}$/.test(code) ? code : 'model_unavailable';
      result.failedBatches++; failed.push(...batch); continue;
    }
    const texts = new Map((parsed.descriptions ?? []).filter((item) => typeof item.name === 'string' && validDraft(item.text)).map((item) => [item.name as string, (item.text as string).trim()]));
    await withTenant(pool, input.tenantId, async (client) => {
      for (const subject of batch) {
        const text = texts.get(subject.name);
        if (!text) { failed.push(subject); continue; }
        await client.query(`INSERT INTO graph.description_reviews(tenant_id,source_id,qualified_name,field_name,drafted_text,drafted_by,input_hash) VALUES($1,$2,$3,'',$4,'model',$5)
          ON CONFLICT(tenant_id,source_id,qualified_name,field_name) DO UPDATE SET drafted_text=EXCLUDED.drafted_text,drafted_by='model',drafted_at=clock_timestamp(),input_hash=EXCLUDED.input_hash
          WHERE graph.description_reviews.status='draft'`, [input.tenantId, input.connectionId, subject.name, text, inputHash(subject)]);
        result.drafted++;
      }
    });
  }
  // An object that changed but could not be redrafted falls back to the template rather than show an outdated draft.
  const stale = failed.filter((subject) => state.drafts.has(subject.name)).map((subject) => subject.name);
  if (stale.length) await withTenant(pool, input.tenantId, (client) => client.query(`DELETE FROM graph.description_reviews WHERE tenant_id=$1 AND source_id=$2 AND field_name='' AND status='draft' AND drafted_by='model' AND qualified_name=ANY($3::text[])`,
    [input.tenantId, input.connectionId, stale]));
  result.kept = failed.length;
  return result;
}

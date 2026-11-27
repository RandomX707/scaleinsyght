import type { Pool } from 'pg';
import type { EncryptedArtifactStore } from '@scaleinsyght/artifacts';
import { connectionQueryTimeout, createExcelConnector, createPostgresConnector, createSqlServerConnector, decryptConnectionSecret, type ReadOnlyConnector } from '@scaleinsyght/connectors';
import { withTenant } from '@scaleinsyght/db';
import { readWorkbook } from './index.js';

/** Builds the read-only connector for one stored connection, for scheduled refreshes outside a request. Credentials
 * are decrypted in memory for this connector only; a workbook is decrypted from the artifact store. */
export async function connectorForConnection(pool: Pool, tenantId: string, connectionId: string, artifactStore?: EncryptedArtifactStore): Promise<ReadOnlyConnector> {
  const saved = await withTenant(pool, tenantId, (client) => client.query<{ connector_type: string; display_name: string; status: string; profile_query_timeout_ms: number | null; ciphertext: Buffer | null; nonce: Buffer | null; auth_tag: Buffer | null }>(
    `SELECT c.connector_type,c.display_name,c.status,c.profile_query_timeout_ms,s.ciphertext,s.nonce,s.auth_tag FROM registry.connections c
     LEFT JOIN LATERAL(SELECT ciphertext,nonce,auth_tag FROM registry.connection_secrets WHERE tenant_id=c.tenant_id AND connection_id=c.connection_id ORDER BY secret_version DESC LIMIT 1)s ON true
     WHERE c.tenant_id=$1 AND c.connection_id=$2`, [tenantId, connectionId]));
  const row = saved.rows[0];
  if (!row || row.status !== 'active') throw new Error('connection_not_active');
  const statementTimeoutMs = connectionQueryTimeout('profile', row.profile_query_timeout_ms);
  if (row.connector_type === 'excel') {
    if (!artifactStore) throw new Error('artifact_store_unavailable');
    const latest = await withTenant(pool, tenantId, (client) => client.query<{ artifact_id: string }>('SELECT artifact_id FROM artifacts.workbooks WHERE tenant_id=$1 AND connection_id=$2 ORDER BY created_at DESC LIMIT 1', [tenantId, connectionId]));
    const artifactId = latest.rows[0]?.artifact_id; if (!artifactId) throw new Error('excel_workbook_not_uploaded');
    return createExcelConnector({ statementTimeoutMs, id: connectionId, name: row.display_name || 'Workbook', workbook: await readWorkbook(pool, artifactStore, { tenantId, connectionId, artifactId }) });
  }
  if (!['postgres', 'sql_server'].includes(row.connector_type) || !row.ciphertext || !row.nonce || !row.auth_tag) throw new Error('source_connection_requires_credentials');
  const sealed = { version: 1 as const, ciphertext: row.ciphertext.toString('base64'), nonce: row.nonce.toString('base64'), authTag: row.auth_tag.toString('base64') };
  if (row.connector_type === 'sql_server') {
    const secret = decryptConnectionSecret<{ host: string; port: number; database: string; username: string; password: string; trustServerCertificate: boolean }>(sealed);
    return createSqlServerConnector({ server: secret.host, port: secret.port, database: secret.database, username: secret.username, password: secret.password, encrypt: true, trustServerCertificate: secret.trustServerCertificate, statementTimeoutMs, id: connectionId, name: row.display_name || 'SQL Server source', maxRows: 1_000 });
  }
  const secret = decryptConnectionSecret<{ host: string; port: number; database: string; username: string; password: string; sslMode: string }>(sealed);
  const url = new URL('postgresql://placeholder'); url.hostname = secret.host; url.port = String(secret.port); url.username = secret.username; url.password = secret.password; url.pathname = `/${secret.database}`; url.searchParams.set('sslmode', secret.sslMode);
  return createPostgresConnector({ connectionString: url.toString(), statementTimeoutMs, id: connectionId, name: row.display_name || 'PostgreSQL source', maxRows: 1_000 });
}

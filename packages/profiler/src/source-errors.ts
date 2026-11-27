/**
 * Turns a source error into a stable reason code (bug 6), so a failed profile says why in plain language and the logs
 * name the cause. Codes only: messages from a driver can contain host names or user names and are never stored.
 */
const KNOWN = new Set([
  'postgres_connector_role_not_read_only', 'sqlserver_connector_role_not_read_only', 'artifact_file_missing', 'source_connection_requires_credentials',
  'excel_workbook_not_uploaded', 'excel_workbook_not_xlsx', 'excel_workbook_size_invalid', 'excel_workbook_has_no_header_rows', 'postgres_connector_result_limit_exceeded',
]);

export function sourceErrorCode(error: unknown): string {
  const failure = error as { code?: unknown; message?: unknown; originalError?: { code?: unknown } } | null;
  const code = String(failure?.code ?? failure?.originalError?.code ?? '');
  const message = String(failure?.message ?? '');
  if (KNOWN.has(message)) return message;
  if (/^source_[a-z_]+$/.test(message)) return message;
  if (code === 'SOURCE_QUERY_TIMEOUT' || code === '57014' || code === 'ETIMEOUT' || /canceling statement due to statement timeout|request timed out|timeout: request failed/i.test(message)) return 'source_query_timeout';
  if (code === '42501' || /permission denied/i.test(message)) return 'source_permission_denied';
  if (code === '42P01' || code === '42P02') return 'source_object_missing';
  if (/^22/.test(code)) return 'source_object_unreadable';
  if (code === '28P01' || code === '28000' || code === 'ELOGIN' || /password authentication failed|login failed/i.test(message)) {
    if (/no pg_hba\.conf entry.*(no encryption|SSL off)/i.test(message)) return 'source_ssl_required';
    return 'source_login_failed';
  }
  if (code === '3D000') return 'source_database_not_found';
  if (/does not support SSL|server does not support ssl/i.test(message)) return 'source_ssl_not_supported';
  if (/self[- ]signed certificate|unable to verify the first certificate|certificate has expired|hostname\/IP does not match/i.test(message)) return 'source_certificate_rejected';
  if (['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'ECONNRESET', 'ESOCKET', 'EAI_AGAIN'].includes(code)
    || /Connection terminated|timeout exceeded when trying to connect|connect ETIMEDOUT|getaddrinfo/i.test(message)) return 'source_unreachable';
  return 'discovery_failed';
}

/** Errors that concern one object only: the profile records it and carries on with the others. */
export function isObjectError(code: string): boolean {
  return ['source_query_timeout', 'source_permission_denied', 'source_object_missing', 'source_object_unreadable'].includes(code);
}

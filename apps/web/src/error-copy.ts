/**
 * Errors are shown to people in plain language, never as raw codes such as "connection draft not found" (decision 57).
 * Known codes have their own sentence; anything else gets a general sentence by kind. The code stays on the error for
 * logs and tests.
 */
const COPY: Record<string, string> = {
  connection_not_found: 'This connection no longer exists. Refresh the page and add it again.',
  connection_draft_not_found: 'This connection no longer exists. Refresh the page and add it again.',
  connection_retired: 'This connection was removed. Add it again to profile it.',
  connection_test_failed: 'The connection test failed. Check the host, port, database, user name and password.',
  connector_allowance_exceeded: 'Your plan’s connector allowance is used up. Remove a connector or ask your administrator for more.',
  postgres_connector_role_not_read_only: 'This PostgreSQL login can change data. Use a read-only login.',
  sqlserver_connector_role_not_read_only: 'This SQL Server login can change data. Use a read-only login.',
  postgres_credentials_invalid: 'Some connection details are missing or invalid. Check them and try again.',
  sqlserver_credentials_invalid: 'Some connection details are missing or invalid. Check them and try again.',
  source_connection_requires_credentials: 'Enter the connection details before testing.',
  postgres_connection_string_required: 'Enter the connection details before testing.',
  excel_workbook_not_uploaded: 'Upload the workbook before continuing.',
  excel_workbook_not_xlsx: 'The file is not an Excel workbook (.xlsx).',
  excel_workbook_size_invalid: 'The workbook is empty or too large.',
  excel_workbook_has_no_header_rows: 'The workbook has no header rows to read.',
  connection_name_invalid: 'Enter a name for this connection.',
  connector_type_unsupported: 'This connector type is not supported.',
  artifact_store_unavailable: 'File storage is not available right now. Try again later.',
  tenant_admin_required: 'Only an administrator can do this.',
  second_member_required: 'A different member must approve this.',
  analytic_request_in_progress: 'This question is still being answered.',
};

export function errorCopy(code: string | undefined): string {
  if (!code) return 'The request could not be completed. Try again.';
  if (COPY[code]) return COPY[code]!;
  if (!/^[a-z0-9_]+$/.test(code)) return code; // already a sentence written for people
  if (code.endsWith('_not_found')) return 'That item could not be found. Refresh the page and try again.';
  if (code.startsWith('invalid_') || code.endsWith('_invalid') || code.endsWith('_required')) return 'Some details are missing or invalid. Check them and try again.';
  return 'Something went wrong. Try again, and if it keeps happening, tell your administrator.';
}

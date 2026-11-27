/** Ceiling for catalog listings (tables, columns, keys, view and routine definitions): names only, sized for large
 * enterprise catalogs. Data reads keep their own, much lower row limit. */
export const CATALOG_ROW_LIMIT = 200_000;

export type SourceTimeoutOptions = { connectTimeoutMs?: number; statementTimeoutMs?: number };

export function sourceTimeouts(options: SourceTimeoutOptions = {}) {
  const read = (value: number | undefined, env: string, fallback: number) => {
    const configured = value ?? Number(process.env[env] ?? fallback);
    if (!Number.isInteger(configured) || configured < 1 || configured > 2_147_483_647) {
      throw new Error(`invalid_source_timeout:${env}`);
    }
    return configured;
  };
  return {
    connect: read(options.connectTimeoutMs, 'SOURCE_CONNECT_TIMEOUT_MS', 5_000),
    query: read(options.statementTimeoutMs, 'SOURCE_QUERY_TIMEOUT_MS', 10_000),
  };
}

export function withSourceDeadline<T>(operation: Promise<T>, ms: number, reason: string, cancel?: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(reason));
      try { cancel?.(); } catch { /* The caller deadline holds even if driver cancellation fails. */ }
    }, ms);
    operation.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

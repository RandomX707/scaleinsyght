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
    connect: read(options.connectTimeoutMs, 'SOURCE_CONNECT_TIMEOUT_MS', 10_000),
    query: read(options.statementTimeoutMs, 'SOURCE_QUERY_TIMEOUT_MS', 10_000),
  };
}

/** An explicit connection setting wins over the workload-specific and legacy deployment settings. */
export function connectionConnectTimeout(override: number | null): number {
  return sourceTimeouts(override === null ? {} : { connectTimeoutMs: override }).connect;
}

export function connectionQueryTimeout(workload: 'profile' | 'analytic', override: number | null): number {
  const configured = override ?? Number(process.env[workload === 'profile'
    ? 'SOURCE_PROFILE_QUERY_TIMEOUT_MS' : 'SOURCE_ANALYTIC_QUERY_TIMEOUT_MS'] ?? process.env.SOURCE_QUERY_TIMEOUT_MS ?? (workload === 'profile' ? 60_000 : 30_000));
  return sourceTimeouts({ statementTimeoutMs: configured }).query;
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

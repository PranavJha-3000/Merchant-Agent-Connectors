/**
 * Authentication abstraction.
 *
 * Common infra owns: the interface, credential loading/validation surfaces,
 * and redaction guarantees. Provider modules own: exact header construction,
 * token exchange, refresh, and any provider-specific quirk. See AGENTS.md §8.
 *
 * V1 keeps token state in memory only — never persisted to disk.
 */

export interface AuthStrategy {
  /** Human-readable mechanism name, safe to log (e.g. 'basic-api-key'). */
  readonly kind: string;
  /** Headers to attach to each request. May perform I/O (token refresh). */
  headers(): Promise<Record<string, string>> | Record<string, string>;
  /**
   * Optional single-shot refresh hook. Called by the HTTP layer after a 401.
   * Returns true if a refresh was performed and the request should be replayed
   * once; false/undefined means the 401 is final (bad key / revoked grant).
   */
  refresh?(): Promise<boolean>;
}

/** HTTP Basic header value: base64(`${user}:${pass}`). */
export function basicAuthHeader(user: string, password: string): string {
  const encoded = Buffer.from(`${user}:${password}`, 'utf8').toString('base64');
  return `Basic ${encoded}`;
}

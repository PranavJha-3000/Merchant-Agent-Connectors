/**
 * Shared pagination value objects.
 *
 * Design choice: one page envelope shape across providers so agents can page
 * without provider-specific fiddling, while `total` stays nullable because not
 * every upstream reports a total (Freshdesk list does not; search does).
 */

export interface PageRequest {
  /** 1-indexed page number (all four target providers use 1-based pages). */
  page: number;
  perPage: number;
}

export interface PageEnvelope<T> {
  items: T[];
  page: number;
  perPage: number;
  /** True when a next page exists per the upstream's own signal (never a guess). */
  hasMore: boolean;
  /** Total matching records when the upstream reports one; null when unknown. */
  total: number | null;
}

/**
 * Parse an RFC-compliant `Link` response header and return the URL marked
 * `rel="next"`, if any. Freshdesk sets:
 *   link: <https://domain.freshdesk.com/api/v2/tickets?filter=all_tickets&page=2>;rel="next"
 * Verified: https://developers.freshdesk.com/api/ (Pagination section).
 */
export function parseLinkHeaderNext(header: string | null | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="next"/i.exec(part.trim());
    if (match && match[1]) return match[1];
  }
  return null;
}

/** `hasMore` from an explicit total (search-style endpoints). */
export function hasMoreFromTotal(total: number, page: number, perPage: number): boolean {
  return total > page * perPage;
}

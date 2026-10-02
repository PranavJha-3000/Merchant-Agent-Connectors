import { describe, expect, it } from 'vitest';
import {
  computeBackoffMs,
  DEFAULT_RETRY_POLICY,
  isRetryableStatus,
  parseRetryAfterMs,
} from '../../src/core/retry.ts';

describe('parseRetryAfterMs', () => {
  it('parses delta-seconds', () => {
    expect(parseRetryAfterMs('2')).toBe(2_000);
    expect(parseRetryAfterMs('0')).toBe(0);
    expect(parseRetryAfterMs(' 45 ')).toBe(45_000);
  });

  it('parses HTTP-date relative to now', () => {
    const now = Date.parse('2026-10-02T10:00:00Z');
    expect(parseRetryAfterMs('Thu, 02 Oct 2026 10:00:30 GMT', now)).toBe(30_000);
    // Past dates clamp to zero instead of going negative.
    expect(parseRetryAfterMs('Thu, 02 Oct 2026 09:00:00 GMT', now)).toBe(0);
  });

  it('returns undefined for absent or garbage values', () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs('')).toBeUndefined();
    expect(parseRetryAfterMs('soon')).toBeUndefined();
  });
});

describe('computeBackoffMs', () => {
  const policy = DEFAULT_RETRY_POLICY;

  it('grows exponentially with attempt and respects jitter bounds', () => {
    const d1 = computeBackoffMs(1, policy, { random: () => 0 });
    const d2 = computeBackoffMs(2, policy, { random: () => 0 });
    expect(d1).toBe(250);
    expect(d2).toBe(500);
    const jittered = computeBackoffMs(1, policy, { random: () => 1 });
    expect(jittered).toBe(250 + 250);
  });

  it('caps at maxDelayMs', () => {
    const delay = computeBackoffMs(10, policy, { random: () => 0 });
    expect(delay).toBe(policy.maxDelayMs);
  });

  it('lets Retry-After override the computed delay', () => {
    expect(computeBackoffMs(1, policy, { retryAfterMs: 7_000 })).toBe(7_000);
  });

  it('bounds Retry-After at maxRetryAfterMs', () => {
    expect(computeBackoffMs(1, policy, { retryAfterMs: 10 * 60_000 })).toBe(policy.maxRetryAfterMs);
  });
});

describe('isRetryableStatus — the documented retry matrix', () => {
  it.each([
    [400, false],
    [401, false],
    [403, false],
    [404, false],
    [408, true],
    [409, false],
    [422, false],
    [429, true],
    [500, true],
    [502, true],
    [503, true],
    [504, true],
  ] as const)('status %i → retryable %s', (status, expected) => {
    expect(isRetryableStatus(status)).toBe(expected);
  });
});

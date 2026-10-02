import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Portability/hygiene guards for the reviewer-facing entrypoints.
 *
 * Rationale: the demo and inspect script are printed to arbitrary terminals and
 * CI logs. Non-ASCII glyphs and mojibake make transcripts unreliable, and
 * PowerShell round-trips can silently corrupt UTF-8. Keep those outputs ASCII.
 */

const ENTRYPOINTS = ['scripts/inspectTools.ts', 'src/demo/runDemo.ts'] as const;

function read(rel: string): string {
  return readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
}

describe('entrypoint output portability', () => {
  for (const rel of ENTRYPOINTS) {
    it(`${rel} source contains no corrupted characters`, () => {
      expect(read(rel)).not.toContain('\uFFFD');
    });

    it(`${rel} writes ASCII-only output`, () => {
      const output = execFileSync(process.execPath, [rel], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      expect(output.length).toBeGreaterThan(0);
      // eslint-disable-next-line no-control-regex
      const nonAscii = output.replace(/[\t\n\r]/g, '').match(/[^\x20-\x7E]/g) ?? [];
      expect([...new Set(nonAscii)].join('')).toBe('');
    });
  }

  it('the demo runs to completion through every step (guards against exiting mid-operation)', () => {
    // Regression guard: an unref'd backoff timer once let the process exit
    // silently after the 429 step, producing truncated output with exit code 0.
    const output = execFileSync(process.execPath, ['src/demo/runDemo.ts'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (let step = 1; step <= 10; step += 1) {
      expect(output, `demo stopped before STEP ${step}`).toContain(`STEP ${step} |`);
    }
    expect(output).toContain('DEMO COMPLETE');
    // The 429 step must show the retry and the recovery sharing one correlation id.
    expect(output).toContain('"msg":"http_retry"');
    expect(output).toContain('"msg":"http_success"');
    expect(output).toContain('"rateLimited":true');
    // ...and the exhausted case must report the wait instead of sleeping it off.
    expect(output).toContain('"code": "RATE_LIMITED"');
    expect(output).toContain('"retryAfterMs": 3600000');
    expect(output).toContain('"code": "AUTHENTICATION_ERROR"');
    expect(output).toContain('"code": "NOT_FOUND"');
    // The second provider must be exercised through the exact same pipeline.
    expect(output).toContain('STEP 9 |');
    expect(output).toContain('"provider": "woocommerce"');
    expect(output).toContain('"code": "processing"');
  });
});
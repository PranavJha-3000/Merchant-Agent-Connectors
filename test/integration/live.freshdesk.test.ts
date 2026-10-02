import { describe, expect, it } from 'vitest';
import { executeToolDefinition } from '../../src/core/tools.ts';
import { freshdeskTools } from '../helpers.ts';

/**
 * Optional live tests — NEVER required for CI.
 * Run only when intentionally configured:
 *   FRESHDESK_DOMAIN=... FRESHDESK_API_KEY=... npx vitest run test/integration
 */
const liveEnabled = Boolean(process.env['FRESHDESK_DOMAIN'] && process.env['FRESHDESK_API_KEY']);

describe.skipIf(!liveEnabled)('live Freshdesk (opt-in)', () => {
  it('lists one page of real tickets read-only', async () => {
    const { byName } = freshdeskTools(); // fixture tools here; build live below
    // Build live-mode tools explicitly:
    const { buildConnectorTools } = await import('../../src/mcp/server.ts');
    const { createJsonLogger } = await import('../../src/core/logger.ts');
    const bundles = buildConnectorTools({
      mode: 'live',
      logger: createJsonLogger({ minLevel: 'warn' }),
      env: process.env,
    });
    const liveTool = bundles[0]!.tools.find((t) => t.name === 'freshdesk_list_tickets')!;
    const result = await executeToolDefinition(liveTool, { perPage: 1 });
    if (result.isError) throw new Error(result.content[0]!.text);
    const data = result.structuredContent as { provider: string; items: unknown[] };
    expect(data.provider).toBe('freshdesk');
    expect(Array.isArray(data.items)).toBe(true);
    expect(byName.has('freshdesk_list_tickets')).toBe(true);
  });
});

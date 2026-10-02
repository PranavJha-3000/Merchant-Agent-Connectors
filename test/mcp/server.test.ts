import { describe, expect, it } from 'vitest';
import { createConnectorServer } from '../../src/mcp/server.ts';
import { createMemoryLogger } from '../../src/core/logger.ts';
import { connectMcp } from '../helpers.ts';

/**
 * Protocol-level MCP tests through the real SDK (InMemoryTransport):
 * registration, discovery, input validation, structured output, error results.
 */

describe('MCP server (stdio-agnostic, in-memory protocol)', () => {
  it('lists exactly the shipped Freshdesk tools with descriptions and read-only annotations', async () => {
    const server = createConnectorServer({ mode: 'fixture', logger: createMemoryLogger(), env: {} });
    const client = await connectMcp(server);
    const res = await client.request('tools/list');
    await client.close();

    expect(res.error).toBeUndefined();
    const tools = (res.result as { tools: Array<Record<string, unknown>> }).tools;
    const names = tools.map((t) => t['name']).sort();
    expect(names).toEqual([
      'freshdesk_get_ticket',
      'freshdesk_list_ticket_conversations',
      'freshdesk_list_tickets',
      'freshdesk_search_tickets',
    ]);
    for (const tool of tools) {
      expect(String(tool['description']).length).toBeGreaterThan(80);
      const annotations = tool['annotations'] as Record<string, unknown>;
      expect(annotations['readOnlyHint']).toBe(true);
      expect(annotations['destructiveHint']).toBe(false);
      // input + output schemas are advertised for the host
      expect(tool['inputSchema']).toBeTruthy();
      expect(tool['outputSchema']).toBeTruthy();
    }
  });

  it('executes a tool and returns SDK-validated structuredContent', async () => {
    const server = createConnectorServer({ mode: 'fixture', logger: createMemoryLogger(), env: {} });
    const client = await connectMcp(server);
    const res = await client.request('tools/call', {
      name: 'freshdesk_get_ticket',
      arguments: { ticketId: 101 },
    });
    await client.close();

    expect(res.error).toBeUndefined();
    const result = res.result as { isError?: boolean; structuredContent?: Record<string, unknown> };
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.['provider']).toBe('freshdesk');
    expect((result.structuredContent?.['ticket'] as Record<string, unknown>)['id']).toBe(101);
  });

  it('returns isError:true (no structuredContent) for upstream failures', async () => {
    const server = createConnectorServer({ mode: 'fixture', logger: createMemoryLogger(), env: {} });
    const client = await connectMcp(server);
    const res = await client.request('tools/call', {
      name: 'freshdesk_get_ticket',
      arguments: { ticketId: 999999 },
    });
    await client.close();

    const result = res.result as { isError?: boolean; structuredContent?: unknown; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect(payload['code']).toBe('NOT_FOUND');
    expect(payload['retryable']).toBe(false);
  });

  it('rejects invalid arguments without reaching the network', async () => {
    const server = createConnectorServer({ mode: 'fixture', logger: createMemoryLogger(), env: {} });
    const client = await connectMcp(server);
    const res = await client.request('tools/call', {
      name: 'freshdesk_get_ticket',
      arguments: { ticketId: -1 },
    });
    await client.close();

    // Either surface (SDK validation error or our isError envelope) must be an error result.
    const result = res.result as { isError?: boolean; content: Array<{ text: string }> };
    const asError = res.error ?? result;
    expect(asError).toBeTruthy();
    if (!res.error) expect(result.isError).toBe(true);
    const text = res.error ? res.error.message : result.content[0]!.text;
    expect(text).toMatch(/Input validation error|VALIDATION_ERROR|Invalid arguments/);
  });
});

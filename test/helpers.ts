import { InMemoryTransport, LATEST_PROTOCOL_VERSION, type McpServer } from '@modelcontextprotocol/server';
import type { FetchLike } from '../src/core/http.ts';
import { createMemoryLogger, type MemoryLogger } from '../src/core/logger.ts';
import type { ToolDefinition } from '../src/core/tools.ts';
import { buildConnectorTools } from '../src/mcp/server.ts';
import { freshdeskModule } from '../src/providers/freshdesk/manifest.ts';

/** Build Freshdesk tools against fixtures (default) or an injected fetch, with a memory logger. */
export function freshdeskTools(options: { fetchImpl?: FetchLike } = {}): {
  tools: ToolDefinition[];
  byName: Map<string, ToolDefinition>;
  logger: MemoryLogger;
} {
  const logger = createMemoryLogger();
  const opts = {
    modules: [freshdeskModule],
    mode: 'fixture' as const,
    logger,
    env: {},
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  };
  const bundles = buildConnectorTools(opts);
  const tools = bundles[0]!.tools;
  return { tools, byName: new Map(tools.map((t) => [t.name, t])), logger };
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * Minimal raw MCP client over InMemoryTransport: initialize handshake +
 * request/response correlation. Proves registration/serialization through the
 * real SDK without needing a separate client package.
 */
export async function connectMcp(server: McpServer): Promise<{
  request: (method: string, params?: unknown) => Promise<JsonRpcResponse>;
  notify: (method: string, params?: unknown) => Promise<void>;
  close: () => Promise<void>;
}> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await clientTransport.start();

  let nextId = 1;
  const pending = new Map<number, (msg: JsonRpcResponse) => void>();
  clientTransport.onmessage = (message) => {
    const msg = message as JsonRpcResponse;
    if (typeof msg.id === 'number') {
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  };

  const request = (method: string, params?: unknown): Promise<JsonRpcResponse> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      void clientTransport
        .send({ jsonrpc: '2.0', id, method, params } as never)
        .catch((e: unknown) => {
          pending.delete(id);
          reject(e);
        });
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`request timed out: ${method}`));
      }, 5_000);
    });

  const notify = async (method: string, params?: unknown): Promise<void> => {
    await clientTransport.send({ jsonrpc: '2.0', method, params } as never);
  };

  const init = await request('initialize', {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' },
  });
  if (init.error) throw new Error(`initialize failed: ${init.error.message}`);
  await notify('notifications/initialized');

  return { request, notify, close: () => clientTransport.close() };
}

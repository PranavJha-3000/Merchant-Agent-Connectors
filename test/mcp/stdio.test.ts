import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * End-to-end stdio transport test: spawns the real entrypoint
 * (src/mcp/mainStdio.ts) and speaks JSON-RPC over its stdin/stdout.
 *
 * This is the strongest available proof that the server works as a host would
 * actually launch it - with no SDK helpers and no credentials.
 */

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

const ENTRYPOINT = fileURLToPath(new URL('../../src/mcp/mainStdio.ts', import.meta.url));

function startServer(): {
  request: (method: string, params?: unknown) => Promise<JsonRpcMessage>;
  notify: (method: string) => Promise<void>;
  stop: () => void;
  stderr: () => string;
} {
  const child = spawn(process.execPath, ['--env-file-if-exists=.env', ENTRYPOINT], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
  });

  let stdoutBuffer = '';
  let stderrText = '';
  const waiting = new Map<number, (msg: JsonRpcMessage) => void>();

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdoutBuffer += chunk;
    let newline = stdoutBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line.length > 0) {
        try {
          const msg = JSON.parse(line) as JsonRpcMessage;
          if (typeof msg.id === 'number') {
            const resolve = waiting.get(msg.id);
            if (resolve) {
              waiting.delete(msg.id);
              resolve(msg);
            }
          }
        } catch {
          // ignore non-JSON noise; the assertions below will surface real failures
        }
      }
      newline = stdoutBuffer.indexOf('\n');
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderrText += chunk;
  });

  let nextId = 1;
  const send = (payload: Record<string, unknown>): Promise<void> =>
    new Promise((resolve) => child.stdin.write(`${JSON.stringify(payload)}\n`, () => resolve()));

  const request = async (method: string, params?: unknown): Promise<JsonRpcMessage> => {
    const id = nextId++;
    const promise = new Promise<JsonRpcMessage>((resolve, reject) => {
      waiting.set(id, resolve);
      setTimeout(() => {
        if (waiting.delete(id)) reject(new Error(`stdio request timed out: ${method}. stderr: ${stderrText}`));
      }, 10_000);
    });
    await send({ jsonrpc: '2.0', id, method, params });
    return promise;
  };

  return {
    request,
    notify: (method: string) => send({ jsonrpc: '2.0', method, params: {} }),
    stop: () => child.kill(),
    stderr: () => stderrText,
  };
}

describe('stdio entrypoint (spawned process, real transport)', () => {
  it('completes the handshake, lists tools, and executes a call', async () => {
    const server = startServer();
    try {
      const init = await server.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'stdio-e2e', version: '0.0.1' },
      });
      expect(init.error).toBeUndefined();
      expect((init.result as { serverInfo: { name: string } }).serverInfo.name).toBe('merchant-agent-connectors');

      await server.notify('notifications/initialized');

      const list = await server.request('tools/list');
      const tools = (list.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
      expect(tools).toContain('freshdesk_search_tickets');
      expect(tools).toContain('woocommerce_list_orders');
      expect(tools).toContain('zoho_list_items'); // the OAuth provider is reachable over stdio too
      expect(tools).toHaveLength(12); // 4 Freshdesk + 4 WooCommerce + 4 Zoho Inventory

      const call = await server.request('tools/call', {
        name: 'freshdesk_get_ticket',
        arguments: { ticketId: 101 },
      });
      const result = call.result as { isError?: boolean; structuredContent?: { ticket: { id: number } } };
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent?.ticket.id).toBe(101);
    } finally {
      server.stop();
    }
  }, 25_000);

  it('fails fast on invalid live configuration without leaking values', async () => {
    const server = startServer();
    // Not initialized: instead, assert the process reports configuration errors
    // through its stderr path when forced into live mode without credentials.
    const liveChild = spawn(process.execPath, [ENTRYPOINT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      env: { ...process.env, CONNECTOR_MODE: 'live', FRESHDESK_API_KEY: '', FRESHDESK_DOMAIN: '' },
    });
    let stderrText = '';
    liveChild.stderr.setEncoding('utf8');
    liveChild.stderr.on('data', (chunk: string) => {
      stderrText += chunk;
    });
    const exitCode = await new Promise<number>((resolve) => {
      liveChild.on('exit', (code) => resolve(code ?? -1));
      // Trigger the server factory by sending initialize; the factory throws first.
      liveChild.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
      setTimeout(() => liveChild.kill(), 8_000);
    });
    expect(exitCode).toBe(1);
    expect(stderrText).toContain('FRESHDESK_DOMAIN');
    expect(stderrText).not.toContain('undefined');
    server.stop();
  }, 25_000);
});
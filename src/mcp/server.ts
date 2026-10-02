import { McpServer } from '@modelcontextprotocol/server';
import type { FetchLike } from '../core/http.ts';
import type { Logger } from '../core/logger.ts';
import type { ConnectorMode, ProviderModule } from '../core/registry.ts';
import { assertUniqueModules } from '../core/registry.ts';
import { executeToolDefinition, type ToolDefinition } from '../core/tools.ts';
import { providerModules } from '../providers/index.ts';

/**
 * MCP server factory — the ONLY module that imports the MCP SDK.
 *
 * Provider modules hand over ToolDefinitions (name, zod schemas, description,
 * annotations, handler); this layer maps them 1:1 onto SDK registerTool calls
 * and routes results through executeToolDefinition, which guarantees:
 *   success → structuredContent validated against outputSchema
 *   failure → isError:true with an agent-safe JSON payload and NO
 *             structuredContent (matching the SDK's validation contract:
 *             structuredContent is required on success, skipped on isError).
 *
 * Providers never see MCP types (AGENTS.md §7); this layer never sees HTTP.
 */

export interface ConnectorServerOptions {
  modules?: readonly ProviderModule[];
  mode?: ConnectorMode;
  logger: Logger;
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  name?: string;
  version?: string;
}

export interface ConnectorToolBundle {
  module: ProviderModule;
  tools: ToolDefinition[];
}

/** Build all tools for the selected providers (eager config validation, no network). */
export function buildConnectorTools(options: ConnectorServerOptions): ConnectorToolBundle[] {
  const modules = options.modules ?? providerModules;
  const mode: ConnectorMode = options.mode ?? (options.env?.['CONNECTOR_MODE'] === 'live' ? 'live' : 'fixture');
  const env = options.env ?? process.env;
  assertUniqueModules(modules);
  return modules.map((module) => ({
    module,
    tools: module.buildTools({ mode, logger: options.logger, env, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) }),
  }));
}

export function createConnectorServer(options: ConnectorServerOptions): McpServer {
  const server = new McpServer({
    name: options.name ?? 'merchant-agent-connectors',
    version: options.version ?? '0.1.0',
  });

  for (const bundle of buildConnectorTools(options)) {
    for (const tool of bundle.tools) {
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema,
          annotations: tool.annotations,
        },
        async (args) => executeToolDefinition(tool, args),
      );
    }
  }

  return server;
}

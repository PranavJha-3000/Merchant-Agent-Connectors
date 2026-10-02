import type { FetchLike } from './http.ts';
import type { Logger } from './logger.ts';
import type { ToolDefinition } from './tools.ts';

/**
 * Provider registry (plugin mechanism).
 *
 * There is deliberately NO central `ProviderId` union in core. A provider is a
 * self-contained module exporting a ProviderModule; the only shared file that
 * knows about concrete providers is src/providers/index.ts (the registration
 * list). Adding a provider = new folder under src/providers/ + one line there.
 * Enforced by test/unit/registry.test.ts + test/unit/boundaries.test.ts
 * (AGENTS.md §5, §18).
 */

export type ConnectorMode = 'fixture' | 'live';

export interface ProviderBuildContext {
  /** 'fixture' = zero-credential deterministic mode (default). 'live' = real upstream. */
  mode: ConnectorMode;
  logger: Logger;
  env: Record<string, string | undefined>;
  /** Override the fetch implementation (fixtures/tests). Ignored when the module supplies its own. */
  fetchImpl?: FetchLike;
}

export interface ProviderModule {
  /** Stable machine id, e.g. 'freshdesk'. Used in tool names, logs, error payloads. */
  readonly id: string;
  readonly displayName: string;
  /** Capability tokens for docs/matrix, e.g. 'tickets.list'. Must reflect real upstream support. */
  readonly capabilities: readonly string[];
  /** Environment variables this provider requires in live mode (never their values). */
  readonly configKeys: readonly string[];
  /** Build the provider's MCP tools. Throws ConfigurationError before any network I/O when live config is missing/invalid. */
  buildTools(ctx: ProviderBuildContext): ToolDefinition[];
}

/** Fail fast on duplicate ids — a silent overwrite would shadow a provider. */
export function assertUniqueModules(modules: readonly ProviderModule[]): void {
  const seen = new Set<string>();
  for (const m of modules) {
    if (seen.has(m.id)) {
      throw new Error(`Duplicate provider module id: ${m.id}`);
    }
    seen.add(m.id);
  }
}

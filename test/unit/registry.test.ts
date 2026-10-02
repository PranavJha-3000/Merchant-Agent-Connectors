import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertUniqueModules, type ProviderModule } from '../../src/core/registry.ts';
import { createMemoryLogger } from '../../src/core/logger.ts';
import { buildConnectorTools } from '../../src/mcp/server.ts';
import { providerModules } from '../../src/providers/index.ts';

describe('provider registry', () => {
  it('registers each provider exactly once with unique ids', () => {
    expect(() => assertUniqueModules(providerModules)).not.toThrow();
    const ids = providerModules.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('fixture mode builds tools without credentials or network', () => {
    const bundles = buildConnectorTools({ modules: providerModules, mode: 'fixture', logger: createMemoryLogger(), env: {} });
    expect(bundles.length).toBeGreaterThan(0);
    for (const bundle of bundles) {
      expect(bundle.tools.length).toBeGreaterThan(0);
    }
  });

  it('live mode fails fast with ConfigurationError naming missing keys (no values)', () => {
    expect(() =>
      buildConnectorTools({ modules: providerModules, mode: 'live', logger: createMemoryLogger(), env: {} }),
    ).toThrowError(/FRESHDESK_DOMAIN, FRESHDESK_API_KEY/);
  });

  it('docs/provider-matrix.md lists every registered provider (docs cannot drift from code)', () => {
    const matrix = readFileSync(new URL('../../docs/provider-matrix.md', import.meta.url), 'utf8');
    for (const m of providerModules) {
      expect(matrix, `provider ${m.id} missing from docs/provider-matrix.md`).toContain(`| \`${m.id}\``);
    }
  });

  it('rejects duplicate provider ids', () => {
    const dup: ProviderModule = providerModules[0]!;
    expect(() => assertUniqueModules([dup, dup])).toThrowError(/Duplicate provider module id/);
  });
});

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Architectural boundaries, enforced mechanically (AGENTS.md §5).
 *
 * These rules are the whole point of the "extensible without touching shared
 * code" claim. A comment is not enforcement, so the rules are asserted here:
 * a violation fails the suite instead of being caught in review - or never.
 *
 * Enforced:
 *   1. src/core/** never imports src/providers/** or src/mcp/**
 *   2. src/providers/<a>/** never imports another provider, nor the MCP SDK
 *   3. only src/providers/index.ts imports concrete provider manifests
 *   4. only src/mcp/** imports the MCP SDK
 *   5. sources stay runnable under Node's strip-only TypeScript mode
 *      (no parameter properties, no runtime enums, no `import x = require()`)
 */

const repoRoot = new URL('../../', import.meta.url);
const srcRoot = new URL('src/', repoRoot);

function tsFilesIn(dir: URL): URL[] {
  const out: URL[] = [];
  for (const entry of readdirSync(dir)) {
    const child = new URL(entry, dir);
    // Recurse with an explicit trailing slash: without it, relative specifiers
    // would resolve against the PARENT directory.
    if (statSync(fileURLToPath(child)).isDirectory()) out.push(...tsFilesIn(new URL(`${entry}/`, dir)));
    else if (entry.endsWith('.ts')) out.push(child);
  }
  return out;
}

function rel(url: URL): string {
  return fileURLToPath(url).replace(fileURLToPath(repoRoot), '').replace(/\\/g, '/');
}

/** All `import`/`from '...'` module specifiers in a file (static + type-only). */
function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const re = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) specs.push(m[1]!);
  const bare = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
  while ((m = bare.exec(source)) !== null) specs.push(m[1]!);
  return specs;
}

/** Remove comments so doc text is never mistaken for a code reference. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const allSourceFiles = tsFilesIn(srcRoot);
const coreFiles = allSourceFiles.filter((f) => rel(f).startsWith('src/core/'));
const providerFiles = allSourceFiles.filter((f) => rel(f).startsWith('src/providers/'));
const mcpFiles = allSourceFiles.filter((f) => rel(f).startsWith('src/mcp/'));

describe('architectural boundaries (AGENTS.md §5)', () => {
  it('has the expected file counts (guards the globbing itself)', () => {
    expect(coreFiles.length).toBeGreaterThan(5);
    expect(providerFiles.length).toBeGreaterThan(10);
    expect(mcpFiles.length).toBeGreaterThan(0);
  });

  it('src/core/** never imports providers or the MCP layer', () => {
    for (const file of coreFiles) {
      for (const spec of importSpecifiers(readFileSync(file, 'utf8'))) {
        expect(spec, `${rel(file)} must not import ${spec}`).not.toMatch(/\.\.\/(providers|mcp)\//);
      }
    }
  });

  it('src/core/** references no concrete provider id in code', () => {
    // AGENTS.md §5: there is deliberately no ProviderId union in core. Comments
    // are excluded - prose naming an example provider is not a dependency.
    for (const file of coreFiles) {
      const source = stripComments(readFileSync(file, 'utf8'));
      for (const provider of ['freshdesk', 'woocommerce', 'zoho', 'unicommerce']) {
        expect(source, `${rel(file)} must not reference provider "${provider}"`).not.toContain(`'${provider}'`);
      }
    }
  });

  it('a provider never imports another provider, and never imports the MCP SDK', () => {
    for (const file of providerFiles) {
      const source = readFileSync(file, 'utf8');
      for (const spec of importSpecifiers(source)) {
        expect(spec, `${rel(file)} must not import the MCP SDK`).not.toContain('@modelcontextprotocol');
        // Only the registry list may reach across provider folders.
        if (rel(file) !== 'src/providers/index.ts') {
          expect(spec, `${rel(file)} must not import a sibling provider (${spec})`).not.toMatch(
            /\.\.\/(freshdesk|woocommerce|zoho|unicommerce)\//,
          );
        }
      }
    }
  });

  it('only src/providers/index.ts imports concrete provider manifests', () => {
    const importers = providerFiles
      .filter((f) => importSpecifiers(readFileSync(f, 'utf8')).some((s) => /\.\/[a-z-]+\/manifest\.ts$/.test(s)))
      .map(rel);
    expect(importers.sort()).toEqual(['src/providers/index.ts']);
  });

  it('only src/mcp/** imports the MCP SDK', () => {
    const importers = allSourceFiles
      .filter((f) => importSpecifiers(readFileSync(f, 'utf8')).some((s) => s.includes('@modelcontextprotocol')))
      .map(rel);
    for (const importer of importers) {
      expect(importer.startsWith('src/mcp/'), `${importer} must not import the MCP SDK`).toBe(true);
    }
    expect(importers.length).toBeGreaterThan(0);
  });

  it('sources stay runnable under Node strip-only TypeScript mode', () => {
    for (const file of allSourceFiles) {
      const source = readFileSync(file, 'utf8');
      const name = rel(file);
      // Parameter properties require a transform -> ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX.
      expect(source, `${name} must avoid constructor parameter properties`).not.toMatch(
        /constructor\s*\([^)]*\b(private|public|protected|readonly)\s+\w+/s,
      );
      // Runtime enums and import-equals require a transform.
      expect(source, `${name} must avoid runtime enums`).not.toMatch(/^\s*enum\s+\w+/m);
      expect(source, `${name} must avoid import x = require()`).not.toMatch(/^\s*import\s+\w+\s*=\s*require\(/m);
    }
  });
});
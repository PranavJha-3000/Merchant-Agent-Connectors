import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createMemoryLogger } from '../../src/core/logger.ts';
import { buildConnectorTools } from '../../src/mcp/server.ts';

/**
 * Documentation integrity: every relative link in the docs must resolve, and the
 * files the README promises must exist. Prevents a reviewer clicking a 404 and
 * prevents doc drift (AGENTS.md §13).
 */

const DOC_FILES = [
  'README.md',
  'AGENTS.md',
  'docs/architecture.md',
  'docs/provider-matrix.md',
  'docs/tool-spec.md',
  'docs/agent-capabilities.md',
  'docs/security.md',
  'docs/reliability.md',
  'docs/testing.md',
  'docs/evaluation.md',
  'docs/demo.md',
  'docs/limitations.md',
  'docs/adding-a-provider.md',
  'docs/providers/freshdesk.md',
  'docs/providers/woocommerce.md',
  'docs/providers/zoho-inventory.md',
  'docs/providers/unicommerce.md',
] as const;

const repoRoot = new URL('../../', import.meta.url);

function findRelativeLinks(markdown: string): string[] {
  const links: string[] = [];
  const re = /\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    const target = match[1]!.trim();
    if (target.startsWith('http') || target.startsWith('#') || target.startsWith('mailto:')) continue;
    links.push(target.split('#')[0]!);
  }
  return links;
}

describe('documentation integrity', () => {
  it('ships every documented file', () => {
    for (const rel of DOC_FILES) {
      expect(existsSync(new URL(rel, repoRoot)), `missing documented file: ${rel}`).toBe(true);
    }
  });

  it('has no broken relative links', () => {
    const broken: string[] = [];
    for (const rel of DOC_FILES) {
      const content = readFileSync(new URL(rel, repoRoot), 'utf8');
      const base = new URL(rel.slice(0, rel.lastIndexOf('/') + 1), repoRoot);
      for (const target of findRelativeLinks(content)) {
        if (!existsSync(new URL(target, base))) broken.push(`${rel} -> ${target}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('README mentions every provider doc and the commands it promises', () => {
    const readme = readFileSync(new URL('README.md', repoRoot), 'utf8');
    for (const provider of ['freshdesk', 'woocommerce', 'zoho-inventory', 'unicommerce']) {
      expect(readme).toContain(`docs/providers/${provider}.md`);
    }
    for (const command of ['npm test', 'npm run demo', 'npm run inspect:tools']) {
      expect(readme).toContain(command);
    }
  });

  it('AGENTS.md contains all eighteen mandated sections', () => {
    const agents = readFileSync(new URL('AGENTS.md', repoRoot), 'utf8');
    for (let i = 1; i <= 18; i += 1) {
      expect(agents, `AGENTS.md missing section ${i}`).toContain(`## ${i}.`);
    }
  });

  it('records verification status (no unlabelled provider claims)', () => {
    const matrix = readFileSync(new URL('docs/provider-matrix.md', repoRoot), 'utf8');
    expect(matrix).toContain('VERIFIED');
    const unicommerce = readFileSync(new URL('docs/providers/unicommerce.md', repoRoot), 'utf8');
    expect(unicommerce).toContain('UNVERIFIED');
  });

  it('every implemented provider documents its verified sources and UNVERIFIED gaps', () => {
    // Each shipped connector must cite official docs and be explicit about what
    // could not be verified (AGENTS.md §13).
    for (const provider of ['freshdesk', 'woocommerce', 'zoho-inventory', 'unicommerce']) {
      const page = readFileSync(new URL(`docs/providers/${provider}.md`, repoRoot), 'utf8');
      expect(page, `${provider} doc must cite official sources`).toContain('https://');
      expect(page, `${provider} doc must mark unverified items`).toContain('UNVERIFIED');
      expect(page, `${provider} doc must state a check date`).toContain('2026-');
    }
  });

  it('docs/tool-spec.md documents every tool the server actually registers', () => {
    // The drift class this catches is real: a tool exists, its contract is
    // undocumented, and the agent-facing spec silently loses it (AGENTS.md §17.6).
    const bundles = buildConnectorTools({ mode: 'fixture', logger: createMemoryLogger(), env: {} });
    const spec = readFileSync(new URL('docs/tool-spec.md', repoRoot), 'utf8');
    const names = bundles.flatMap((b) => b.tools.map((t) => t.name));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(spec, `docs/tool-spec.md must document ${name}`).toContain(`## ${name}`);
    }
    // ...and the spec must not advertise tools that no longer exist.
    for (const documented of spec.match(/^## (\w+)$/gm) ?? []) {
      const toolName = documented.replace(/^## /, '').trim();
      expect(names, `docs/tool-spec.md documents unknown tool ${toolName}`).toContain(toolName);
    }
  });

  it('the provider matrix matches the providers the code actually registers', () => {
    const matrix = readFileSync(new URL('docs/provider-matrix.md', repoRoot), 'utf8');
    for (const id of ['freshdesk', 'woocommerce', 'zoho-inventory', 'unicommerce']) {
      expect(matrix, `matrix must list ${id}`).toContain(`\`${id}\``);
      // All four target providers are implemented; none may still be marked as
      // pending design work.
      const row = matrix.split('\n').find((l) => l.includes(`\`${id}\``));
      expect(row, `matrix row for ${id}`).toBeDefined();
      expect(row!, `${id} row must not be marked unimplemented`).not.toMatch(/designed, not/);
    }
  });
});
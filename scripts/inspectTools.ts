import { createMemoryLogger } from '../src/core/logger.ts';
import { buildConnectorTools } from '../src/mcp/server.ts';
import { providerModules } from '../src/providers/index.ts';

/**
 * Print the exact tool surface an MCP host would see (fixture mode):
 *   npm run inspect:tools
 * Output is stable enough to diff against docs/tool-spec.md.
 */
const logger = createMemoryLogger('error');
const bundles = buildConnectorTools({ modules: providerModules, mode: 'fixture', logger, env: {} });

process.stdout.write(`merchant-agent-connectors | ${bundles.length} provider(s) | fixture mode\n`);
for (const bundle of bundles) {
  process.stdout.write(`\nprovider: ${bundle.module.id} (${bundle.module.displayName})\n`);
  process.stdout.write(`capabilities: ${bundle.module.capabilities.join(', ')}\n`);
  for (const tool of bundle.tools) {
    process.stdout.write(`\n- ${tool.name}\n`);
    process.stdout.write(`  annotations: ${JSON.stringify(tool.annotations)}\n`);
    process.stdout.write(`  description: ${tool.description}\n`);
  }
}

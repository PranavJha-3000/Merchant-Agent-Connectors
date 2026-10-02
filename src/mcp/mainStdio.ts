import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { isConnectorError } from '../core/errors.ts';
import { createJsonLogger } from '../core/logger.ts';
import { createConnectorServer } from './server.ts';

/**
 * stdio entrypoint (Claude Desktop / MCP Inspector style hosts).
 * Logs go to stderr — stdout is reserved for the MCP protocol.
 *
 *   npm run serve:stdio                # fixture mode (default, no credentials)
 *   CONNECTOR_MODE=live npm run serve:stdio
 */

const mode = process.env['CONNECTOR_MODE'] === 'live' ? ('live' as const) : ('fixture' as const);
const logger = createJsonLogger({ minLevel: process.env['LOG_LEVEL'] === 'debug' ? 'debug' : 'info' });

serveStdio(() => {
  try {
    return createConnectorServer({ mode, logger });
  } catch (error) {
    // Fail fast on configuration problems with an agent/operator-safe message.
    const message = isConnectorError(error) ? error.message : String(error);
    process.stderr.write(`failed to start connector server: ${message}\n`);
    process.exit(1);
  }
});

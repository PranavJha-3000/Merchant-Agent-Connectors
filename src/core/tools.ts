import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { toAgentError, ValidationError } from './errors.ts';

/**
 * Tool contract shared by the MCP server and the standalone runner.
 *
 * The MCP layer (src/mcp/) is the ONLY place these definitions meet the SDK.
 * Providers never import MCP types — they produce ToolDefinitions (AGENTS.md §7).
 */

export interface ToolAnnotationsShape {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolDefinition<Args extends z.ZodType<any, any> = z.ZodType<any, any>, Out extends z.ZodType<any, any> = z.ZodType<any, any>> {
  /** Provider-prefixed semantic name, e.g. 'freshdesk_get_ticket'. */
  name: string;
  provider: string;
  description: string;
  inputSchema: Args;
  outputSchema: Out;
  annotations: ToolAnnotationsShape;
  handler: (args: z.infer<Args>) => Promise<z.infer<Out>>;
}

/** Success carries structuredContent (validated against outputSchema). Errors never do. */
export type ToolResultEnvelope =
  | { content: [{ type: 'text'; text: string }]; structuredContent: unknown; isError?: undefined }
  | { content: [{ type: 'text'; text: string }]; isError: true };

/**
 * Execute one tool definition exactly as the MCP server wrapper does:
 * validate input (no network on failure) → run handler → validate output →
 * map any thrown ConnectorError to an agent-safe isError envelope.
 *
 * Shared by src/mcp/server.ts (protocol path) and tests/demo/eval (direct path)
 * so both surfaces have identical semantics.
 */
export async function executeToolDefinition(tool: ToolDefinition, rawArgs: unknown): Promise<ToolResultEnvelope> {
  const parsed = tool.inputSchema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    const payload = new ValidationError({
      provider: tool.provider,
      operation: tool.name,
      correlationId: randomUUID(),
      message: `Invalid arguments for ${tool.name}: ${issues}`,
      hint: 'Fix the arguments to match the tool input schema, then call again. No request was sent upstream.',
    }).toAgentPayload();
    return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: true };
  }

  try {
    const data = await tool.handler(parsed.data);
    const output = tool.outputSchema.parse(data);
    return {
      content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
      structuredContent: output,
    };
  } catch (error) {
    const err = toAgentError(error, { provider: tool.provider, operation: tool.name });
    const payload = err.toAgentPayload();
    // Agent-facing operation = the tool name (what the agent called). The finer
    // adapter operation (e.g. 'freshdesk.getTicket') remains in structured logs,
    // joinable via correlationId.
    payload.operation = tool.name;
    return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: true };
  }
}

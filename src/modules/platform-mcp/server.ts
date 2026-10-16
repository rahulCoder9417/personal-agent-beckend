import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { runLater } from '../../shared/later.ts';
import { logger } from '../../shared/logger.ts';
import { audit, type AuditInput } from '../admin/audit.ts';
import { touch } from '../orchestrator/sandbox.ts';
import { platformTools, ToolError, type ToolContext } from './registry.ts';
import './tools/core.ts';
import './tools/apps.ts';
import './tools/automations.ts';
import './tools/web.ts';
import './tools/memory.ts';
import './tools/crew-jobs.ts';

/** A per-request MCP server bound to ONE user (stateless streamable HTTP). */
export function createPlatformMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: 'platform', version: '0.1.0' });
  for (const tool of platformTools()) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.input },
      async (args: Record<string, unknown>) => {
        touch(ctx.userId);
        try {
          const result = await tool.run(ctx, args as never);
          auditLater(tool.name, {
            userId: ctx.userId,
            actor: 'agent',
            action: tool.name,
            summary: tool.summarize?.(args as never, result) ?? tool.name,
            details: {
              args: redactArgs(tool.auditArgs?.(args as never) ?? args),
              ...tool.auditDetails?.(args as never, result),
            },
            creditsCharged: tool.creditsCharged?.(args as never, result) ?? null,
          });
          return { content: [{ type: 'text' as const, text: JSON.stringify(result ?? null) }] };
        } catch (err) {
          const message = err instanceof ToolError ? err.message : 'Internal error';
          if (!(err instanceof ToolError))
            logger().error({ tool: tool.name, err: String(err) }, 'tool failed');
          return { content: [{ type: 'text' as const, text: message }], isError: true };
        }
      },
    );
  }
  return server;
}

/**
 * Writes a tool call's activity-log entry without making the agent wait for it (one round trip,
 * about 0.26 s, on every tool call). The entry is made from the call's result before the answer
 * goes back; a write that fails is logged as an error with the user and the tool, never the inputs.
 */
function auditLater(toolName: string, entry: AuditInput): void {
  runLater('activity log entry of a tool call', () => audit(entry), {
    userId: entry.userId,
    tool: toolName,
  });
}

function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = /secret|token|password|key/i.test(k)
      ? '[redacted]'
      : typeof v === 'string' && v.length > 500
        ? `${v.slice(0, 500)}…`
        : v;
  }
  return out;
}

export async function handleMcpRequest(ctx: ToolContext, req: Request): Promise<Response> {
  const server = createPlatformMcpServer(ctx);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    void server.close();
  }
}

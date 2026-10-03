import type { z } from 'zod';

/** Everything a tool may know about its caller: ONLY the user id forced from the container token. */
export interface ToolContext {
  userId: string;
}

export interface PlatformTool<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  input: S;
  /** Returns JSON-serialisable output. Throw ToolError for an error the agent should see. */
  run(ctx: ToolContext, args: z.infer<z.ZodObject<S>>): Promise<unknown>;
  /** One-line summary for the audit log. */
  summarize?(args: z.infer<z.ZodObject<S>>, result: unknown): string;
  /** Credits this call cost, for the activity log (`creditsCharged`). Omit when a tool never charges. */
  creditsCharged?(args: z.infer<z.ZodObject<S>>, result: unknown): number | null;
}

export class ToolError extends Error {}

const tools = new Map<string, PlatformTool>();

export function defineTool<S extends z.ZodRawShape>(tool: PlatformTool<S>): void {
  tools.set(tool.name, tool as unknown as PlatformTool);
}

export function platformTools(): PlatformTool[] {
  return [...tools.values()];
}

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
  /** What the audit log keeps of the arguments (default: all of them). */
  auditArgs?(args: z.infer<z.ZodObject<S>>): Record<string, unknown>;
  /** More for the audit entry's details, taken from the result (e.g. the id of what was made). */
  auditDetails?(args: z.infer<z.ZodObject<S>>, result: unknown): Record<string, unknown>;
  /** Credits this call cost, for the activity log (`creditsCharged`). Omit when a tool never charges. */
  creditsCharged?(args: z.infer<z.ZodObject<S>>, result: unknown): number | null;
  /**
   * A call that failed or was refused, for the activity log: the entry to write, or null for none.
   * `reason` is the error's plain-words reason (ToolError's `reason`), never the inputs.
   */
  auditFailure?(args: z.infer<z.ZodObject<S>>, reason: string): FailureEntry | null;
}

/** What the activity log keeps of a failed or refused call. Never the call's inputs. */
export interface FailureEntry {
  action: string;
  summary: string;
  details: Record<string, unknown>;
  creditsCharged?: number | null;
}

/**
 * An error the agent should see. `reason` is a short plain-words reason for the activity log
 * ("the app returned an error"); it never holds the inputs.
 */
export class ToolError extends Error {
  readonly reason: string | undefined;
  constructor(message: string, opts?: { reason?: string }) {
    super(message);
    this.reason = opts?.reason;
  }
}

/** The reason a failed call is logged with when its error gives none. */
export const UNKNOWN_FAILURE = 'it was refused';
/** The reason for an error of ours that the agent only sees as "Internal error". */
export const INTERNAL_FAILURE = 'something went wrong on our side';

const tools = new Map<string, PlatformTool>();

export function defineTool<S extends z.ZodRawShape>(tool: PlatformTool<S>): void {
  tools.set(tool.name, tool as unknown as PlatformTool);
}

export function platformTools(): PlatformTool[] {
  return [...tools.values()];
}

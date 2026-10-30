import { z } from "zod";
import type { Db, Tx } from "../db/client.js";
import type { GmailErrorKind, GoogleService } from "../lib/google.js";
import type { Searched } from "../lib/search.js";
import type { Vault } from "../lib/vault.js";

/**
 * internal       changes only Danny's own records (remember). Runs immediately.
 * read           looks something up. Runs immediately.
 * external_write would send, post or change something outside Danny. NEVER runs from chat:
 *                the loop turns the call into an approval card, and only the user's tap can release it.
 *                The tap runs `execute`. A tool with no `execute` is recorded only, and says so.
 */
export type ToolKind = "internal" | "read" | "external_write";

export type ToolCtx = {
  workspaceId: string;
  userId: string;
  db: Db;
  vault: Vault;
  /** Google sign-in and Gmail. Null when the server has no Google client configured. */
  google: GoogleService | null;
  /** Run database work inside this workspace, with row-level security applied. */
  tenant: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
  /** Live web search for this user. Checks the spend cap and records the cost. Absent when the model cannot search. */
  search?: (question: string) => Promise<Searched>;
};

export type Tool<S extends z.ZodType = z.ZodType> = {
  name: string;
  description: string;
  kind: ToolKind;
  input: S;
  /** One line shown on the approval card. Required for external_write. */
  approvalTitle?: (input: z.infer<S>) => string;
  /** internal and read tools only. */
  run?: (ctx: ToolCtx, input: z.infer<S>) => Promise<string>;
  /** external_write only: does the thing, after the user's tap. Returns one sentence for the user. Throws ExecError if it did not. */
  execute?: (ctx: ToolCtx, input: z.infer<S>) => Promise<string>;
};

/**
 * failed   it definitely did not happen, so the user can retry
 * unknown  it may have happened; the user should check before retrying
 */
export class ExecError extends Error {
  constructor(message: string, readonly kind: Exclude<GmailErrorKind, "reconnect"> = "failed") {
    super(message);
  }
}

export function defineTool<S extends z.ZodType>(t: Tool<S>): Tool<S> {
  if (t.kind === "external_write" && !t.approvalTitle) throw new Error(`${t.name}: external_write tools need approvalTitle`);
  if (t.kind === "external_write" && t.run) throw new Error(`${t.name}: external_write tools use execute, not run`);
  if (t.kind !== "external_write" && !t.run) throw new Error(`${t.name}: ${t.kind} tools need run`);
  return t;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool<any>) {
    if (this.tools.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`);
    this.tools.set(tool.name, tool);
    return this;
  }
  get(name: string) {
    return this.tools.get(name);
  }
  list() {
    return [...this.tools.values()];
  }
  /** Tool definitions in the shape the model API expects. */
  definitions() {
    return this.list().map((t) => {
      const { $schema: _omit, ...schema } = z.toJSONSchema(t.input) as Record<string, unknown>;
      return { name: t.name, description: t.description, input_schema: schema as { type: "object"; [k: string]: unknown } };
    });
  }
}

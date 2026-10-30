import { and, desc, eq } from "drizzle-orm";
import { connections } from "../db/schema.js";
import type { ToolCtx } from "./registry.js";

/** For tool code only: returns the decrypted secret of the newest active connection, or null. */
export async function readConnectionSecret(ctx: ToolCtx, provider: string): Promise<string | null> {
  const [row] = await ctx.tenant((tx) =>
    tx
      .select({ secretEnc: connections.secretEnc })
      .from(connections)
      .where(and(eq(connections.provider, provider), eq(connections.status, "active")))
      .orderBy(desc(connections.createdAt))
      .limit(1),
  );
  return row ? ctx.vault.open(ctx.workspaceId, row.secretEnc) : null;
}

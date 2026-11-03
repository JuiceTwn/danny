import { invites } from "../db/schema.js";
import type { Db } from "../db/client.js";
import { newToken, sha256 } from "./crypto.js";

/** Make a one-week invite link for an email. Email sending is not built yet, so the owner gets the link and passes it on. */
export async function createInvite(db: Db, appUrl: string, email: string, createdBy: string) {
  const token = newToken();
  await db.insert(invites).values({ email, tokenHash: sha256(token), createdBy, expiresAt: new Date(Date.now() + 7 * 86_400_000) });
  return { inviteUrl: `${appUrl}/accept?token=${token}`, expiresInDays: 7 };
}

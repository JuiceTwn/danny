import type { Db } from "../db/client.js";
import { withTenant } from "../db/client.js";
import { conversations, messages } from "../db/schema.js";
import { tidy } from "./format.js";
import type { Card } from "./cards.js";
import type { Vault } from "./vault.js";

/** What a new account starts with, so nobody has to switch the basics on. Existing accounts are left exactly as they are. */
export const NEW_ACCOUNT_DEFAULTS = { briefingEnabled: true, eventPrep: true } as const;

export const WELCOME_REPLIES: string[] = ["Set up my morning brief", "What can you do?"];

export const welcomeText = (name: string) =>
  `${name ? `Hi ${name}. ` : "Hi. "}I'm Danny. Tell me what you need to do and I'll keep track of it and remind you. Your morning brief is already on for 7:30: it fills in as you tell me things, and stays quiet until it has something to say. ` +
  "The quickest way to make it yours is one message: where you are, and what you'd like in it (your teams, topics like tech, a good-news story). Tap below, or just tell me.";

/** The first thing in a new person's chat. */
export async function welcome(db: Db, vault: Vault, workspaceId: string, userId: string, name: string) {
  const cards: Card[] = [{ kind: "replies", options: WELCOME_REPLIES }];
  await withTenant(db, workspaceId, async (tx) => {
    const [conv] = await tx.insert(conversations).values({ workspaceId, userId }).returning();
    await tx.insert(messages).values({ workspaceId, conversationId: conv!.id, role: "assistant", contentEnc: vault.sealJson(workspaceId, tidy(welcomeText(name))), uiEnc: vault.sealJson(workspaceId, cards) });
  });
}

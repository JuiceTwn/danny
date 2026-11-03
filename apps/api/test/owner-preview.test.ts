import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLog, users, workspaces } from "../src/db/schema.js";
import type { PushPayload, PushSender, PushSub } from "../src/lib/push.js";
import { client, seedOwner, setupApp, signUp, type Client, type Ctx } from "./helpers.js";

class Push implements PushSender {
  publicKey: string | null = "k";
  async send(_s: PushSub, _p: PushPayload) {
    return "ok" as const;
  }
}
let ctx: Ctx;
let owner: Client;
let ownerEmail: string;
beforeAll(async () => {
  ctx = await setupApp(undefined, undefined, {}, new Push());
  const o = await seedOwner(ctx);
  owner = o.c;
  ownerEmail = o.email;
});
afterAll(() => ctx.close());

const countPreview = async () => (await ctx.owner.db.$client.unsafe(`select count(*)::int as n from users where preview_of is not null`))[0]!.n as number;

describe("seeing Danny as a new person", () => {
  it("is for the owner only", async () => {
    const u = await signUp(ctx, owner, "Reg");
    expect((await u.c.post("/v1/preview/start")).status).toBe(403);
    expect((await client(ctx).post("/v1/preview/start")).status).toBe(401);
    expect((await u.c.post("/v1/preview/stop")).status).toBe(400); // not previewing
  });

  it("starts a from-scratch account like a real signup, and going back leaves nothing behind", async () => {
    const before = await countPreview();
    const me0 = (await owner.get("/v1/me")).body;
    expect(me0.preview).toBe(false);
    expect((await owner.post("/v1/preview/start")).status).toBe(200);

    // Now looking at the app as a new person.
    const me = (await owner.get("/v1/me")).body;
    expect(me.preview).toBe(true);
    expect(me.isOwner).toBe(false);
    expect(me.user.email).toMatch(/@preview\.invalid$/);
    expect(me.user).toMatchObject({ briefingEnabled: true, eventPrep: true, tips: true, wrapupEnabled: false });
    expect(me.workspaceId).not.toBe(me0.workspaceId);
    const chat = (await owner.get("/v1/chat/history")).body.messages;
    expect(chat).toHaveLength(1);
    expect(chat[0].cards[0].kind).toBe("replies");
    expect((await owner.get("/v1/tasks")).body.items).toEqual([]);

    // A new person can't reach owner tools, can't take over the owner's notifications, and can't log in with a password.
    expect((await owner.get("/v1/admin/usage")).status).toBe(403);
    expect((await owner.post("/v1/preview/start")).status).toBe(403);
    const sub = await owner.post("/v1/push/subscribe", { endpoint: "https://fcm.googleapis.com/fcm/send/own", keys: { p256dh: "p", auth: "a" } });
    expect(sub.status).toBe(403);
    expect((await client(ctx).post("/v1/auth/login", { email: me.user.email, password: "anything at all" })).status).toBe(401);
    // What they do in preview stays in the preview.
    await owner.post("/v1/tasks", { title: "Only in the preview" });
    const previewWs = me.workspaceId as string;

    // Back to normal.
    const back = await owner.post("/v1/preview/stop");
    expect(back.body).toEqual({ ok: true, signedOut: false });
    const again = (await owner.get("/v1/me")).body;
    expect(again).toMatchObject({ preview: false, isOwner: true, workspaceId: me0.workspaceId });
    expect(again.user.email).toBe(ownerEmail);
    expect((await owner.get("/v1/tasks")).body.items.map((t: any) => t.title)).not.toContain("Only in the preview");
    expect((await owner.get("/v1/admin/usage")).status).toBe(200);
    expect(await countPreview()).toBe(before);
    expect(await ctx.owner.db.select().from(workspaces).where(eq(workspaces.id, previewWs))).toEqual([]);
    expect(owner.others["danny_owner"]).toBeUndefined();
    const actions = (await ctx.owner.db.select().from(auditLog).where(eq(auditLog.userId, me0.user.id))).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["preview.start", "preview.stop"]));
  });

  it("starting again always begins from scratch, with only one preview account at a time", async () => {
    await owner.post("/v1/preview/start");
    await owner.post("/v1/teams", { league: "nhl", code: "TOR" });
    expect((await owner.get("/v1/teams")).body.items).toHaveLength(1);
    await owner.post("/v1/preview/stop");
    await owner.post("/v1/preview/start");
    expect((await owner.get("/v1/teams")).body.items).toEqual([]);
    const n = await countPreview();
    await owner.post("/v1/preview/stop");
    expect(await countPreview()).toBe(n - 1);
  });

  it("signs out cleanly, rather than risking the wrong account, if the owner's kept session is gone", async () => {
    await owner.post("/v1/preview/start");
    const kept = owner.others["danny_owner"]!;
    expect(kept).toBeTruthy();
    owner.others["danny_owner"] = "not-a-real-session-token-000000000000";
    const r = await owner.post("/v1/preview/stop");
    expect(r.body).toEqual({ ok: true, signedOut: true });
    expect((await owner.get("/v1/me")).status).toBe(401);
    // The real owner session was never touched: put it back and carry on.
    owner.cookie = `danny_session=${kept}`;
    expect((await owner.get("/v1/me")).body.isOwner).toBe(true);
    expect(await countPreview()).toBe(0);
  });

  it("a session for someone else's kept-aside cookie can't be used to become the owner", async () => {
    const other = await signUp(ctx, owner, "Thief");
    await owner.post("/v1/preview/start");
    // A different person's session cookie, offered as the way "back".
    owner.others["danny_owner"] = other.c.cookie.split("=")[1]!;
    const r = await owner.post("/v1/preview/stop");
    expect(r.body.signedOut).toBe(true);
    expect((await owner.get("/v1/me")).status).toBe(401);
    expect(r.raw.headers["set-cookie"]?.toString()).not.toContain(other.c.cookie.split("=")[1]!);
  });
});

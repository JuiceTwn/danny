import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { DemoModel, type ModelClient } from "../src/brain/model.js";
import { Vault } from "../src/lib/vault.js";
import { createRegistry } from "../src/tools/builtin.js";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { memberships, users, workspaces } from "../src/db/schema.js";
import { hashPassword } from "../src/lib/crypto.js";
import { APP_URL, OWNER_URL } from "./env.js";

export const ORIGIN = "http://app.test";
export const TEST_DATA_KEYS = "1:" + Buffer.alloc(32, 7).toString("base64");

export async function setupApp(model: ModelClient = new DemoModel(), tools = createRegistry(), env: Record<string, string> = {}) {
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: APP_URL,
    APP_ORIGINS: ORIGIN,
    MARKETING_ORIGINS: "http://www.test",
    APP_URL: ORIGIN,
    DATA_KEYS: TEST_DATA_KEYS,
    ...env,
  } as NodeJS.ProcessEnv);
  const runtime = createDb(APP_URL, 5);
  const owner = createDb(OWNER_URL, 2); // table owner: for seeding and for checking what is really in the database
  const vault = new Vault(config.dataKeys);
  const app = await buildApp({ config, db: runtime.db, model, tools, vault });
  return {
    app,
    vault,
    runtime,
    owner,
    config,
    tools,
    /** What the brain needs, for tests that drive a review directly instead of through HTTP. */
    deps: { db: runtime.db, config, model, tools, vault },
    async close() {
      await app.close();
      await runtime.client.end();
      await owner.client.end();
    },
  };
}
export type Ctx = Awaited<ReturnType<typeof setupApp>>;

// Each request gets its own client IP so per-IP rate limits do not couple unrelated tests.
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

export type Client = ReturnType<typeof client>;
export function client(ctx: Ctx, cookie = "") {
  const self = {
    cookie,
    async req(method: "GET" | "POST" | "PATCH" | "DELETE", url: string, body?: unknown, headers: Record<string, string> = {}) {
      const res = await ctx.app.inject({
        method,
        url,
        remoteAddress: ip(),
        headers: { origin: ORIGIN, ...(self.cookie ? { cookie: self.cookie } : {}), ...headers },
        ...(body === undefined ? {} : { payload: body as object }),
      });
      const set = res.headers["set-cookie"];
      const first = Array.isArray(set) ? set[0] : set;
      if (first?.startsWith("danny_session=")) self.cookie = first.split(";")[0]!;
      return { status: res.statusCode, body: (res.headers["content-type"]?.toString().includes("json") ? res.json() : null) as any, headers: res.headers, raw: res };
    },
    get: (url: string) => self.req("GET", url),
    post: (url: string, body?: unknown) => self.req("POST", url, body ?? {}),
    patch: (url: string, body: unknown) => self.req("PATCH", url, body),
    del: (url: string) => self.req("DELETE", url),
  };
  return self;
}

export const PASSWORD = "correct horse battery";
export const uniqueEmail = (p: string) => `${p}-${randomUUID().slice(0, 8)}@test.dev`;

export async function seedOwner(ctx: Ctx, email = uniqueEmail("owner")) {
  await ctx.owner.db.transaction(async (tx) => {
    const [u] = await tx.insert(users).values({ email, passwordHash: await hashPassword(PASSWORD), isOwner: true }).returning({ id: users.id });
    const [w] = await tx.insert(workspaces).values({ name: "Owner" }).returning({ id: workspaces.id });
    await tx.insert(memberships).values({ workspaceId: w!.id, userId: u!.id, role: "admin" });
  });
  const c = client(ctx);
  const res = await c.post("/v1/auth/login", { email, password: PASSWORD });
  if (res.status !== 200) throw new Error("owner login failed");
  return { c, email };
}

/** Full real path: owner invites, new user accepts. Returns a signed-in client. */
export async function signUp(ctx: Ctx, owner: Client, name = "Test") {
  const email = uniqueEmail(name.toLowerCase());
  const inv = await owner.post("/v1/admin/invites", { email });
  const token = new URL(inv.body.inviteUrl).searchParams.get("token");
  const c = client(ctx);
  const res = await c.post("/v1/auth/accept-invite", { token, password: PASSWORD, name });
  if (res.status !== 201) throw new Error(`signup failed: ${JSON.stringify(res.body)}`);
  const me = await c.get("/v1/me");
  return { c, email, workspaceId: me.body.workspaceId as string, userId: me.body.user.id as string };
}

export async function workspaceOf(ctx: Ctx, userId: string) {
  const [m] = await ctx.owner.db.select().from(memberships).where(eq(memberships.userId, userId));
  return m!.workspaceId;
}

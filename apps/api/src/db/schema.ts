import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// ---- Identity (not tenant-scoped: needed before we know whose data to open) ----

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(), // always stored lowercased
    name: text("name").notNull().default(""),
    passwordHash: text("password_hash").notNull(),
    isOwner: boolean("is_owner").notNull().default(false), // server owner: can see usage and approve invites
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("users_email_uq").on(t.email)],
);

// A workspace is the tenant. Every user gets a personal one; teams can share one later.
export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  plan: text("plan").notNull().default("invite"),
  dailyCapMicros: bigint("daily_cap_micros", { mode: "number" }).notNull().default(2_000_000), // US$2.00
  monthlyCapMicros: bigint("monthly_cap_micros", { mode: "number" }).notNull().default(30_000_000), // US$30.00, calendar month in UTC
  killSwitch: boolean("kill_switch").notNull().default(false),
  // Autonomy. Off until an admin turns it on. The limit is on review runs per UTC day, whatever started them.
  agentEnabled: boolean("agent_enabled").notNull().default(false),
  agentRunsPerDay: integer("agent_runs_per_day").notNull().default(6),
  agentLastRunAt: timestamp("agent_last_run_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const memberships = pgTable(
  "memberships",
  {
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"), // member | admin
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] }), index("memberships_user_idx").on(t.userId)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    tokenHash: bytea("token_hash").notNull(), // sha256 of the cookie value; the raw token is never stored
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("sessions_token_uq").on(t.tokenHash), index("sessions_user_idx").on(t.userId)],
);

export const inviteRequests = pgTable(
  "invite_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    status: text("status").notNull().default("pending"), // pending | approved | declined
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("invite_requests_email_uq").on(t.email)],
);

export const invites = pgTable(
  "invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    tokenHash: bytea("token_hash").notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("invites_token_uq").on(t.tokenHash)],
);

// ---- Tenant data: every row carries workspace_id and is protected by row-level security ----

export const memory = pgTable(
  "memory",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    contentEnc: bytea("content_enc").notNull(), // encrypted with the workspace key (see lib/vault.ts)
    createdAt: createdAt(),
  },
  (t) => [index("memory_ws_idx").on(t.workspaceId, t.createdAt)],
);

export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: createdAt(),
});

export const messages = pgTable(
  "messages",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // user | assistant
    contentEnc: bytea("content_enc").notNull(), // encrypted JSON
    createdAt: createdAt(),
  },
  (t) => [index("messages_conv_idx").on(t.conversationId, t.id)],
);

export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // e.g. email, post, note. Free text until connectors exist.
    titleEnc: bytea("title_enc").notNull(), // encrypted: titles often contain customer names
    payloadEnc: bytea("payload_enc").notNull(), // encrypted JSON: the draft itself
    status: text("status").notNull().default("pending"), // pending | approved | changes_requested | dropped
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    // Honesty field: stays null until a connector really executes the action.
    executedAt: timestamp("executed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("approvals_ws_idx").on(t.workspaceId, t.status, t.createdAt)],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    detail: jsonb("detail").notNull().default(sql`'{}'::jsonb`),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_ws_idx").on(t.workspaceId, t.at)],
);

export const spendLedger = pgTable(
  "spend_ledger",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    day: date("day").notNull().defaultNow(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costMicros: bigint("cost_micros", { mode: "number" }).notNull(), // US$ x 1,000,000
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("spend_ws_day_idx").on(t.workspaceId, t.day)],
);

// Accounts a workspace has linked. The secret is encrypted before it is stored and never returned by the API.
export const connections = pgTable(
  "connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    label: text("label").notNull().default(""),
    secretEnc: bytea("secret_enc").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: createdAt(),
  },
  (t) => [index("connections_ws_idx").on(t.workspaceId, t.provider)],
);

// What the boss is trying to get done, and the steps Danny has planned toward it. Text is encrypted like memory.
export const goals = pgTable(
  "goals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    titleEnc: bytea("title_enc").notNull(),
    notesEnc: bytea("notes_enc").notNull(), // encrypted; Danny's running notes on the goal
    status: text("status").notNull().default("active"), // active | done | dropped
    createdBy: text("created_by").notNull().default("user"), // user | danny
    dueAt: timestamp("due_at", { withTimezone: true }),
    // When Danny should next look at this goal on his own. A due review is what wakes him up.
    nextReviewAt: timestamp("next_review_at", { withTimezone: true }).notNull(),
    lastReviewedAt: timestamp("last_reviewed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("goals_ws_idx").on(t.workspaceId, t.status, t.nextReviewAt)],
);

export const goalSteps = pgTable(
  "goal_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    goalId: uuid("goal_id").notNull().references(() => goals.id, { onDelete: "cascade" }),
    textEnc: bytea("text_enc").notNull(),
    status: text("status").notNull().default("todo"), // todo | doing | done | blocked
    dueAt: timestamp("due_at", { withTimezone: true }),
    position: integer("position").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("goal_steps_goal_idx").on(t.goalId, t.position)],
);

// One row per request Danny handled (a chat turn, an "answer better", or a self-review): which model the router picked and why,
// what it really cost, and whether the user pushed it up a tier. Append-only, so the numbers can be trusted when tightening the rules.
export const requestLog = pgTable(
  "request_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    source: text("source").notNull().default("chat"), // chat | agent (a review Danny ran on his own)
    feature: text("feature").notNull(), // chat | quick_chat | reminder | lookup | client_post | email | planning | multi_step | long_attachment
    tier: text("tier").notNull(), // haiku | sonnet | opus: the tier that actually answered
    model: text("model").notNull(),
    reason: text("reason").notNull(), // the rule that picked the tier, e.g. keyword:draft
    downshifted: boolean("downshifted").notNull().default(false), // pushed down a tier because the user was near a cap
    escalated: boolean("escalated").notNull().default(false), // moved up to Opus after Sonnet failed twice
    // Set on the request that re-ran an earlier one because the user tapped "Answer better". The earlier row is the one they were unhappy with.
    retryOf: uuid("retry_of"),
    status: text("status").notNull().default("ok"), // ok | failed | blocked
    failures: integer("failures").notNull().default(0), // model calls that failed along the way
    calls: integer("calls").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costMicros: bigint("cost_micros", { mode: "number" }).notNull().default(0),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("request_log_ws_idx").on(t.workspaceId, t.at), index("request_log_retry_idx").on(t.retryOf)],
);

export const TENANT_TABLES = ["memory", "conversations", "messages", "approvals", "audit_log", "spend_ledger", "connections", "goals", "goal_steps", "request_log"] as const;

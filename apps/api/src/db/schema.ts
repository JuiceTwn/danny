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
    timezone: text("timezone").notNull().default("America/Toronto"), // IANA name; reminders and quiet hours use it
    passwordHash: text("password_hash").notNull(),
    isOwner: boolean("is_owner").notNull().default(false), // server owner: can see usage and approve invites
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    // Morning briefing. Off until the user turns it on, because it spends money while they sleep.
    briefingEnabled: boolean("briefing_enabled").notNull().default(false),
    briefingMinute: integer("briefing_minute").notNull().default(450), // minutes after local midnight; 450 = 07:30
    lastBriefingDay: date("last_briefing_day"), // local date of the last briefing, so it goes out once a day
    // Evening wrap-up (on Sundays it becomes the weekly review). Also off until asked for.
    wrapupEnabled: boolean("wrapup_enabled").notNull().default(false),
    wrapupMinute: integer("wrapup_minute").notNull().default(1200), // 1200 = 20:00
    lastWrapupDay: date("last_wrapup_day"),
    voice: text("voice").notNull().default("foreman"), // foreman | warm | brief
    quietStart: integer("quiet_start").notNull().default(22), // local hour repeat nudges and watch alerts go quiet
    quietEnd: integer("quiet_end").notNull().default(7),
    units: text("units").notNull().default("metric"), // metric | imperial, for weather
    learnEnabled: boolean("learn_enabled").notNull().default(true), // let Danny work out how you like to be helped
    lastLearnedAt: timestamp("last_learned_at", { withTimezone: true }),
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
  killSwitch: boolean("kill_switch").notNull().default(false),
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
    // Honesty fields: executedAt stays null until a connector really did the thing.
    executedAt: timestamp("executed_at", { withTimezone: true }),
    // null = nothing to run (recorded only) | running | done | failed (definitely not done, safe to retry) | unknown (may have happened: check, do not retry)
    execution: text("execution"),
    executionNote: text("execution_note"), // a fixed, non-sensitive sentence, never provider error text
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

// A to-do. A reminder is just a task with remind_at set; nudges re-set it until the user acts.
export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    titleEnc: bytea("title_enc").notNull(),
    status: text("status").notNull().default("open"), // open | done
    dueAt: timestamp("due_at", { withTimezone: true }),
    remindAt: timestamp("remind_at", { withTimezone: true }), // next time to nudge; null = nothing scheduled
    nudgeCount: integer("nudge_count").notNull().default(0),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("tasks_ws_idx").on(t.workspaceId, t.status, t.remindAt)],
);

// Something the user is working toward. Danny keeps it in mind, and can watch the web for it on a schedule.
export const goals = pgTable(
  "goals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    titleEnc: bytea("title_enc").notNull(),
    notesEnc: bytea("notes_enc"), // what good looks like: location, industry, budget, deal-breakers
    watchQueryEnc: bytea("watch_query_enc"), // what to search for when checking
    lastFindingEnc: bytea("last_finding_enc"), // what the last check reported, so the next one only says what is new
    checkEveryHours: integer("check_every_hours"), // null = not monitored
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    status: text("status").notNull().default("open"), // open | paused | done
    // Last time the user moved it forward or said something about it. Two quiet weeks and Danny asks what's in the way.
    touchedAt: timestamp("touched_at", { withTimezone: true }).notNull().defaultNow(),
    stallNudgedAt: timestamp("stall_nudged_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("goals_ws_idx").on(t.workspaceId, t.userId, t.status)],
);

// Settings for the whole server that the owner enters in the app instead of editing .env. Encrypted like everything else.
// Not tenant data, so no row-level security: only owner-only routes ever touch it.
export const serverSecrets = pgTable("server_secrets", {
  name: text("name").primaryKey(),
  secretEnc: bytea("secret_enc").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// What Danny knows about HOW to help this person, as opposed to facts about their life (that is memory).
//   instruction  their own standing instructions, written in Settings (at most one)
//   location     where they are, for weather and "near me" (at most one)
//   said         a preference they told Danny in chat
//   observed     something Danny worked out from how they use him; replaced each week
export const styleNotes = pgTable(
  "style_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    noteEnc: bytea("note_enc").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("style_notes_user_idx").on(t.workspaceId, t.userId, t.kind)],
);

// Topics the user wants news and updates on. They shape the morning briefing.
export const interests = pgTable(
  "interests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    topicEnc: bytea("topic_enc").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("interests_user_idx").on(t.workspaceId, t.userId)],
);

// One row per browser or phone that agreed to notifications. The keys are encrypted like any other secret.
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    subEnc: bytea("sub_enc").notNull(), // encrypted JSON: { endpoint, keys }
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("push_ws_endpoint_uq").on(t.workspaceId, t.endpoint)],
);

export const TENANT_TABLES = ["memory", "conversations", "messages", "approvals", "audit_log", "spend_ledger", "connections", "tasks", "push_subscriptions"] as const;

ALTER TABLE "workspaces" ADD COLUMN "agent_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "agent_runs_per_day" integer DEFAULT 6 NOT NULL;
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "agent_last_run_at" timestamp with time zone;
--> statement-breakpoint
CREATE TABLE "goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"title_enc" bytea NOT NULL,
	"notes_enc" bytea NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" text DEFAULT 'user' NOT NULL,
	"due_at" timestamp with time zone,
	"next_review_at" timestamp with time zone NOT NULL,
	"last_reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goal_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
	"goal_id" uuid NOT NULL REFERENCES "goals"("id") ON DELETE cascade,
	"text_enc" bytea NOT NULL,
	"status" text DEFAULT 'todo' NOT NULL,
	"due_at" timestamp with time zone,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "goals_ws_idx" ON "goals" ("workspace_id","status","next_review_at");
--> statement-breakpoint
CREATE INDEX "goal_steps_goal_idx" ON "goal_steps" ("goal_id","position");
--> statement-breakpoint
-- Same tenant isolation as every other tenant table. Default privileges from 0001 grant the app role access.
ALTER TABLE goals ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE goals FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON goals
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE goal_steps ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE goal_steps FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON goal_steps
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

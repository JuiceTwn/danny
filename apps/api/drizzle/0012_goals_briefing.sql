CREATE TABLE "goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"title_enc" "bytea" NOT NULL,
	"notes_enc" "bytea",
	"watch_query_enc" "bytea",
	"last_finding_enc" "bytea",
	"check_every_hours" integer,
	"last_checked_at" timestamp with time zone,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "briefing_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "briefing_minute" integer DEFAULT 450 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_briefing_day" date;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goals_ws_idx" ON "goals" USING btree ("workspace_id","user_id","status");--> statement-breakpoint
-- Same tenant isolation as the other tenant tables.
ALTER TABLE "goals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "goals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "goals"
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
DO $$
BEGIN
  EXECUTE format('CREATE POLICY owner_read ON goals FOR SELECT TO %I USING (true)', current_user);
END $$;--> statement-breakpoint
-- The scheduler has to find due work across every workspace. Like due_reminders, these return ids and the
-- timezone only, never a title or any text. Stopped workspaces and disabled users are left out.
CREATE FUNCTION due_goal_checks(as_of timestamptz, max_rows int DEFAULT 20)
RETURNS TABLE (workspace_id uuid, user_id uuid, goal_id uuid, timezone text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT g.workspace_id, g.user_id, g.id, u.timezone
  FROM goals g
  JOIN workspaces w ON w.id = g.workspace_id AND NOT w.kill_switch
  JOIN users u ON u.id = g.user_id AND u.disabled_at IS NULL
  WHERE g.status = 'open' AND g.check_every_hours IS NOT NULL
    AND (g.last_checked_at IS NULL OR g.last_checked_at + make_interval(hours => g.check_every_hours) <= as_of)
  ORDER BY g.last_checked_at NULLS FIRST
  LIMIT max_rows
$$;--> statement-breakpoint
CREATE FUNCTION due_briefings(as_of timestamptz, max_rows int DEFAULT 20)
RETURNS TABLE (workspace_id uuid, user_id uuid, timezone text, local_day date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT m.workspace_id, u.id, u.timezone, (as_of AT TIME ZONE u.timezone)::date
  FROM users u
  JOIN memberships m ON m.user_id = u.id
  JOIN workspaces w ON w.id = m.workspace_id AND NOT w.kill_switch
  WHERE u.briefing_enabled AND u.disabled_at IS NULL
    AND (u.last_briefing_day IS NULL OR u.last_briefing_day < (as_of AT TIME ZONE u.timezone)::date)
    AND (extract(hour FROM as_of AT TIME ZONE u.timezone) * 60 + extract(minute FROM as_of AT TIME ZONE u.timezone)) >= u.briefing_minute
  ORDER BY u.id
  LIMIT max_rows
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION due_goal_checks(timestamptz, int) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION due_briefings(timestamptz, int) FROM PUBLIC;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'danny_app') THEN
    GRANT EXECUTE ON FUNCTION due_goal_checks(timestamptz, int) TO danny_app;
    GRANT EXECUTE ON FUNCTION due_briefings(timestamptz, int) TO danny_app;
  END IF;
END $$;

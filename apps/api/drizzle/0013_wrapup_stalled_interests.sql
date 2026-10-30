CREATE TABLE "interests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"topic_enc" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "touched_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "stall_nudged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "wrapup_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "wrapup_minute" integer DEFAULT 1200 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_wrapup_day" date;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "voice" text DEFAULT 'foreman' NOT NULL;--> statement-breakpoint
ALTER TABLE "interests" ADD CONSTRAINT "interests_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interests" ADD CONSTRAINT "interests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "interests_user_idx" ON "interests" USING btree ("workspace_id","user_id");--> statement-breakpoint
ALTER TABLE "interests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "interests" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "interests"
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE FUNCTION due_wrapups(as_of timestamptz, max_rows int DEFAULT 20)
RETURNS TABLE (workspace_id uuid, user_id uuid, timezone text, local_day date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT m.workspace_id, u.id, u.timezone, (as_of AT TIME ZONE u.timezone)::date
  FROM users u
  JOIN memberships m ON m.user_id = u.id
  JOIN workspaces w ON w.id = m.workspace_id AND NOT w.kill_switch
  WHERE u.wrapup_enabled AND u.disabled_at IS NULL
    AND (u.last_wrapup_day IS NULL OR u.last_wrapup_day < (as_of AT TIME ZONE u.timezone)::date)
    AND (extract(hour FROM as_of AT TIME ZONE u.timezone) * 60 + extract(minute FROM as_of AT TIME ZONE u.timezone)) >= u.wrapup_minute
  ORDER BY u.id
  LIMIT max_rows
$$;--> statement-breakpoint
-- Goals untouched for two weeks, at most one nudge per person per day, never for a goal nudged in the last two weeks.
CREATE FUNCTION due_stalled_goals(as_of timestamptz, max_rows int DEFAULT 20)
RETURNS TABLE (workspace_id uuid, user_id uuid, goal_id uuid, timezone text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT g.workspace_id, g.user_id, g.id, u.timezone
  FROM goals g
  JOIN workspaces w ON w.id = g.workspace_id AND NOT w.kill_switch
  JOIN users u ON u.id = g.user_id AND u.disabled_at IS NULL
  WHERE g.status = 'open'
    AND g.touched_at <= as_of - interval '14 days'
    AND (g.stall_nudged_at IS NULL OR g.stall_nudged_at <= as_of - interval '14 days')
    AND NOT EXISTS (SELECT 1 FROM goals o WHERE o.user_id = g.user_id AND o.stall_nudged_at > as_of - interval '1 day')
  ORDER BY g.touched_at
  LIMIT max_rows
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION due_wrapups(timestamptz, int) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION due_stalled_goals(timestamptz, int) FROM PUBLIC;--> statement-breakpoint
DO $$
BEGIN
  EXECUTE format('CREATE POLICY owner_read ON interests FOR SELECT TO %I USING (true)', current_user);
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'danny_app') THEN
    GRANT EXECUTE ON FUNCTION due_wrapups(timestamptz, int) TO danny_app;
    GRANT EXECUTE ON FUNCTION due_stalled_goals(timestamptz, int) TO danny_app;
  END IF;
END $$;

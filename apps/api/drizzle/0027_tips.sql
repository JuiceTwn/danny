CREATE TABLE "tips_sent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"key" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "tips" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "tips_sent" ADD CONSTRAINT "tips_sent_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tips_sent" ADD CONSTRAINT "tips_sent_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tips_sent_uq" ON "tips_sent" USING btree ("user_id","key");--> statement-breakpoint
ALTER TABLE "tips_sent" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tips_sent" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "tips_sent"
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
-- People who may be told about something new: tips on, account at least a day old, mid-day where they are, and nothing suggested in the last 3 days.
CREATE FUNCTION due_tips(as_of timestamptz, max_rows int DEFAULT 50)
RETURNS TABLE (workspace_id uuid, user_id uuid, timezone text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT m.workspace_id, u.id, u.timezone
  FROM users u
  JOIN memberships m ON m.user_id = u.id
  JOIN workspaces w ON w.id = m.workspace_id AND NOT w.kill_switch
  WHERE u.tips AND u.disabled_at IS NULL
    AND u.created_at <= as_of - interval '1 day'
    AND extract(hour FROM as_of AT TIME ZONE u.timezone) BETWEEN 10 AND 17
    AND NOT EXISTS (SELECT 1 FROM tips_sent t WHERE t.user_id = u.id AND t.sent_at > as_of - interval '3 days')
  ORDER BY u.created_at
  LIMIT max_rows
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION due_tips(timestamptz, int) FROM PUBLIC;--> statement-breakpoint
DO $$
BEGIN
  EXECUTE format('CREATE POLICY owner_read ON tips_sent FOR SELECT TO %I USING (true)', current_user);
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'danny_app') THEN
    GRANT EXECUTE ON FUNCTION due_tips(timestamptz, int) TO danny_app;
  END IF;
END $$;

CREATE TABLE "prep_sent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"event_key" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "waiting_on" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"thread_id" text NOT NULL,
	"subject_enc" "bytea" NOT NULL,
	"who_enc" "bytea" NOT NULL,
	"baseline_count" integer NOT NULL,
	"check_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "event_prep" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "prep_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "prep_sent" ADD CONSTRAINT "prep_sent_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prep_sent" ADD CONSTRAINT "prep_sent_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waiting_on" ADD CONSTRAINT "waiting_on_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waiting_on" ADD CONSTRAINT "waiting_on_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "prep_sent_uq" ON "prep_sent" USING btree ("user_id","event_key");--> statement-breakpoint
CREATE INDEX "waiting_ws_idx" ON "waiting_on" USING btree ("workspace_id","user_id","status","check_at");
--> statement-breakpoint
ALTER TABLE "waiting_on" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "waiting_on" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "waiting_on"
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "prep_sent" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "prep_sent" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "prep_sent"
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
-- Replies being waited on whose day has come. Read-only, bypasses row-level security the same way the other scheduler functions do.
CREATE FUNCTION due_waiting(as_of timestamptz, max_rows int DEFAULT 50)
RETURNS TABLE (workspace_id uuid, user_id uuid, waiting_id uuid, timezone text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT x.workspace_id, x.user_id, x.id, u.timezone
  FROM waiting_on x
  JOIN workspaces w ON w.id = x.workspace_id AND NOT w.kill_switch
  JOIN users u ON u.id = x.user_id AND u.disabled_at IS NULL
  WHERE x.status = 'open' AND x.check_at <= as_of
  ORDER BY x.check_at
  LIMIT max_rows
$$;--> statement-breakpoint
-- People who asked for heads-ups before events, whose workspace has Google connected, and whose calendar has not been looked at in 5 minutes.
CREATE FUNCTION due_event_preps(as_of timestamptz, max_rows int DEFAULT 50)
RETURNS TABLE (workspace_id uuid, user_id uuid, timezone text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT m.workspace_id, u.id, u.timezone
  FROM users u
  JOIN memberships m ON m.user_id = u.id
  JOIN workspaces w ON w.id = m.workspace_id AND NOT w.kill_switch
  WHERE u.event_prep AND u.disabled_at IS NULL
    AND (u.prep_checked_at IS NULL OR u.prep_checked_at <= as_of - interval '5 minutes')
    AND EXISTS (SELECT 1 FROM connections c WHERE c.workspace_id = m.workspace_id AND c.provider = 'google' AND c.status = 'active')
  ORDER BY u.prep_checked_at NULLS FIRST
  LIMIT max_rows
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION due_waiting(timestamptz, int) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION due_event_preps(timestamptz, int) FROM PUBLIC;--> statement-breakpoint
DO $$
BEGIN
  EXECUTE format('CREATE POLICY owner_read ON waiting_on FOR SELECT TO %I USING (true)', current_user);
  EXECUTE format('CREATE POLICY owner_read ON prep_sent FOR SELECT TO %I USING (true)', current_user);
  -- due_event_preps() checks that Google is connected. Connections have row-level security forced, so the function's owner needs a read policy.
  EXECUTE format('CREATE POLICY owner_read ON connections FOR SELECT TO %I USING (true)', current_user);
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'danny_app') THEN
    GRANT EXECUTE ON FUNCTION due_waiting(timestamptz, int) TO danny_app;
    GRANT EXECUTE ON FUNCTION due_event_preps(timestamptz, int) TO danny_app;
  END IF;
END $$;

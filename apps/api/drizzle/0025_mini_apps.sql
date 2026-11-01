CREATE TABLE "mini_apps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"title_enc" "bytea" NOT NULL,
	"request_enc" "bytea" NOT NULL,
	"brief_enc" "bytea",
	"html_enc" "bytea",
	"state_enc" "bytea",
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mini_apps" ADD CONSTRAINT "mini_apps_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mini_apps" ADD CONSTRAINT "mini_apps_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mini_apps_ws_idx" ON "mini_apps" USING btree ("workspace_id","user_id","status");
--> statement-breakpoint
ALTER TABLE "mini_apps" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mini_apps" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "mini_apps"
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
-- Mini apps waiting for a worker: new ones, ones with a change asked for, and ones whose worker died (the lease ran out). Three tries each.
CREATE FUNCTION due_mini_apps(as_of timestamptz, max_rows int DEFAULT 5)
RETURNS TABLE (workspace_id uuid, user_id uuid, app_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT a.workspace_id, a.user_id, a.id
  FROM mini_apps a
  JOIN workspaces w ON w.id = a.workspace_id AND NOT w.kill_switch
  JOIN users u ON u.id = a.user_id AND u.disabled_at IS NULL
  WHERE a.run_after <= as_of AND a.attempts < 3
    AND (a.status IN ('queued', 'editing') OR (a.status = 'working' AND a.lease_until < as_of))
  ORDER BY a.run_after
  LIMIT max_rows
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION due_mini_apps(timestamptz, int) FROM PUBLIC;--> statement-breakpoint
DO $$
BEGIN
  EXECUTE format('CREATE POLICY owner_read ON mini_apps FOR SELECT TO %I USING (true)', current_user);
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'danny_app') THEN
    GRANT EXECUTE ON FUNCTION due_mini_apps(timestamptz, int) TO danny_app;
  END IF;
END $$;

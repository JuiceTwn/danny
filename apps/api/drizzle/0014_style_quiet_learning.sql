CREATE TABLE "style_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"note_enc" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "quiet_start" integer DEFAULT 22 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "quiet_end" integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "units" text DEFAULT 'metric' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "learn_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_learned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "style_notes" ADD CONSTRAINT "style_notes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "style_notes" ADD CONSTRAINT "style_notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "style_notes_user_idx" ON "style_notes" USING btree ("workspace_id","user_id","kind");--> statement-breakpoint
ALTER TABLE "style_notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "style_notes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "style_notes"
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT users_quiet_hours_ck CHECK (quiet_start BETWEEN 0 AND 23 AND quiet_end BETWEEN 0 AND 23);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT users_units_ck CHECK (units IN ('metric', 'imperial'));--> statement-breakpoint
-- People who have learning on and have not been looked at for a week. Ids only, never text.
CREATE FUNCTION due_learning(as_of timestamptz, max_rows int DEFAULT 10)
RETURNS TABLE (workspace_id uuid, user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT m.workspace_id, u.id
  FROM users u
  JOIN memberships m ON m.user_id = u.id
  JOIN workspaces w ON w.id = m.workspace_id AND NOT w.kill_switch
  WHERE u.learn_enabled AND u.disabled_at IS NULL
    AND (u.last_learned_at IS NULL OR u.last_learned_at <= as_of - interval '7 days')
    AND u.created_at <= as_of - interval '7 days'
  ORDER BY u.last_learned_at NULLS FIRST
  LIMIT max_rows
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION due_learning(timestamptz, int) FROM PUBLIC;--> statement-breakpoint
DO $$
BEGIN
  EXECUTE format('CREATE POLICY owner_read ON style_notes FOR SELECT TO %I USING (true)', current_user);
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'danny_app') THEN
    GRANT EXECUTE ON FUNCTION due_learning(timestamptz, int) TO danny_app;
  END IF;
END $$;

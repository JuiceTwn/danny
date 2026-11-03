CREATE TABLE "followed_teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"team_enc" "bytea" NOT NULL,
	"notify" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "game_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"game_id" text NOT NULL,
	"kind" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "good_news" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "news_items" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "followed_teams" ADD CONSTRAINT "followed_teams_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "followed_teams" ADD CONSTRAINT "followed_teams_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_alerts" ADD CONSTRAINT "game_alerts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_alerts" ADD CONSTRAINT "game_alerts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_alerts" ADD CONSTRAINT "game_alerts_team_id_followed_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."followed_teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "followed_teams_user_idx" ON "followed_teams" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "game_alerts_uq" ON "game_alerts" USING btree ("team_id","game_id","kind");--> statement-breakpoint
ALTER TABLE "followed_teams" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "followed_teams" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "followed_teams"
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "game_alerts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "game_alerts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "game_alerts"
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
-- Teams whose owner asked to be told about games, in workspaces that are running and for people who are not disabled.
CREATE FUNCTION due_game_teams(max_rows int DEFAULT 500)
RETURNS TABLE (workspace_id uuid, user_id uuid, team_id uuid, timezone text, followed_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT t.workspace_id, t.user_id, t.id, u.timezone, t.created_at
  FROM followed_teams t
  JOIN workspaces w ON w.id = t.workspace_id AND NOT w.kill_switch
  JOIN users u ON u.id = t.user_id AND u.disabled_at IS NULL
  WHERE t.notify
  ORDER BY t.created_at
  LIMIT max_rows
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION due_game_teams(int) FROM PUBLIC;--> statement-breakpoint
DO $$
BEGIN
  EXECUTE format('CREATE POLICY owner_read ON followed_teams FOR SELECT TO %I USING (true)', current_user);
  EXECUTE format('CREATE POLICY owner_read ON game_alerts FOR SELECT TO %I USING (true)', current_user);
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'danny_app') THEN
    GRANT EXECUTE ON FUNCTION due_game_teams(int) TO danny_app;
  END IF;
END $$;

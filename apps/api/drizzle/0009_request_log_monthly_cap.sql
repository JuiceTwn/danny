ALTER TABLE "workspaces" ADD COLUMN "monthly_cap_micros" bigint DEFAULT 30000000 NOT NULL;
--> statement-breakpoint
CREATE TABLE "request_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
	"user_id" uuid REFERENCES "users"("id") ON DELETE set null,
	"source" text DEFAULT 'chat' NOT NULL,
	"feature" text NOT NULL,
	"tier" text NOT NULL,
	"model" text NOT NULL,
	"reason" text NOT NULL,
	"downshifted" boolean DEFAULT false NOT NULL,
	"escalated" boolean DEFAULT false NOT NULL,
	"retry_of" uuid,
	"status" text DEFAULT 'ok' NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "request_log_ws_idx" ON "request_log" ("workspace_id","at");
--> statement-breakpoint
CREATE INDEX "request_log_retry_idx" ON "request_log" ("retry_of");
--> statement-breakpoint
ALTER TABLE request_log ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE request_log FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON request_log
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- Append-only, like the audit log and spend ledger: the app can add rows but never rewrite them.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'danny_app') THEN
    REVOKE UPDATE, DELETE ON request_log FROM danny_app;
  END IF;
END $$;
--> statement-breakpoint
-- Routing numbers per user for the server owner, across workspaces (which row-level security hides). Counts and money only.
CREATE FUNCTION admin_routing_usage()
RETURNS TABLE (user_id uuid, email text, month_micros bigint, monthly_cap_micros bigint, requests bigint, haiku bigint, sonnet bigint, opus bigint, answer_better bigint, downshifted bigint, escalated bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT u.id,
         u.email,
         COALESCE((SELECT SUM(s.cost_micros) FROM spend_ledger s WHERE s.user_id = u.id AND s.day >= date_trunc('month', now() AT TIME ZONE 'utc')::date), 0)::bigint,
         COALESCE((SELECT MAX(w.monthly_cap_micros) FROM memberships m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = u.id), 0)::bigint,
         COUNT(r.id),
         COUNT(r.id) FILTER (WHERE r.tier = 'haiku'),
         COUNT(r.id) FILTER (WHERE r.tier = 'sonnet'),
         COUNT(r.id) FILTER (WHERE r.tier = 'opus'),
         -- "answer better" taps: requests that were re-run because the user wasn't happy with the first answer
         COUNT(r.id) FILTER (WHERE r.retry_of IS NOT NULL),
         COUNT(r.id) FILTER (WHERE r.downshifted),
         COUNT(r.id) FILTER (WHERE r.escalated)
  FROM users u
  LEFT JOIN request_log r ON r.user_id = u.id AND r.at >= date_trunc('month', now() AT TIME ZONE 'utc')
  GROUP BY u.id, u.email
  ORDER BY 3 DESC
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION admin_routing_usage() FROM PUBLIC;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'danny_app') THEN
    GRANT EXECUTE ON FUNCTION admin_routing_usage() TO danny_app;
  END IF;
END $$;

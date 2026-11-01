ALTER TABLE "spend_ledger" ADD COLUMN "kind" text DEFAULT 'other' NOT NULL;
--> statement-breakpoint
-- Cost by feature, for the owner: what each kind of work really cost and what it was billed, today and over 30 days. Totals only, no one's data.
CREATE FUNCTION admin_usage_by_kind()
RETURNS TABLE (kind text, today_cost_micros bigint, month_cost_micros bigint, today_billed_micros bigint, month_billed_micros bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT s.kind,
         COALESCE(SUM(s.exact_micros) FILTER (WHERE s.day = (now() AT TIME ZONE 'utc')::date), 0)::bigint,
         COALESCE(SUM(s.exact_micros) FILTER (WHERE s.day >= (now() AT TIME ZONE 'utc')::date - 29), 0)::bigint,
         COALESCE(SUM(s.cost_micros) FILTER (WHERE s.day = (now() AT TIME ZONE 'utc')::date), 0)::bigint,
         COALESCE(SUM(s.cost_micros) FILTER (WHERE s.day >= (now() AT TIME ZONE 'utc')::date - 29), 0)::bigint
  FROM spend_ledger s
  WHERE s.day >= (now() AT TIME ZONE 'utc')::date - 29
  GROUP BY s.kind
  ORDER BY 3 DESC
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION admin_usage_by_kind() FROM PUBLIC;--> statement-breakpoint
-- A mini app gets two tries now, not three (a failing build costs about 15 cents each time).
CREATE OR REPLACE FUNCTION due_mini_apps(as_of timestamptz, max_rows int DEFAULT 5)
RETURNS TABLE (workspace_id uuid, user_id uuid, app_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT a.workspace_id, a.user_id, a.id
  FROM mini_apps a
  JOIN workspaces w ON w.id = a.workspace_id AND NOT w.kill_switch
  JOIN users u ON u.id = a.user_id AND u.disabled_at IS NULL
  WHERE a.run_after <= as_of AND a.attempts < 2
    AND (a.status IN ('queued', 'editing') OR (a.status = 'working' AND a.lease_until < as_of))
  ORDER BY a.run_after
  LIMIT max_rows
$$;--> statement-breakpoint
-- Goals already set to be checked more than once a day, for anyone but the server owner, move to daily. The migration runs as the table owner,
-- and row-level security is forced on goals, so it is switched off for this one statement and back on straight after.
ALTER TABLE goals NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE goals SET check_every_hours = 24
  WHERE check_every_hours IS NOT NULL AND check_every_hours < 24
    AND user_id IN (SELECT id FROM users WHERE NOT is_owner);--> statement-breakpoint
ALTER TABLE goals FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'danny_app') THEN
    GRANT EXECUTE ON FUNCTION admin_usage_by_kind() TO danny_app;
  END IF;
END $$;

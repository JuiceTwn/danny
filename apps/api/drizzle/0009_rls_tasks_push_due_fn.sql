-- Same tenant isolation as the other tenant tables. Default privileges from migration 0001
-- already grant the app role access to the new tables.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tasks','push_subscriptions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
      WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
--> statement-breakpoint
-- Tables use FORCE ROW LEVEL SECURITY, which applies to the table owner too (a non-superuser owner
-- sees nothing without app.workspace_id). The SECURITY DEFINER function below runs as the owner,
-- so give the owner role, and only it, a read-only way through for tasks. current_user is the role
-- running this migration, which is also the role that will own the function.
DO $$
BEGIN
  EXECUTE format('CREATE POLICY owner_read ON tasks FOR SELECT TO %I USING (true)', current_user);
END $$;
--> statement-breakpoint
-- The reminder scheduler has to find due tasks across every workspace, which row-level security
-- hides from the app role. This read-only function returns only ids and the user's timezone,
-- never a title. Workspaces with the kill switch on and disabled users are left out.
CREATE FUNCTION due_reminders(as_of timestamptz, max_rows int DEFAULT 200)
RETURNS TABLE (workspace_id uuid, user_id uuid, task_id uuid, timezone text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT t.workspace_id, t.user_id, t.id, u.timezone
  FROM tasks t
  JOIN workspaces w ON w.id = t.workspace_id AND NOT w.kill_switch
  JOIN users u ON u.id = t.user_id AND u.disabled_at IS NULL
  WHERE t.status = 'open' AND t.remind_at IS NOT NULL AND t.remind_at <= as_of
  ORDER BY t.remind_at
  LIMIT max_rows
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION due_reminders(timestamptz, int) FROM PUBLIC;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'danny_app') THEN
    GRANT EXECUTE ON FUNCTION due_reminders(timestamptz, int) TO danny_app;
  END IF;
END $$;

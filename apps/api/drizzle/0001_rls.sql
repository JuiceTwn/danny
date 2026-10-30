-- Tenant isolation, enforced by Postgres itself.
-- The API connects as the non-owner role "danny_app" and sets app.workspace_id per transaction.
-- A query that forgets its WHERE clause still cannot see another workspace's rows.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['memory','conversations','messages','approvals','audit_log','spend_ledger'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
      WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'danny_app') THEN
    GRANT USAGE ON SCHEMA public TO danny_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO danny_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO danny_app;
    -- Tables added by later migrations get the same grants automatically.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO danny_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO danny_app;
    -- Append-only: the app can add to the audit log and spend ledger but never rewrite them.
    REVOKE UPDATE, DELETE ON audit_log, spend_ledger FROM danny_app;
  END IF;
END $$;

-- Same tenant isolation as the other tenant tables. Default privileges from migration 0001
-- already grant the app role access to the new table.
ALTER TABLE connections ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE connections FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON connections
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

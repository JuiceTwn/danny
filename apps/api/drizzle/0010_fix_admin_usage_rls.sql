-- admin_usage() (migration 0002) reads spend_ledger across all workspaces as the table owner. But
-- spend_ledger uses FORCE ROW LEVEL SECURITY, which applies to the owner too, so wherever the owner is
-- not a superuser (the Docker setup) the function saw no rows and the owner's usage view showed $0
-- for everyone. Give the owner role a read-only policy, as for tasks.
DO $$
BEGIN
  EXECUTE format('CREATE POLICY owner_read ON spend_ledger FOR SELECT TO %I USING (true)', current_user);
END $$;

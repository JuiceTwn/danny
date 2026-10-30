-- admin_usage() and admin_routing_usage() run with the table owner's rights (SECURITY DEFINER) so the server owner can see
-- spend and routing per person across workspaces. But spend_ledger and request_log have FORCE ROW LEVEL SECURITY, which applies
-- to the owner too, and with no workspace set the owner saw no rows: both functions returned zeros whenever the migrating role
-- was not a superuser, which is how setup.sh and docker-compose run them.
--
-- A read-only policy for the migrating role fixes that. It is SELECT only, and the app role (danny_app) is not covered by it,
-- so tenant isolation for the API is unchanged. The app never connects as the owner.
CREATE POLICY owner_read ON spend_ledger FOR SELECT TO CURRENT_USER USING (true);
--> statement-breakpoint
CREATE POLICY owner_read ON request_log FOR SELECT TO CURRENT_USER USING (true);

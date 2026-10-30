ALTER TABLE "workspaces" ALTER COLUMN "daily_cap_micros" SET DEFAULT 1000000;--> statement-breakpoint
-- Everyone but the server owner is on the free allowance. Until now any user could raise their own cap.
UPDATE "workspaces" SET "daily_cap_micros" = 1000000
WHERE NOT EXISTS (
  SELECT 1 FROM "memberships" m JOIN "users" u ON u.id = m.user_id
  WHERE m.workspace_id = "workspaces"."id" AND u.is_owner
);

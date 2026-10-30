ALTER TABLE "memory" ADD COLUMN "kind" text DEFAULT 'fact' NOT NULL;--> statement-breakpoint
ALTER TABLE "memory" ADD COLUMN "subject_enc" "bytea";--> statement-breakpoint
ALTER TABLE "memory" ADD COLUMN "pinned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "memory" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memory" ADD COLUMN "last_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memory" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memory" ADD COLUMN "archived_reason" text;--> statement-breakpoint
ALTER TABLE "memory" ADD COLUMN "previous_enc" "bytea";--> statement-breakpoint
ALTER TABLE "memory" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "ui_enc" "bytea";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_tidied_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memory" ADD CONSTRAINT memory_kind_ck CHECK (kind IN ('fact', 'preference', 'person', 'plan', 'place'));--> statement-breakpoint
CREATE INDEX "memory_user_live_idx" ON "memory" ("user_id") WHERE archived_at IS NULL;--> statement-breakpoint
-- People due their weekly memory tidy. Ids only, never text.
CREATE FUNCTION due_memory_tidy(as_of timestamptz, max_rows int DEFAULT 10)
RETURNS TABLE (workspace_id uuid, user_id uuid, timezone text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT m.workspace_id, u.id, u.timezone
  FROM users u
  JOIN memberships m ON m.user_id = u.id
  JOIN workspaces w ON w.id = m.workspace_id AND NOT w.kill_switch
  WHERE u.disabled_at IS NULL
    AND (u.last_tidied_at IS NULL OR u.last_tidied_at <= as_of - interval '7 days')
    AND u.created_at <= as_of - interval '7 days'
  ORDER BY u.last_tidied_at NULLS FIRST
  LIMIT max_rows
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION due_memory_tidy(timestamptz, int) FROM PUBLIC;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'danny_app') THEN
    GRANT EXECUTE ON FUNCTION due_memory_tidy(timestamptz, int) TO danny_app;
  END IF;
END $$;

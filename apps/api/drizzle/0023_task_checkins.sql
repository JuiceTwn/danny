ALTER TABLE "tasks" ADD COLUMN "last_nudge_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "checkin_at" timestamp with time zone;--> statement-breakpoint
-- Tasks Danny may ask about unprompted, for people who turned Starting help on. Two cases: the reminders gave up a day ago and
-- the task is still open, or it has been put off three times. A task is asked about at most once every 3 days, and a person at most
-- once a day, whichever task it is. The day budget is enforced here, so a slow or repeated pass can never send a second one.
CREATE FUNCTION due_task_checkins(as_of timestamptz, max_rows int DEFAULT 20)
RETURNS TABLE (workspace_id uuid, user_id uuid, task_id uuid, timezone text, reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT t.workspace_id, t.user_id, t.id, u.timezone,
         CASE WHEN t.snooze_count >= 3 THEN 'put_off' ELSE 'quiet' END
  FROM tasks t
  JOIN workspaces w ON w.id = t.workspace_id AND NOT w.kill_switch
  JOIN users u ON u.id = t.user_id AND u.disabled_at IS NULL AND u.adhd_mode
  WHERE t.status = 'open'
    AND (
      t.snooze_count >= 3
      OR (t.nudge_count >= 4 AND t.remind_at IS NULL AND t.last_nudge_at <= as_of - interval '1 day')
    )
    AND (t.checkin_at IS NULL OR t.checkin_at <= as_of - interval '3 days')
    AND NOT EXISTS (SELECT 1 FROM tasks o WHERE o.user_id = t.user_id AND o.checkin_at > as_of - interval '1 day')
  ORDER BY t.snooze_count DESC, t.created_at
  LIMIT max_rows
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION due_task_checkins(timestamptz, int) FROM PUBLIC;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'danny_app') THEN
    GRANT EXECUTE ON FUNCTION due_task_checkins(timestamptz, int) TO danny_app;
  END IF;
END $$;

ALTER TABLE "spend_ledger" ADD COLUMN "exact_micros" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
-- The owner's usage view now also shows what requests really cost, next to what was billed (rounded up to the cent).
-- The return type changes, so the function is dropped and made again with the same rights as before.
DROP FUNCTION admin_usage();
--> statement-breakpoint
CREATE FUNCTION admin_usage()
RETURNS TABLE (user_id uuid, email text, today_micros bigint, month_micros bigint, month_exact_micros bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT u.id,
         u.email,
         COALESCE(SUM(s.cost_micros) FILTER (WHERE s.day = (now() AT TIME ZONE 'utc')::date), 0)::bigint,
         COALESCE(SUM(s.cost_micros) FILTER (WHERE s.day >= (now() AT TIME ZONE 'utc')::date - 29), 0)::bigint,
         COALESCE(SUM(s.exact_micros) FILTER (WHERE s.day >= (now() AT TIME ZONE 'utc')::date - 29), 0)::bigint
  FROM users u
  LEFT JOIN spend_ledger s ON s.user_id = u.id
  GROUP BY u.id, u.email
  ORDER BY 4 DESC
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION admin_usage() FROM PUBLIC;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'danny_app') THEN
    GRANT EXECUTE ON FUNCTION admin_usage() TO danny_app;
  END IF;
END $$;

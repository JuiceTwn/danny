-- The owner's per-person view shows what each person's requests REALLY cost, not the usage that was billed to them
-- (rounded up to the cent). The function now returns real cost only. Rows from before migration 0020 have no real
-- cost recorded and count as 0. Same rights as before.
DROP FUNCTION admin_usage();
--> statement-breakpoint
CREATE FUNCTION admin_usage()
RETURNS TABLE (user_id uuid, email text, today_cost_micros bigint, month_cost_micros bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT u.id,
         u.email,
         COALESCE(SUM(s.exact_micros) FILTER (WHERE s.day = (now() AT TIME ZONE 'utc')::date), 0)::bigint,
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

-- Titles are now encrypted by the application. Existing plaintext titles cannot be converted in SQL.
-- This only proceeds on an empty approvals table; otherwise encrypt the rows with a data migration first.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM approvals) THEN
    RAISE EXCEPTION 'approvals already hold plaintext titles; encrypt them with a data migration first';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "approvals" DROP COLUMN "title";
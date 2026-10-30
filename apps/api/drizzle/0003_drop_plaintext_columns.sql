-- Memory, messages and approvals now store encrypted bytes. Plaintext rows cannot be converted in SQL,
-- because the key lives in the application, not the database. This only proceeds on empty tables.
-- If it stops here, write a one-off script that reads the old columns, encrypts, and writes the new ones.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM memory) OR EXISTS (SELECT 1 FROM messages) OR EXISTS (SELECT 1 FROM approvals) THEN
    RAISE EXCEPTION 'memory, messages or approvals already hold plaintext rows; encrypt them with a data migration first';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "approvals" DROP COLUMN "payload";--> statement-breakpoint
ALTER TABLE "memory" DROP COLUMN "content";--> statement-breakpoint
ALTER TABLE "memory" DROP COLUMN "forgotten_at";--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "content";
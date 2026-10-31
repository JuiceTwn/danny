ALTER TABLE "tasks" ADD COLUMN "first_step_enc" "bytea";--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "snooze_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "adhd_mode" boolean DEFAULT false NOT NULL;
ALTER TABLE "tasks" ADD COLUMN "repeat_every" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "repeat_unit" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "repeat_lead_min" integer;
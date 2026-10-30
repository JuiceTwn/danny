ALTER TABLE "memory" ADD COLUMN "source" text DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "auto_memory" boolean DEFAULT true NOT NULL;
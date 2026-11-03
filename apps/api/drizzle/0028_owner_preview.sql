ALTER TABLE "users" ADD COLUMN "preview_of" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_preview_of_users_id_fk" FOREIGN KEY ("preview_of") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_preview_uq" ON "users" USING btree ("preview_of");
CREATE TABLE "server_secrets" (
	"name" text PRIMARY KEY NOT NULL,
	"secret_enc" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

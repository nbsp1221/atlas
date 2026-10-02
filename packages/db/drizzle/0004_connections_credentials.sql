CREATE TABLE "credential_secrets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider_key" text NOT NULL,
	"auth_type" text NOT NULL,
	"envelope" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_attempts" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"connection_id" uuid,
	"connection_revision" integer,
	"label" text NOT NULL,
	"client_revision" integer NOT NULL,
	"verifier" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_clients" (
	"provider_key" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"credential_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_clients_credential_id_unique" UNIQUE("credential_id")
);
--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "credential_id" uuid;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "auth_state" text DEFAULT 'missing' NOT NULL;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_credential_id_credential_secrets_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credential_secrets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_credential_id_credential_secrets_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credential_secrets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_credential_id_unique" UNIQUE("credential_id");--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_auth_state_ck" CHECK ("connections"."auth_state" in ('missing', 'unchecked', 'ready', 'reauth_required', 'error'));--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_revision_positive_ck" CHECK ("connections"."revision" > 0);--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_ready_secret_ck" CHECK ("connections"."auth_state" != 'ready' or "connections"."credential_id" is not null);
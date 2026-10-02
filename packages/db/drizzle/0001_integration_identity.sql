ALTER TABLE "connections" RENAME COLUMN "provider" TO "provider_key";
--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "external_principal_type" text;
--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "external_principal_id" text;
--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "grants" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "connections" DROP CONSTRAINT "connections_provider_nonempty_ck";
--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_provider_key_nonempty_ck" CHECK (length(trim("connections"."provider_key")) > 0);
--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_grants_object_ck" CHECK (jsonb_typeof("connections"."grants") = 'object');
--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_principal_pair_ck" CHECK (
  ("connections"."external_principal_type" is null and "connections"."external_principal_id" is null)
  or ("connections"."external_principal_type" is not null and "connections"."external_principal_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_principal_type_nonempty_ck" CHECK (
  "connections"."external_principal_type" is null
  or length(trim("connections"."external_principal_type")) > 0
);
--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_principal_id_nonempty_ck" CHECK (
  "connections"."external_principal_id" is null
  or length(trim("connections"."external_principal_id")) > 0
);
--> statement-breakpoint

CREATE TABLE "interaction_channels" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "key" text NOT NULL,
  "label" text NOT NULL,
  "integration_key" text NOT NULL,
  "connection_id" uuid NOT NULL,
  "endpoint_ref" jsonb NOT NULL,
  "direction" text NOT NULL,
  "status" text NOT NULL,
  "config" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "interaction_channels_key_uq" UNIQUE("key"),
  CONSTRAINT "interaction_channels_direction_ck" CHECK ("interaction_channels"."direction" in ('inbound', 'outbound', 'bidirectional')),
  CONSTRAINT "interaction_channels_status_ck" CHECK ("interaction_channels"."status" in ('active', 'disabled', 'archived')),
  CONSTRAINT "interaction_channels_endpoint_object_ck" CHECK (jsonb_typeof("interaction_channels"."endpoint_ref") = 'object'),
  CONSTRAINT "interaction_channels_config_object_ck" CHECK (jsonb_typeof("interaction_channels"."config") = 'object'),
  CONSTRAINT "interaction_channels_key_nonempty_ck" CHECK (length(trim("interaction_channels"."key")) > 0),
  CONSTRAINT "interaction_channels_label_nonempty_ck" CHECK (length(trim("interaction_channels"."label")) > 0),
  CONSTRAINT "interaction_channels_integration_nonempty_ck" CHECK (length(trim("interaction_channels"."integration_key")) > 0)
);
--> statement-breakpoint
ALTER TABLE "interaction_channels"
  ADD CONSTRAINT "interaction_channels_connection_id_connections_id_fk"
  FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id")
  ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "interaction_channels_connection_idx" ON "interaction_channels" USING btree ("connection_id");
--> statement-breakpoint

ALTER TABLE "runs" ADD COLUMN "trigger_integration_key" text;
--> statement-breakpoint
UPDATE "runs" r
SET "trigger_integration_key" = CASE c."provider_key"
  WHEN 'gmail' THEN 'gmail'
  WHEN 'telegram' THEN 'telegram'
  ELSE NULL
END
FROM "connections" c
WHERE r."trigger_connection_id" = c."id"
  AND r."trigger_connection_id" IS NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "runs"
    WHERE "trigger_connection_id" IS NOT NULL
      AND "trigger_integration_key" IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot infer trigger integration for an existing run';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_trigger_binding_pair_ck" CHECK (
  ("runs"."trigger_connection_id" is null and "runs"."trigger_integration_key" is null)
  or ("runs"."trigger_connection_id" is not null and "runs"."trigger_integration_key" is not null)
);
--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_trigger_integration_nonempty_ck" CHECK (
  "runs"."trigger_integration_key" is null
  or length(trim("runs"."trigger_integration_key")) > 0
);
--> statement-breakpoint

ALTER TABLE "action_executions" ADD COLUMN "integration_key" text;
--> statement-breakpoint
ALTER TABLE "action_executions" ADD COLUMN "action_key" text;
--> statement-breakpoint
UPDATE "action_executions"
SET
  "integration_key" = CASE "kind"
    WHEN 'gmail.archive' THEN 'gmail'
    WHEN 'gmail.report_spam' THEN 'gmail'
    WHEN 'telegram.notify' THEN 'telegram'
    ELSE NULL
  END,
  "action_key" = CASE "kind"
    WHEN 'gmail.archive' THEN 'archive-message'
    WHEN 'gmail.report_spam' THEN 'report-spam'
    WHEN 'telegram.notify' THEN 'send-message'
    ELSE NULL
  END;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "action_executions"
    WHERE "integration_key" IS NULL OR "action_key" IS NULL
  ) THEN
    RAISE EXCEPTION 'Unknown legacy action_executions.kind; migration requires an explicit mapping';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "action_executions" ALTER COLUMN "integration_key" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "action_executions" ALTER COLUMN "action_key" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "action_executions" DROP CONSTRAINT "action_executions_kind_nonempty_ck";
--> statement-breakpoint
ALTER TABLE "action_executions" DROP COLUMN "kind";
--> statement-breakpoint
ALTER TABLE "action_executions" ADD CONSTRAINT "action_executions_integration_nonempty_ck" CHECK (length(trim("action_executions"."integration_key")) > 0);
--> statement-breakpoint
ALTER TABLE "action_executions" ADD CONSTRAINT "action_executions_action_nonempty_ck" CHECK (length(trim("action_executions"."action_key")) > 0);

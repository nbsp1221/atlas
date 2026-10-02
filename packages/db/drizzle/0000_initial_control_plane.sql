CREATE TABLE "action_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_execution_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"connection_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"execution_status" text NOT NULL,
	"verification_status" text NOT NULL,
	"verified_by_node_execution_id" uuid,
	"external_ref" text,
	"request_snapshot" jsonb NOT NULL,
	"response_snapshot" jsonb,
	"verification_evidence" jsonb,
	"error" jsonb,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	CONSTRAINT "action_executions_node_sequence_uq" UNIQUE("node_execution_id","sequence"),
	CONSTRAINT "action_executions_connection_idempotency_uq" UNIQUE("connection_id","idempotency_key"),
	CONSTRAINT "action_executions_sequence_positive_ck" CHECK ("action_executions"."sequence" > 0),
	CONSTRAINT "action_executions_execution_status_ck" CHECK ("action_executions"."execution_status" in ('running', 'succeeded', 'failed', 'unknown')),
	CONSTRAINT "action_executions_verification_status_ck" CHECK ("action_executions"."verification_status" in ('pending', 'verified', 'unverified', 'failed')),
	CONSTRAINT "action_executions_kind_nonempty_ck" CHECK (length(trim("action_executions"."kind")) > 0),
	CONSTRAINT "action_executions_idempotency_nonempty_ck" CHECK (length(trim("action_executions"."idempotency_key")) > 0),
	CONSTRAINT "action_executions_finished_after_started_ck" CHECK ("action_executions"."finished_at" is null or "action_executions"."finished_at" >= "action_executions"."started_at"),
	CONSTRAINT "action_executions_verification_timestamp_ck" CHECK (("action_executions"."verification_status" = 'pending' and "action_executions"."verified_at" is null)
        or ("action_executions"."verification_status" <> 'pending' and "action_executions"."verified_at" is not null)),
	CONSTRAINT "action_executions_verified_after_started_ck" CHECK ("action_executions"."verified_at" is null or "action_executions"."verified_at" >= "action_executions"."started_at")
);
--> statement-breakpoint
CREATE TABLE "automation_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"definition_schema_version" integer NOT NULL,
	"graph_definition" jsonb NOT NULL,
	"definition_hash" text NOT NULL,
	"source_revision" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_versions_automation_version_uq" UNIQUE("automation_id","version_number"),
	CONSTRAINT "automation_versions_automation_id_id_uq" UNIQUE("automation_id","id"),
	CONSTRAINT "automation_versions_version_positive_ck" CHECK ("automation_versions"."version_number" > 0),
	CONSTRAINT "automation_versions_schema_version_positive_ck" CHECK ("automation_versions"."definition_schema_version" > 0),
	CONSTRAINT "automation_versions_graph_object_ck" CHECK (jsonb_typeof("automation_versions"."graph_definition") = 'object'),
	CONSTRAINT "automation_versions_definition_hash_nonempty_ck" CHECK (length(trim("automation_versions"."definition_hash")) > 0)
);
--> statement-breakpoint
CREATE TABLE "automations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text NOT NULL,
	"active_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automations_key_uq" UNIQUE("key"),
	CONSTRAINT "automations_status_ck" CHECK ("automations"."status" in ('active', 'paused', 'archived')),
	CONSTRAINT "automations_key_nonempty_ck" CHECK (length(trim("automations"."key")) > 0),
	CONSTRAINT "automations_name_nonempty_ck" CHECK (length(trim("automations"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"provider" text NOT NULL,
	"label" text NOT NULL,
	"config" jsonb NOT NULL,
	"credential_ref" text,
	"status" text NOT NULL,
	"last_check_status" text,
	"last_checked_at" timestamp with time zone,
	"last_error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connections_key_uq" UNIQUE("key"),
	CONSTRAINT "connections_status_ck" CHECK ("connections"."status" in ('active', 'disabled', 'archived')),
	CONSTRAINT "connections_last_check_status_ck" CHECK ("connections"."last_check_status" is null or "connections"."last_check_status" in ('healthy', 'error')),
	CONSTRAINT "connections_config_object_ck" CHECK (jsonb_typeof("connections"."config") = 'object'),
	CONSTRAINT "connections_key_nonempty_ck" CHECK (length(trim("connections"."key")) > 0),
	CONSTRAINT "connections_provider_nonempty_ck" CHECK (length(trim("connections"."provider")) > 0),
	CONSTRAINT "connections_label_nonempty_ck" CHECK (length(trim("connections"."label")) > 0)
);
--> statement-breakpoint
CREATE TABLE "model_invocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_execution_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"status" text NOT NULL,
	"model_provider" text NOT NULL,
	"model" text NOT NULL,
	"model_parameters" jsonb NOT NULL,
	"provider_request_id" text,
	"input_snapshot" jsonb NOT NULL,
	"output_snapshot" jsonb,
	"error" jsonb,
	"usage_details" jsonb,
	"cost_details" jsonb,
	"cost_usd" numeric(20, 12),
	"duration_ms" integer,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "model_invocations_node_sequence_uq" UNIQUE("node_execution_id","sequence"),
	CONSTRAINT "model_invocations_sequence_positive_ck" CHECK ("model_invocations"."sequence" > 0),
	CONSTRAINT "model_invocations_status_ck" CHECK ("model_invocations"."status" in ('running', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "model_invocations_provider_nonempty_ck" CHECK (length(trim("model_invocations"."model_provider")) > 0),
	CONSTRAINT "model_invocations_model_nonempty_ck" CHECK (length(trim("model_invocations"."model")) > 0),
	CONSTRAINT "model_invocations_parameters_object_ck" CHECK (jsonb_typeof("model_invocations"."model_parameters") = 'object'),
	CONSTRAINT "model_invocations_cost_nonnegative_ck" CHECK ("model_invocations"."cost_usd" is null or "model_invocations"."cost_usd" >= 0),
	CONSTRAINT "model_invocations_duration_nonnegative_ck" CHECK ("model_invocations"."duration_ms" is null or "model_invocations"."duration_ms" >= 0),
	CONSTRAINT "model_invocations_finished_after_started_ck" CHECK ("model_invocations"."finished_at" is null or "model_invocations"."finished_at" >= "model_invocations"."started_at")
);
--> statement-breakpoint
CREATE TABLE "node_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"node_key" text NOT NULL,
	"node_kind" text NOT NULL,
	"status" text NOT NULL,
	"retry_of_node_execution_id" uuid,
	"selected_edge_key" text,
	"input_snapshot" jsonb NOT NULL,
	"output_snapshot" jsonb,
	"error" jsonb,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "node_executions_run_sequence_uq" UNIQUE("run_id","sequence"),
	CONSTRAINT "node_executions_run_node_id_uq" UNIQUE("run_id","node_key","id"),
	CONSTRAINT "node_executions_sequence_positive_ck" CHECK ("node_executions"."sequence" > 0),
	CONSTRAINT "node_executions_status_ck" CHECK ("node_executions"."status" in ('running', 'succeeded', 'failed', 'skipped', 'cancelled')),
	CONSTRAINT "node_executions_key_nonempty_ck" CHECK (length(trim("node_executions"."node_key")) > 0),
	CONSTRAINT "node_executions_kind_nonempty_ck" CHECK (length(trim("node_executions"."node_kind")) > 0),
	CONSTRAINT "node_executions_retry_not_self_ck" CHECK ("node_executions"."retry_of_node_execution_id" is null or "node_executions"."retry_of_node_execution_id" <> "node_executions"."id"),
	CONSTRAINT "node_executions_finished_after_started_ck" CHECK ("node_executions"."finished_at" is null or "node_executions"."finished_at" >= "node_executions"."started_at")
);
--> statement-breakpoint
CREATE TABLE "node_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_execution_id" uuid NOT NULL,
	"verdict" text NOT NULL,
	"expected_output" jsonb,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "node_feedback_node_execution_uq" UNIQUE("node_execution_id"),
	CONSTRAINT "node_feedback_verdict_ck" CHECK ("node_feedback"."verdict" in ('correct', 'incorrect'))
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"automation_version_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"status" text NOT NULL,
	"trigger_connection_id" uuid,
	"idempotency_key" text,
	"parent_node_execution_id" uuid,
	"replay_of_run_id" uuid,
	"trigger_snapshot" jsonb,
	"input_snapshot" jsonb NOT NULL,
	"output_snapshot" jsonb,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "runs_mode_ck" CHECK ("runs"."mode" in ('live', 'replay', 'test')),
	CONSTRAINT "runs_status_ck" CHECK ("runs"."status" in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "runs_replay_lineage_ck" CHECK (("runs"."mode" = 'replay' and "runs"."replay_of_run_id" is not null)
        or ("runs"."mode" <> 'replay' and "runs"."replay_of_run_id" is null)),
	CONSTRAINT "runs_replay_not_self_ck" CHECK ("runs"."replay_of_run_id" is null or "runs"."replay_of_run_id" <> "runs"."id"),
	CONSTRAINT "runs_started_after_created_ck" CHECK ("runs"."started_at" is null or "runs"."started_at" >= "runs"."created_at"),
	CONSTRAINT "runs_finished_after_started_ck" CHECK ("runs"."finished_at" is null
        or "runs"."started_at" is null
        or "runs"."finished_at" >= "runs"."started_at")
);
--> statement-breakpoint
ALTER TABLE "action_executions" ADD CONSTRAINT "action_executions_node_execution_id_node_executions_id_fk" FOREIGN KEY ("node_execution_id") REFERENCES "public"."node_executions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_executions" ADD CONSTRAINT "action_executions_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_executions" ADD CONSTRAINT "action_executions_verifier_fk" FOREIGN KEY ("verified_by_node_execution_id") REFERENCES "public"."node_executions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_versions" ADD CONSTRAINT "automation_versions_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_active_version_fk" FOREIGN KEY ("id","active_version_id") REFERENCES "public"."automation_versions"("automation_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_invocations" ADD CONSTRAINT "model_invocations_node_execution_id_node_executions_id_fk" FOREIGN KEY ("node_execution_id") REFERENCES "public"."node_executions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_executions" ADD CONSTRAINT "node_executions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_executions" ADD CONSTRAINT "node_executions_retry_fk" FOREIGN KEY ("run_id","node_key","retry_of_node_execution_id") REFERENCES "public"."node_executions"("run_id","node_key","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_feedback" ADD CONSTRAINT "node_feedback_node_execution_id_node_executions_id_fk" FOREIGN KEY ("node_execution_id") REFERENCES "public"."node_executions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_trigger_connection_id_connections_id_fk" FOREIGN KEY ("trigger_connection_id") REFERENCES "public"."connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_parent_node_execution_id_node_executions_id_fk" FOREIGN KEY ("parent_node_execution_id") REFERENCES "public"."node_executions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_replay_of_run_id_runs_id_fk" FOREIGN KEY ("replay_of_run_id") REFERENCES "public"."runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_automation_version_fk" FOREIGN KEY ("automation_id","automation_version_id") REFERENCES "public"."automation_versions"("automation_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "action_executions_verification_started_idx" ON "action_executions" USING btree ("verification_status","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "action_executions_connection_started_idx" ON "action_executions" USING btree ("connection_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "action_executions_verifier_idx" ON "action_executions" USING btree ("verified_by_node_execution_id") WHERE "action_executions"."verified_by_node_execution_id" is not null;--> statement-breakpoint
CREATE INDEX "model_invocations_model_started_idx" ON "model_invocations" USING btree ("model_provider","model","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "model_invocations_provider_request_idx" ON "model_invocations" USING btree ("provider_request_id") WHERE "model_invocations"."provider_request_id" is not null;--> statement-breakpoint
CREATE INDEX "node_executions_node_started_idx" ON "node_executions" USING btree ("node_key","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "node_executions_retry_of_idx" ON "node_executions" USING btree ("retry_of_node_execution_id") WHERE "node_executions"."retry_of_node_execution_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "runs_live_idempotency_uq" ON "runs" USING btree ("automation_id","idempotency_key") WHERE "runs"."mode" = 'live' and "runs"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "runs_automation_created_idx" ON "runs" USING btree ("automation_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "runs_version_created_idx" ON "runs" USING btree ("automation_version_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "runs_status_created_idx" ON "runs" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "runs_trigger_connection_created_idx" ON "runs" USING btree ("trigger_connection_id","created_at" DESC NULLS LAST) WHERE "runs"."trigger_connection_id" is not null;--> statement-breakpoint
CREATE INDEX "runs_replay_of_idx" ON "runs" USING btree ("replay_of_run_id") WHERE "runs"."replay_of_run_id" is not null;--> statement-breakpoint
CREATE INDEX "runs_parent_node_idx" ON "runs" USING btree ("parent_node_execution_id") WHERE "runs"."parent_node_execution_id" is not null;
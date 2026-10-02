-- Additive only: do not adopt, rewrite, or reset historical executions.
CREATE TABLE "archive_attempt_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action_execution_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"operation" text NOT NULL,
	"phase" text NOT NULL,
	"attempt" integer NOT NULL,
	"evidence" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "archive_attempt_events_sequence_uq" UNIQUE("action_execution_id","sequence"),
	CONSTRAINT "archive_attempt_events_phase_ck" CHECK ("archive_attempt_events"."phase" in ('started','result','interrupted')),
	CONSTRAINT "archive_attempt_events_operation_ck" CHECK ("archive_attempt_events"."operation" in ('modify','get','stop')),
	CONSTRAINT "archive_attempt_events_sequence_ck" CHECK ("archive_attempt_events"."sequence" > 0 and "archive_attempt_events"."attempt" >= 0),
	CONSTRAINT "archive_attempt_events_evidence_object_ck" CHECK (jsonb_typeof("archive_attempt_events"."evidence") = 'object')
);
--> statement-breakpoint
CREATE TABLE "archive_recoveries" (
	"action_execution_id" uuid PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"initial_revision" text NOT NULL,
	"state" text NOT NULL,
	"next_operation" text NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"write_not_before_at" timestamp with time zone,
	"deadline_at" timestamp with time zone NOT NULL,
	"policy" jsonb NOT NULL,
	"write_attempts" integer DEFAULT 0 NOT NULL,
	"read_attempts" integer DEFAULT 0 NOT NULL,
	"in_flight_operation" text,
	"in_flight_attempt" integer,
	"write_retry_allowed" boolean DEFAULT true NOT NULL,
	"last_write_outcome" text,
	"last_outcome" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "archive_recoveries_state_ck" CHECK ("archive_recoveries"."state" in ('pending','observed','stopped')),
	CONSTRAINT "archive_recoveries_operation_ck" CHECK ("archive_recoveries"."next_operation" in ('modify','get')),
	CONSTRAINT "archive_recoveries_attempts_ck" CHECK ("archive_recoveries"."write_attempts" >= 0 and "archive_recoveries"."read_attempts" >= 0),
	CONSTRAINT "archive_recoveries_schedule_ck" CHECK (("archive_recoveries"."state" = 'pending') = ("archive_recoveries"."next_attempt_at" is not null)),
	CONSTRAINT "archive_recoveries_message_id_nonempty_ck" CHECK (length("archive_recoveries"."message_id") > 0),
	CONSTRAINT "archive_recoveries_initial_revision_nonempty_ck" CHECK (length("archive_recoveries"."initial_revision") > 0),
	CONSTRAINT "archive_recoveries_policy_object_ck" CHECK (jsonb_typeof("archive_recoveries"."policy") = 'object'),
	CONSTRAINT "archive_recoveries_in_flight_operation_ck" CHECK ("archive_recoveries"."in_flight_operation" in ('modify','get')),
	CONSTRAINT "archive_recoveries_in_flight_pair_ck" CHECK (("archive_recoveries"."in_flight_operation" is null) = ("archive_recoveries"."in_flight_attempt" is null)),
	CONSTRAINT "archive_recoveries_in_flight_attempt_ck" CHECK ("archive_recoveries"."in_flight_attempt" > 0),
	CONSTRAINT "archive_recoveries_last_write_outcome_ck" CHECK ("archive_recoveries"."last_write_outcome" in ('acknowledged','failed','unknown')),
	CONSTRAINT "archive_recoveries_last_outcome_object_ck" CHECK (jsonb_typeof("archive_recoveries"."last_outcome") = 'object'),
	CONSTRAINT "archive_recoveries_deadline_ck" CHECK ("archive_recoveries"."deadline_at" > "archive_recoveries"."created_at")
);
--> statement-breakpoint
ALTER TABLE "archive_attempt_events" ADD CONSTRAINT "archive_attempt_events_recovery_fk" FOREIGN KEY ("action_execution_id") REFERENCES "public"."archive_recoveries"("action_execution_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive_recoveries" ADD CONSTRAINT "archive_recoveries_action_execution_id_action_executions_id_fk" FOREIGN KEY ("action_execution_id") REFERENCES "public"."action_executions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "archive_recoveries_due_idx" ON "archive_recoveries" USING btree ("next_attempt_at") WHERE "archive_recoveries"."state" = 'pending';
--> statement-breakpoint
CREATE FUNCTION guard_archive_attempt_events_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Archive attempt events are append-only' USING ERRCODE = '23514'; END;
$$;
--> statement-breakpoint
CREATE TRIGGER archive_attempt_events_immutable BEFORE UPDATE OR DELETE ON archive_attempt_events FOR EACH ROW EXECUTE FUNCTION guard_archive_attempt_events_immutable();
--> statement-breakpoint
CREATE FUNCTION guard_archive_recovery_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.action_execution_id, NEW.message_id, NEW.initial_revision, NEW.deadline_at, NEW.policy, NEW.created_at) IS DISTINCT FROM
    (OLD.action_execution_id, OLD.message_id, OLD.initial_revision, OLD.deadline_at, OLD.policy, OLD.created_at)
 OR (OLD.state <> 'pending' AND NEW IS DISTINCT FROM OLD)
 OR NEW.write_attempts < OLD.write_attempts OR NEW.read_attempts < OLD.read_attempts
 THEN RAISE EXCEPTION 'Archive recovery identity, budgets and terminal state are immutable' USING ERRCODE = '23514'; END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER archive_recovery_identity BEFORE UPDATE ON archive_recoveries FOR EACH ROW EXECUTE FUNCTION guard_archive_recovery_identity();

import { credentialSecrets } from "./credential-schema"
export * from "./credential-schema"
import { sql } from "drizzle-orm"
import {
  check,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core"
import type { ResourceRef } from "@workspace/domain/integrations"
import type {
  ActionExecutionStatus,
  AutomationGraphDefinition,
  AutomationStatus,
  ConnectionCheckStatus,
  ConnectionStatus,
  InteractionChannelDirection,
  InteractionChannelStatus,
  FeedbackVerdict,
  JsonObject,
  JsonValue,
  ModelInvocationStatus,
  NodeExecutionStatus,
  NodeKind,
  RunMode,
  RunStatus,
  VerificationStatus,
} from "@workspace/domain/persistence"

const timestamptz = (name: string) => timestamp(name, { withTimezone: true })

export const automations = pgTable(
  "automations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").$type<AutomationStatus>().notNull(),
    // The same-automation composite FK is added in the initial migration.
    activeVersionId: uuid("active_version_id"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at").defaultNow().notNull(),
  },
  (table) => [
    unique("automations_key_uq").on(table.key),
    check(
      "automations_status_ck",
      sql`${table.status} in ('active', 'paused', 'archived')`
    ),
    check("automations_key_nonempty_ck", sql`length(trim(${table.key})) > 0`),
    check("automations_name_nonempty_ck", sql`length(trim(${table.name})) > 0`),
  ]
)

export const automationVersions = pgTable(
  "automation_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    automationId: uuid("automation_id")
      .notNull()
      .references(() => automations.id, { onDelete: "restrict" }),
    versionNumber: integer("version_number").notNull(),
    definitionSchemaVersion: integer("definition_schema_version").notNull(),
    graphDefinition: jsonb("graph_definition")
      .$type<AutomationGraphDefinition>()
      .notNull(),
    definitionHash: text("definition_hash").notNull(),
    sourceRevision: text("source_revision"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("automation_versions_automation_version_uq").on(
      table.automationId,
      table.versionNumber
    ),
    unique("automation_versions_automation_id_id_uq").on(
      table.automationId,
      table.id
    ),
    check(
      "automation_versions_version_positive_ck",
      sql`${table.versionNumber} > 0`
    ),
    check(
      "automation_versions_schema_version_positive_ck",
      sql`${table.definitionSchemaVersion} > 0`
    ),
    check(
      "automation_versions_graph_object_ck",
      sql`jsonb_typeof(${table.graphDefinition}) = 'object'`
    ),
    check(
      "automation_versions_definition_hash_nonempty_ck",
      sql`length(trim(${table.definitionHash})) > 0`
    ),
  ]
)

export const connections = pgTable(
  "connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    key: text("key").notNull(),
    providerKey: text("provider_key").notNull(),
    label: text("label").notNull(),
    credentialRef: text("credential_ref"), // Legacy placeholders are not accepted by the credential resolver.
    credentialId: uuid("credential_id")
      .unique()
      .references(() => credentialSecrets.id, { onDelete: "restrict" }),
    authState: text("auth_state")
      .$type<"missing" | "unchecked" | "ready" | "reauth_required" | "error">()
      .default("missing")
      .notNull(),
    revision: integer("revision").default(1).notNull(),
    externalPrincipalType: text("external_principal_type"),
    externalPrincipalId: text("external_principal_id"),
    grants: jsonb("grants").$type<JsonObject>().default({}).notNull(),
    config: jsonb("config").$type<JsonObject>().notNull(),
    status: text("status").$type<ConnectionStatus>().notNull(),
    lastCheckStatus: text("last_check_status").$type<ConnectionCheckStatus>(),
    lastCheckedAt: timestamptz("last_checked_at"),
    lastError: jsonb("last_error").$type<JsonObject>(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at").defaultNow().notNull(),
  },
  (table) => [
    unique("connections_key_uq").on(table.key),
    check(
      "connections_auth_state_ck",
      sql`${table.authState} in ('missing', 'unchecked', 'ready', 'reauth_required', 'error')`
    ),
    check("connections_revision_positive_ck", sql`${table.revision} > 0`),
    check(
      "connections_ready_secret_ck",
      sql`${table.authState} != 'ready' or ${table.credentialId} is not null`
    ),
    check(
      "connections_status_ck",
      sql`${table.status} in ('active', 'disabled', 'archived')`
    ),
    check(
      "connections_last_check_status_ck",
      sql`${table.lastCheckStatus} is null or ${table.lastCheckStatus} in ('healthy', 'error')`
    ),
    check(
      "connections_config_object_ck",
      sql`jsonb_typeof(${table.config}) = 'object'`
    ),
    check(
      "connections_grants_object_ck",
      sql`jsonb_typeof(${table.grants}) = 'object'`
    ),
    check("connections_key_nonempty_ck", sql`length(trim(${table.key})) > 0`),
    check(
      "connections_provider_key_nonempty_ck",
      sql`length(trim(${table.providerKey})) > 0`
    ),
    check(
      "connections_label_nonempty_ck",
      sql`length(trim(${table.label})) > 0`
    ),
    check(
      "connections_principal_pair_ck",
      sql`(${table.externalPrincipalType} is null and ${table.externalPrincipalId} is null)
        or (${table.externalPrincipalType} is not null and ${table.externalPrincipalId} is not null)`
    ),
    check(
      "connections_principal_type_nonempty_ck",
      sql`${table.externalPrincipalType} is null or length(trim(${table.externalPrincipalType})) > 0`
    ),
    check(
      "connections_principal_id_nonempty_ck",
      sql`${table.externalPrincipalId} is null or length(trim(${table.externalPrincipalId})) > 0`
    ),
  ]
)

export const interactionChannels = pgTable(
  "interaction_channels",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    key: text("key").notNull(),
    label: text("label").notNull(),
    integrationKey: text("integration_key").notNull(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "restrict" }),
    endpointRef: jsonb("endpoint_ref").$type<ResourceRef>().notNull(),
    direction: text("direction").$type<InteractionChannelDirection>().notNull(),
    status: text("status").$type<InteractionChannelStatus>().notNull(),
    config: jsonb("config").$type<JsonObject>().notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at").defaultNow().notNull(),
  },
  (table) => [
    unique("interaction_channels_key_uq").on(table.key),
    index("interaction_channels_connection_idx").on(table.connectionId),
    check(
      "interaction_channels_direction_ck",
      sql`${table.direction} in ('inbound', 'outbound', 'bidirectional')`
    ),
    check(
      "interaction_channels_status_ck",
      sql`${table.status} in ('active', 'disabled', 'archived')`
    ),
    check(
      "interaction_channels_endpoint_object_ck",
      sql`jsonb_typeof(${table.endpointRef}) = 'object'`
    ),
    check(
      "interaction_channels_config_object_ck",
      sql`jsonb_typeof(${table.config}) = 'object'`
    ),
    check(
      "interaction_channels_key_nonempty_ck",
      sql`length(trim(${table.key})) > 0`
    ),
    check(
      "interaction_channels_label_nonempty_ck",
      sql`length(trim(${table.label})) > 0`
    ),
    check(
      "interaction_channels_integration_nonempty_ck",
      sql`length(trim(${table.integrationKey})) > 0`
    ),
  ]
)

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    automationId: uuid("automation_id").notNull(),
    automationVersionId: uuid("automation_version_id").notNull(),
    mode: text("mode").$type<RunMode>().notNull(),
    status: text("status").$type<RunStatus>().notNull(),
    triggerIntegrationKey: text("trigger_integration_key"),
    triggerConnectionId: uuid("trigger_connection_id").references(
      () => connections.id,
      {
        onDelete: "restrict",
      }
    ),
    idempotencyKey: text("idempotency_key"),
    parentNodeExecutionId: uuid("parent_node_execution_id").references(
      (): AnyPgColumn => nodeExecutions.id,
      { onDelete: "restrict" }
    ),
    replayOfRunId: uuid("replay_of_run_id").references(
      (): AnyPgColumn => runs.id,
      {
        onDelete: "restrict",
      }
    ),
    triggerSnapshot: jsonb("trigger_snapshot").$type<JsonValue>(),
    inputSnapshot: jsonb("input_snapshot").$type<JsonValue>().notNull(),
    outputSnapshot: jsonb("output_snapshot").$type<JsonValue>(),
    error: jsonb("error").$type<JsonObject>(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    startedAt: timestamptz("started_at"),
    finishedAt: timestamptz("finished_at"),
  },
  (table) => [
    foreignKey({
      name: "runs_automation_version_fk",
      columns: [table.automationId, table.automationVersionId],
      foreignColumns: [automationVersions.automationId, automationVersions.id],
    }).onDelete("restrict"),
    uniqueIndex("runs_live_idempotency_uq")
      .on(table.automationId, table.idempotencyKey)
      .where(
        sql`${table.mode} = 'live' and ${table.idempotencyKey} is not null`
      ),
    uniqueIndex("runs_test_event_idempotency_uq")
      .on(table.automationId, table.idempotencyKey)
      .where(
        sql`${table.mode} = 'test' and ${table.idempotencyKey} is not null`
      ),
    index("runs_automation_created_idx").on(
      table.automationId,
      table.createdAt.desc()
    ),
    index("runs_version_created_idx").on(
      table.automationVersionId,
      table.createdAt.desc()
    ),
    index("runs_status_created_idx").on(table.status, table.createdAt.desc()),
    index("runs_trigger_connection_created_idx")
      .on(table.triggerConnectionId, table.createdAt.desc())
      .where(sql`${table.triggerConnectionId} is not null`),
    index("runs_replay_of_idx")
      .on(table.replayOfRunId)
      .where(sql`${table.replayOfRunId} is not null`),
    index("runs_parent_node_idx")
      .on(table.parentNodeExecutionId)
      .where(sql`${table.parentNodeExecutionId} is not null`),
    check("runs_mode_ck", sql`${table.mode} in ('live', 'replay', 'test')`),
    check(
      "runs_trigger_binding_pair_ck",
      sql`(${table.triggerConnectionId} is null and ${table.triggerIntegrationKey} is null)
        or (${table.triggerConnectionId} is not null and ${table.triggerIntegrationKey} is not null)`
    ),
    check(
      "runs_trigger_integration_nonempty_ck",
      sql`${table.triggerIntegrationKey} is null or length(trim(${table.triggerIntegrationKey})) > 0`
    ),
    check(
      "runs_status_ck",
      sql`${table.status} in ('queued', 'running', 'succeeded', 'failed', 'cancelled')`
    ),
    check(
      "runs_replay_lineage_ck",
      sql`(${table.mode} = 'replay' and ${table.replayOfRunId} is not null)
        or (${table.mode} <> 'replay' and ${table.replayOfRunId} is null)`
    ),
    check(
      "runs_replay_not_self_ck",
      sql`${table.replayOfRunId} is null or ${table.replayOfRunId} <> ${table.id}`
    ),
    check(
      "runs_started_after_created_ck",
      sql`${table.startedAt} is null or ${table.startedAt} >= ${table.createdAt}`
    ),
    check(
      "runs_finished_after_started_ck",
      sql`${table.finishedAt} is null
        or ${table.startedAt} is null
        or ${table.finishedAt} >= ${table.startedAt}`
    ),
  ]
)

export const nodeExecutions = pgTable(
  "node_executions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    sequence: integer("sequence").notNull(),
    nodeKey: text("node_key").notNull(),
    nodeKind: text("node_kind").$type<NodeKind>().notNull(),
    status: text("status").$type<NodeExecutionStatus>().notNull(),
    retryOfNodeExecutionId: uuid("retry_of_node_execution_id"),
    selectedEdgeKey: text("selected_edge_key"),
    inputSnapshot: jsonb("input_snapshot").$type<JsonValue>().notNull(),
    outputSnapshot: jsonb("output_snapshot").$type<JsonValue>(),
    error: jsonb("error").$type<JsonObject>(),
    startedAt: timestamptz("started_at").notNull(),
    finishedAt: timestamptz("finished_at"),
  },
  (table) => [
    unique("node_executions_run_sequence_uq").on(table.runId, table.sequence),
    unique("node_executions_run_node_id_uq").on(
      table.runId,
      table.nodeKey,
      table.id
    ),
    foreignKey({
      name: "node_executions_retry_fk",
      columns: [table.runId, table.nodeKey, table.retryOfNodeExecutionId],
      foreignColumns: [table.runId, table.nodeKey, table.id],
    }).onDelete("restrict"),
    index("node_executions_node_started_idx").on(
      table.nodeKey,
      table.startedAt.desc()
    ),
    index("node_executions_retry_of_idx")
      .on(table.retryOfNodeExecutionId)
      .where(sql`${table.retryOfNodeExecutionId} is not null`),
    check("node_executions_sequence_positive_ck", sql`${table.sequence} > 0`),
    check(
      "node_executions_status_ck",
      sql`${table.status} in ('running', 'succeeded', 'failed', 'skipped', 'cancelled')`
    ),
    check(
      "node_executions_key_nonempty_ck",
      sql`length(trim(${table.nodeKey})) > 0`
    ),
    check(
      "node_executions_kind_nonempty_ck",
      sql`length(trim(${table.nodeKind})) > 0`
    ),
    check(
      "node_executions_retry_not_self_ck",
      sql`${table.retryOfNodeExecutionId} is null or ${table.retryOfNodeExecutionId} <> ${table.id}`
    ),
    check(
      "node_executions_finished_after_started_ck",
      sql`${table.finishedAt} is null or ${table.finishedAt} >= ${table.startedAt}`
    ),
  ]
)

export const modelInvocations = pgTable(
  "model_invocations",
  {
    connectionId: uuid("connection_id").references(() => connections.id, {
      onDelete: "restrict",
    }),
    id: uuid("id").defaultRandom().primaryKey(),
    nodeExecutionId: uuid("node_execution_id")
      .notNull()
      .references(() => nodeExecutions.id, { onDelete: "restrict" }),
    sequence: integer("sequence").notNull(),
    status: text("status").$type<ModelInvocationStatus>().notNull(),
    modelProvider: text("model_provider").notNull(),
    model: text("model").notNull(),
    modelParameters: jsonb("model_parameters").$type<JsonObject>().notNull(),
    providerRequestId: text("provider_request_id"),
    inputSnapshot: jsonb("input_snapshot").$type<JsonValue>().notNull(),
    outputSnapshot: jsonb("output_snapshot").$type<JsonValue>(),
    error: jsonb("error").$type<JsonObject>(),
    usageDetails: jsonb("usage_details").$type<JsonObject>(),
    costDetails: jsonb("cost_details").$type<JsonObject>(),
    costUsd: numeric("cost_usd", { precision: 20, scale: 12 }),
    durationMs: integer("duration_ms"),
    startedAt: timestamptz("started_at").notNull(),
    finishedAt: timestamptz("finished_at"),
  },
  (table) => [
    unique("model_invocations_node_sequence_uq").on(
      table.nodeExecutionId,
      table.sequence
    ),
    index("model_invocations_model_started_idx").on(
      table.modelProvider,
      table.model,
      table.startedAt.desc()
    ),
    index("model_invocations_provider_request_idx")
      .on(table.providerRequestId)
      .where(sql`${table.providerRequestId} is not null`),
    check("model_invocations_sequence_positive_ck", sql`${table.sequence} > 0`),
    check(
      "model_invocations_status_ck",
      sql`${table.status} in ('running', 'succeeded', 'failed', 'cancelled')`
    ),
    check(
      "model_invocations_provider_nonempty_ck",
      sql`length(trim(${table.modelProvider})) > 0`
    ),
    check(
      "model_invocations_model_nonempty_ck",
      sql`length(trim(${table.model})) > 0`
    ),
    check(
      "model_invocations_parameters_object_ck",
      sql`jsonb_typeof(${table.modelParameters}) = 'object'`
    ),
    check(
      "model_invocations_cost_nonnegative_ck",
      sql`${table.costUsd} is null or ${table.costUsd} >= 0`
    ),
    check(
      "model_invocations_duration_nonnegative_ck",
      sql`${table.durationMs} is null or ${table.durationMs} >= 0`
    ),
    check(
      "model_invocations_finished_after_started_ck",
      sql`${table.finishedAt} is null or ${table.finishedAt} >= ${table.startedAt}`
    ),
  ]
)

export const actionExecutions = pgTable(
  "action_executions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    nodeExecutionId: uuid("node_execution_id")
      .notNull()
      .references(() => nodeExecutions.id, { onDelete: "restrict" }),
    sequence: integer("sequence").notNull(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "restrict" }),
    integrationKey: text("integration_key").notNull(),
    actionKey: text("action_key").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    executionStatus: text("execution_status")
      .$type<ActionExecutionStatus>()
      .notNull(),
    verificationStatus: text("verification_status")
      .$type<VerificationStatus>()
      .notNull(),
    verifiedByNodeExecutionId: uuid("verified_by_node_execution_id"),
    externalRef: text("external_ref"),
    requestSnapshot: jsonb("request_snapshot").$type<JsonValue>().notNull(),
    responseSnapshot: jsonb("response_snapshot").$type<JsonValue>(),
    verificationEvidence: jsonb("verification_evidence").$type<JsonValue>(),
    error: jsonb("error").$type<JsonObject>(),
    startedAt: timestamptz("started_at").notNull(),
    finishedAt: timestamptz("finished_at"),
    verifiedAt: timestamptz("verified_at"),
  },
  (table) => [
    unique("action_executions_node_sequence_uq").on(
      table.nodeExecutionId,
      table.sequence
    ),
    unique("action_executions_connection_idempotency_uq").on(
      table.connectionId,
      table.idempotencyKey
    ),
    foreignKey({
      name: "action_executions_verifier_fk",
      columns: [table.verifiedByNodeExecutionId],
      foreignColumns: [nodeExecutions.id],
    }).onDelete("restrict"),
    index("action_executions_verification_started_idx").on(
      table.verificationStatus,
      table.startedAt.desc()
    ),
    index("action_executions_connection_started_idx").on(
      table.connectionId,
      table.startedAt.desc()
    ),
    index("action_executions_verifier_idx")
      .on(table.verifiedByNodeExecutionId)
      .where(sql`${table.verifiedByNodeExecutionId} is not null`),
    check("action_executions_sequence_positive_ck", sql`${table.sequence} > 0`),
    check(
      "action_executions_execution_status_ck",
      sql`${table.executionStatus} in ('running', 'succeeded', 'failed', 'unknown')`
    ),
    check(
      "action_executions_verification_status_ck",
      sql`${table.verificationStatus} in ('pending', 'verified', 'unverified', 'failed')`
    ),
    check(
      "action_executions_integration_nonempty_ck",
      sql`length(trim(${table.integrationKey})) > 0`
    ),
    check(
      "action_executions_action_nonempty_ck",
      sql`length(trim(${table.actionKey})) > 0`
    ),
    check(
      "action_executions_idempotency_nonempty_ck",
      sql`length(trim(${table.idempotencyKey})) > 0`
    ),
    check(
      "action_executions_finished_after_started_ck",
      sql`${table.finishedAt} is null or ${table.finishedAt} >= ${table.startedAt}`
    ),
    check(
      "action_executions_verification_timestamp_ck",
      sql`(${table.verificationStatus} = 'pending' and ${table.verifiedAt} is null)
        or (${table.verificationStatus} <> 'pending' and ${table.verifiedAt} is not null)`
    ),
    check(
      "action_executions_verified_after_started_ck",
      sql`${table.verifiedAt} is null or ${table.verifiedAt} >= ${table.startedAt}`
    ),
  ]
)

export const nodeFeedback = pgTable(
  "node_feedback",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    nodeExecutionId: uuid("node_execution_id")
      .notNull()
      .references(() => nodeExecutions.id, { onDelete: "restrict" }),
    verdict: text("verdict").$type<FeedbackVerdict>().notNull(),
    expectedOutput: jsonb("expected_output").$type<JsonValue>(),
    note: text("note"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at").defaultNow().notNull(),
  },
  (table) => [
    unique("node_feedback_node_execution_uq").on(table.nodeExecutionId),
    check(
      "node_feedback_verdict_ck",
      sql`${table.verdict} in ('correct', 'incorrect')`
    ),
  ]
)

// One archive intent's mutable schedule, never a replacement Run or action.
export const archiveRecoveries = pgTable(
  "archive_recoveries",
  {
    actionExecutionId: uuid("action_execution_id")
      .primaryKey()
      .references(() => actionExecutions.id, { onDelete: "restrict" }),
    messageId: text("message_id").notNull(),
    initialRevision: text("initial_revision").notNull(),
    state: text("state")
      .$type<import("@workspace/domain/persistence").ArchiveRecoveryState>()
      .notNull(),
    nextOperation: text("next_operation")
      .$type<import("@workspace/domain/persistence").ArchiveOperation>()
      .notNull(),
    nextAttemptAt: timestamptz("next_attempt_at"),
    writeNotBeforeAt: timestamptz("write_not_before_at"),
    deadlineAt: timestamptz("deadline_at").notNull(),
    policy: jsonb("policy")
      .$type<import("@workspace/domain/persistence").ArchiveRecoveryPolicy>()
      .notNull(),
    writeAttempts: integer("write_attempts").notNull().default(0),
    readAttempts: integer("read_attempts").notNull().default(0),
    inFlightOperation: text("in_flight_operation").$type<
      import("@workspace/domain/persistence").ArchiveOperation
    >(),
    inFlightAttempt: integer("in_flight_attempt"),
    writeRetryAllowed: boolean("write_retry_allowed").notNull().default(true),
    lastWriteOutcome: text("last_write_outcome").$type<
      "acknowledged" | "failed" | "unknown"
    >(),
    lastOutcome: jsonb("last_outcome").$type<JsonObject>(),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
  },
  (table) => [
    index("archive_recoveries_due_idx")
      .on(table.nextAttemptAt)
      .where(sql`${table.state} = 'pending'`),
    check(
      "archive_recoveries_state_ck",
      sql`${table.state} in ('pending','observed','stopped')`
    ),
    check(
      "archive_recoveries_operation_ck",
      sql`${table.nextOperation} in ('modify','get')`
    ),
    check(
      "archive_recoveries_attempts_ck",
      sql`${table.writeAttempts} >= 0 and ${table.readAttempts} >= 0`
    ),
    check(
      "archive_recoveries_schedule_ck",
      sql`(${table.state} = 'pending') = (${table.nextAttemptAt} is not null)`
    ),
    check(
      "archive_recoveries_message_id_nonempty_ck",
      sql`length(${table.messageId}) > 0`
    ),
    check(
      "archive_recoveries_initial_revision_nonempty_ck",
      sql`length(${table.initialRevision}) > 0`
    ),
    check(
      "archive_recoveries_policy_object_ck",
      sql`jsonb_typeof(${table.policy}) = 'object'`
    ),
    check(
      "archive_recoveries_in_flight_operation_ck",
      sql`${table.inFlightOperation} in ('modify','get')`
    ),
    check(
      "archive_recoveries_in_flight_pair_ck",
      sql`(${table.inFlightOperation} is null) = (${table.inFlightAttempt} is null)`
    ),
    check(
      "archive_recoveries_in_flight_attempt_ck",
      sql`${table.inFlightAttempt} > 0`
    ),
    check(
      "archive_recoveries_last_write_outcome_ck",
      sql`${table.lastWriteOutcome} in ('acknowledged','failed','unknown')`
    ),
    check(
      "archive_recoveries_last_outcome_object_ck",
      sql`jsonb_typeof(${table.lastOutcome}) = 'object'`
    ),
    check(
      "archive_recoveries_deadline_ck",
      sql`${table.deadlineAt} > ${table.createdAt}`
    ),
  ]
)
export const archiveAttemptEvents = pgTable(
  "archive_attempt_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actionExecutionId: uuid("action_execution_id").notNull(),
    sequence: integer("sequence").notNull(),
    operation: text("operation")
      .$type<
        import("@workspace/domain/persistence").ArchiveOperation | "stop"
      >()
      .notNull(),
    phase: text("phase")
      .$type<"started" | "result" | "interrupted">()
      .notNull(),
    attempt: integer("attempt").notNull(),
    evidence: jsonb("evidence").$type<JsonObject>().notNull(),
    createdAt: timestamptz("created_at").notNull(),
  },
  (table) => [
    foreignKey({
      name: "archive_attempt_events_recovery_fk",
      columns: [table.actionExecutionId],
      foreignColumns: [archiveRecoveries.actionExecutionId],
    }).onDelete("restrict"),
    unique("archive_attempt_events_sequence_uq").on(
      table.actionExecutionId,
      table.sequence
    ),
    check(
      "archive_attempt_events_phase_ck",
      sql`${table.phase} in ('started','result','interrupted')`
    ),
    check(
      "archive_attempt_events_operation_ck",
      sql`${table.operation} in ('modify','get','stop')`
    ),
    check(
      "archive_attempt_events_sequence_ck",
      sql`${table.sequence} > 0 and ${table.attempt} >= 0`
    ),
    check(
      "archive_attempt_events_evidence_object_ck",
      sql`jsonb_typeof(${table.evidence}) = 'object'`
    ),
  ]
)
export * from "./auth-schema"

import type {
  Automation,
  AutomationGraph,
  Connection,
  Overview,
  RunDetail,
  RunListItem,
  RunVerification,
} from "@workspace/domain"
import type {
  AutomationGraphDefinition,
  JsonObject,
  JsonValue,
} from "@workspace/domain/persistence"
import type {
  createReadRepository,
  actionExecutions,
  archiveRecoveries,
  archiveAttemptEvents,
  modelInvocations,
  nodeExecutions,
} from "@workspace/db"

type ReadRepository = ReturnType<typeof createReadRepository>
type NodeRow = typeof nodeExecutions.$inferSelect
type ModelRow = typeof modelInvocations.$inferSelect
type ActionRow = typeof actionExecutions.$inferSelect
type ArchiveRecoveryRow = typeof archiveRecoveries.$inferSelect
type ArchiveAttemptRow = typeof archiveAttemptEvents.$inferSelect
type WithOptionalArchiveEvidence<T> = Omit<
  T,
  "archiveRecoveries" | "archiveAttempts"
> & {
  archiveRecoveries?: ArchiveRecoveryRow[]
  archiveAttempts?: ArchiveAttemptRow[]
}

function object(value: JsonValue | null): JsonObject {
  return value && !Array.isArray(value) && typeof value === "object"
    ? value
    : {}
}

function stringField(value: JsonValue | undefined) {
  return typeof value === "string" ? value : undefined
}

function numberMap(value: JsonObject | null) {
  if (!value) return {}
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number"
    )
  )
}

function median(values: number[]) {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
    : sorted[middle]
}

function durationMs(startedAt: Date, finishedAt: Date | null) {
  if (!finishedAt) return undefined
  return Math.max(0, finishedAt.getTime() - startedAt.getTime())
}

function totalCost(models: ModelRow[]) {
  return models.reduce(
    (sum, invocation) => sum + Number(invocation.costUsd ?? 0),
    0
  )
}

// Recovery scheduling and final readback are separate from write execution.
// In particular, an observed desired state does not prove an unknown write.
function actionVerification(
  action: ActionRow,
  recovery?: ArchiveRecoveryRow
): RunVerification {
  if (recovery?.state === "stopped") return "failed"
  if (recovery?.state === "pending") return "pending"
  if (
    recovery?.state === "observed" &&
    action.verificationStatus === "verified"
  )
    return "verified"
  if (
    action.executionStatus === "failed" ||
    action.verificationStatus === "failed"
  )
    return "failed"
  if (action.executionStatus === "unknown") return "pending"
  return action.verificationStatus
}

function verification(
  actions: ActionRow[],
  runStatus: string,
  recoveries: ArchiveRecoveryRow[] = []
): RunVerification {
  if (actions.length === 0)
    return runStatus === "failed" ? "failed" : "completed"

  const statuses = actions.map((action) =>
    actionVerification(
      action,
      recoveries.find((recovery) => recovery.actionExecutionId === action.id)
    )
  )
  if (statuses.includes("failed")) return "failed"
  if (
    actions.some(
      (action, index) =>
        statuses[index] === "pending" &&
        (action.executionStatus === "unknown" ||
          recoveries.some(
            (recovery) =>
              recovery.actionExecutionId === action.id &&
              recovery.state === "pending"
          ))
    )
  )
    return "pending"
  // Preserve legacy aggregate precedence when no archive recovery intervenes.
  if (statuses.includes("unverified")) return "unverified"
  if (statuses.includes("pending")) return "pending"
  return "verified"
}

function actionNeedsAttention(
  action: ActionRow,
  recovery?: ArchiveRecoveryRow
) {
  return actionVerification(action, recovery) !== "verified"
}

function configString(config: JsonObject, key: string) {
  return stringField(config[key])
}

export function toAutomationGraph(
  automationKey: string,
  versionNumber: number,
  definition: AutomationGraphDefinition,
  runtime: {
    nodes: NodeRow[]
    models: ModelRow[]
    actions: ActionRow[]
    archiveRecoveries?: ArchiveRecoveryRow[]
  }
): AutomationGraph {
  return {
    automationId: automationKey,
    version: versionNumber,
    nodes: definition.nodes.map((definitionNode) => {
      const executions = runtime.nodes.filter(
        (node) => node.nodeKey === definitionNode.key
      )
      const executionIds = new Set(executions.map((node) => node.id))
      const modelCalls = runtime.models.filter((model) =>
        executionIds.has(model.nodeExecutionId)
      )
      const nodeActions = runtime.actions.filter((action) =>
        executionIds.has(action.nodeExecutionId)
      )
      const verifiedActions = runtime.actions.filter(
        (action) =>
          action.verifiedByNodeExecutionId &&
          executionIds.has(action.verifiedByNodeExecutionId)
      )

      const attention =
        executions.some(
          (node) => node.status === "failed" || node.status === "cancelled"
        ) ||
        [...nodeActions, ...verifiedActions].some((action) =>
          actionNeedsAttention(
            action,
            runtime.archiveRecoveries?.find(
              (recovery) => recovery.actionExecutionId === action.id
            )
          )
        )

      const config = definitionNode.config
      const configuredModel = configString(config, "model")
      const observedModel =
        [...modelCalls]
          .reverse()
          .find((invocation) => invocation.status === "succeeded")?.model ??
        undefined

      return {
        id: definitionNode.key,
        key: definitionNode.key,
        kind: definitionNode.kind,
        label: definitionNode.label ?? definitionNode.key,
        model: configuredModel ?? observedModel,
        prompt: configString(config, "prompt"),
        executions: executions.length,
        medianLatencyMs: median(
          executions
            .map((node) => durationMs(node.startedAt, node.finishedAt))
            .filter((value): value is number => value !== undefined)
        ),
        costUsd: modelCalls.length > 0 ? totalCost(modelCalls) : undefined,
        health:
          executions.length === 0
            ? "neutral"
            : attention
              ? "attention"
              : "healthy",
        detail: configString(config, "detail"),
        implementation: config.implementation,
      }
    }),
    edges: definition.edges.map((edge) => ({
      id: edge.key,
      source: edge.source,
      target: edge.target,
      label: edge.label,
    })),
  }
}

export async function automationReadModel(
  repository: ReadRepository,
  row: Awaited<ReturnType<ReadRepository["findAutomationByKey"]>>,
  since: Date
): Promise<Automation | null> {
  if (!row?.version) return null

  const runtime = await repository.runtimeForAutomation(
    row.automation.id,
    since
  )
  const graph = toAutomationGraph(
    row.automation.key,
    row.version.versionNumber,
    row.version.graphDefinition,
    runtime
  )

  const decisionDefinition = row.version.graphDefinition.nodes.find(
    (node) => node.kind === "decision"
  )
  const configuredModel = decisionDefinition
    ? configString(decisionDefinition.config, "model")
    : undefined
  const latestObservedModel = [...runtime.models]
    .reverse()
    .find((model) => model.status === "succeeded")?.model

  const verified = runtime.actions.filter(
    (action) =>
      actionVerification(
        action,
        runtime.archiveRecoveries?.find(
          (recovery) => recovery.actionExecutionId === action.id
        )
      ) === "verified"
  ).length

  return {
    id: row.automation.key,
    name: row.automation.name,
    description: row.automation.description ?? "",
    version: row.version.versionNumber,
    versionCreatedAt: row.version.createdAt.toISOString(),
    definitionHash: row.version.definitionHash,
    model: configuredModel ?? latestObservedModel ?? "—",
    verifiedRate:
      runtime.actions.length === 0
        ? null
        : Number(((verified / runtime.actions.length) * 100).toFixed(1)),
    cost24hUsd: totalCost(runtime.models),
    runs24h: runtime.runs.length,
    status: row.automation.status,
    graph,
  }
}

function runEvidence(
  runId: string,
  nodes: NodeRow[],
  models: ModelRow[],
  actions: ActionRow[],
  recoveries: ArchiveRecoveryRow[] = []
) {
  const runNodes = nodes.filter((node) => node.runId === runId)
  const nodeIds = new Set(runNodes.map((node) => node.id))
  const runModels = models.filter((model) => nodeIds.has(model.nodeExecutionId))
  const runActions = actions.filter((action) =>
    nodeIds.has(action.nodeExecutionId)
  )
  const actionIds = new Set(runActions.map((action) => action.id))
  const runRecoveries = recoveries.filter((recovery) =>
    actionIds.has(recovery.actionExecutionId)
  )
  return { runNodes, runModels, runActions, runRecoveries }
}

function runListItem(
  row: Awaited<ReturnType<ReadRepository["listRuns"]>>["rows"][number],
  evidence: ReturnType<typeof runEvidence>
): RunListItem {
  const decision = evidence.runNodes.find(
    (node) => node.selectedEdgeKey && node.status === "succeeded"
  )
  const decisionModels = decision
    ? evidence.runModels.filter(
        (model) =>
          model.nodeExecutionId === decision.id && model.status === "succeeded"
      )
    : []
  const latestModel = [...decisionModels].sort(
    (left, right) => right.sequence - left.sequence
  )[0]

  const input = object(row.run.inputSnapshot)
  const output = object(row.run.outputSnapshot)

  return {
    id: row.run.id,
    automationId: row.automation.key,
    automationName: row.automation.name,
    occurredAt: row.run.createdAt.toISOString(),
    sender:
      stringField(object(input.sender ?? null).name) ??
      stringField(object(input.sender ?? null).address) ??
      stringField(input.sender) ??
      "—",
    subject:
      stringField(input.subject) ??
      stringField(output.subject) ??
      `Run ${row.run.id.slice(0, 8)}`,
    route: decision?.selectedEdgeKey ?? stringField(output.route) ?? "—",
    model: latestModel?.model ?? "—",
    latencyMs:
      durationMs(row.run.startedAt ?? row.run.createdAt, row.run.finishedAt) ??
      0,
    verification: verification(
      evidence.runActions,
      row.run.status,
      evidence.runRecoveries
    ),
    mode: row.run.mode,
  }
}

export function runListReadModels(
  bundle: WithOptionalArchiveEvidence<
    Awaited<ReturnType<ReadRepository["listRuns"]>>
  >
) {
  return bundle.rows.map((row) =>
    runListItem(
      row,
      runEvidence(
        row.run.id,
        bundle.nodes,
        bundle.models,
        bundle.actions,
        bundle.archiveRecoveries
      )
    )
  )
}

export function runDetailReadModel(
  bundle: WithOptionalArchiveEvidence<
    NonNullable<Awaited<ReturnType<ReadRepository["findRun"]>>>
  >
): RunDetail {
  const listItem = runListItem(
    {
      run: bundle.run,
      automation: bundle.automation,
      version: bundle.version,
    },
    {
      runNodes: bundle.nodes,
      runModels: bundle.models,
      runActions: bundle.actions,
      runRecoveries: bundle.archiveRecoveries ?? [],
    }
  )

  const input = object(bundle.run.inputSnapshot)
  const decision = bundle.nodes.find(
    (node) => node.selectedEdgeKey && node.status === "succeeded"
  )
  const decisionModels = decision
    ? bundle.models.filter((model) => model.nodeExecutionId === decision.id)
    : []
  const latestModel = [...decisionModels].sort(
    (left, right) => right.sequence - left.sequence
  )[0]
  const decisionDefinition = bundle.version.graphDefinition.nodes.find(
    (node) => node.key === decision?.nodeKey
  )
  const decisionOutput = decision ? object(decision.outputSnapshot) : {}
  const firstAction = bundle.actions[0]

  const execution =
    bundle.actions.length === 0
      ? "none"
      : bundle.actions.some((action) => action.executionStatus === "failed")
        ? "failed"
        : bundle.actions.some((action) => action.executionStatus === "unknown")
          ? "unknown"
          : bundle.actions.some(
                (action) => action.executionStatus === "running"
              )
            ? "running"
            : "succeeded"

  const evidence =
    firstAction?.verificationEvidence ??
    (firstAction?.externalRef ? { externalRef: firstAction.externalRef } : null)

  return {
    ...listItem,
    mode: bundle.run.mode,
    status: bundle.run.status,
    automationVersion: bundle.version.versionNumber,
    senderEmail:
      stringField(object(input.sender ?? null).address) ??
      stringField(input.senderEmail) ??
      "—",
    body: stringField(input.text) ?? stringField(input.body) ?? "",
    prompt: decisionDefinition
      ? (configString(decisionDefinition.config, "prompt") ?? "—")
      : "—",
    reasonSummary: stringField(decisionOutput.reasonSummary) ?? "—",
    usageDetails: numberMap(latestModel?.usageDetails ?? null),
    costUsd: totalCost(bundle.models),
    action: firstAction
      ? `${firstAction.integrationKey}.${firstAction.actionKey}`
      : "none",
    execution,
    evidence: evidence ? JSON.stringify(evidence) : "—",
    input: bundle.run.inputSnapshot,
    output: bundle.run.outputSnapshot,
    error: bundle.run.error,
    definitionHash: bundle.version.definitionHash,
    nodeExecutions: bundle.nodes.map((node) => ({
      id: node.id,
      sequence: node.sequence,
      nodeKey: node.nodeKey,
      nodeKind: node.nodeKind,
      status: node.status,
      retryOfNodeExecutionId: node.retryOfNodeExecutionId,
      selectedEdgeKey: node.selectedEdgeKey,
      implementation:
        bundle.version.graphDefinition.nodes.find(
          (definition) => definition.key === node.nodeKey
        )?.config.implementation ?? null,
      input: node.inputSnapshot,
      output: node.outputSnapshot,
      error: node.error,
      startedAt: node.startedAt.toISOString(),
      finishedAt: node.finishedAt?.toISOString() ?? null,
    })),
    modelInvocations: bundle.models.map((invocation) => ({
      connectionId: invocation.connectionId ?? null,
      id: invocation.id,
      nodeExecutionId: invocation.nodeExecutionId,
      sequence: invocation.sequence,
      status: invocation.status,
      modelProvider: invocation.modelProvider,
      model: invocation.model,
      modelParameters: invocation.modelParameters,
      providerRequestId: invocation.providerRequestId,
      input: invocation.inputSnapshot,
      output: invocation.outputSnapshot,
      error: invocation.error,
      usageDetails: invocation.usageDetails,
      costDetails: invocation.costDetails,
      costUsd: invocation.costUsd === null ? null : Number(invocation.costUsd),
      durationMs: invocation.durationMs,
      startedAt: invocation.startedAt.toISOString(),
      finishedAt: invocation.finishedAt?.toISOString() ?? null,
    })),
    actionExecutions: bundle.actions.map((action) => ({
      id: action.id,
      nodeExecutionId: action.nodeExecutionId,
      sequence: action.sequence,
      connectionId: action.connectionId,
      integrationKey: action.integrationKey,
      actionKey: action.actionKey,
      executionStatus: action.executionStatus,
      verificationStatus: action.verificationStatus,
      verifiedByNodeExecutionId: action.verifiedByNodeExecutionId,
      externalRef: action.externalRef,
      request: action.requestSnapshot,
      response: action.responseSnapshot,
      verificationEvidence: action.verificationEvidence,
      error: action.error,
      startedAt: action.startedAt.toISOString(),
      finishedAt: action.finishedAt?.toISOString() ?? null,
      verifiedAt: action.verifiedAt?.toISOString() ?? null,
      archiveRecovery: (() => {
        const recovery = bundle.archiveRecoveries?.find(
          (candidate) => candidate.actionExecutionId === action.id
        )
        return recovery
          ? {
              ...recovery,
              nextAttemptAt: recovery.nextAttemptAt?.toISOString() ?? null,
              writeNotBeforeAt:
                recovery.writeNotBeforeAt?.toISOString() ?? null,
              deadlineAt: recovery.deadlineAt.toISOString(),
              createdAt: recovery.createdAt.toISOString(),
              updatedAt: recovery.updatedAt.toISOString(),
            }
          : null
      })(),
      archiveAttempts: (bundle.archiveAttempts ?? [])
        .filter((attempt) => attempt.actionExecutionId === action.id)
        .sort((left, right) => left.sequence - right.sequence)
        .map((attempt) => ({
          ...attempt,
          createdAt: attempt.createdAt.toISOString(),
        })),
    })),
    feedback: bundle.feedback.map((feedback) => ({
      id: feedback.id,
      nodeExecutionId: feedback.nodeExecutionId,
      verdict: feedback.verdict,
      expectedOutput: feedback.expectedOutput,
      note: feedback.note,
      createdAt: feedback.createdAt.toISOString(),
      updatedAt: feedback.updatedAt.toISOString(),
    })),
  }
}

export function connectionReadModel(
  connection: Awaited<ReturnType<ReadRepository["listConnections"]>>[number]
): Connection {
  const status: Connection["status"] =
    connection.status === "archived"
      ? "archived"
      : connection.status === "disabled"
        ? "disabled"
        : connection.authState !== "ready" ||
            !connection.credentialId ||
            connection.lastCheckStatus === "error"
          ? "error"
          : "connected"

  return {
    id: connection.key,
    label: connection.label,
    providerKey: connection.providerKey,
    principalType: connection.externalPrincipalType,
    principalId: connection.externalPrincipalId,
    status,
    lastCheckedAt: connection.lastCheckedAt?.toISOString() ?? null,
  }
}

export function overviewReadModel(
  bundle: WithOptionalArchiveEvidence<
    Awaited<ReturnType<ReadRepository["overviewSince"]>>
  >
): Overview {
  const verifiedOutcomes = bundle.actions.filter(
    (action) =>
      actionVerification(
        action,
        bundle.archiveRecoveries?.find(
          (recovery) => recovery.actionExecutionId === action.id
        )
      ) === "verified"
  ).length
  const attentionCount = bundle.actions.filter((action) =>
    actionNeedsAttention(
      action,
      bundle.archiveRecoveries?.find(
        (recovery) => recovery.actionExecutionId === action.id
      )
    )
  ).length

  const costByHour = new Map<string, number>()
  for (const invocation of bundle.models) {
    const bucket = invocation.startedAt.toISOString().slice(0, 13)
    costByHour.set(
      bucket,
      (costByHour.get(bucket) ?? 0) + Number(invocation.costUsd ?? 0)
    )
  }

  return {
    runs24h: bundle.runs.length,
    failed24h: bundle.runs.filter((run) => run.status === "failed").length,
    verifiedOutcomes,
    totalOutcomes: bundle.actions.length,
    cost24hUsd: totalCost(bundle.models),
    attentionCount,
    costTrend: [...costByHour.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([bucket, cost]) => ({ bucket, cost })),
  }
}

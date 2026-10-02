import type {
  AutomationGraphDefinition,
  GraphEdgeDefinition,
  GraphNodeDefinition,
  JsonObject,
  JsonValue,
} from "@workspace/domain/persistence"
import type {
  ExecuteAutomationInput,
  ExecutionPolicy,
  ExecutionResult,
  ModelRequest,
  ModelResponse,
  NodeExecutionContext,
  NodeHandlerRegistry,
  PerformActionInput,
  PerformActionResult,
  VerificationResult,
  VerifyActionInput,
} from "../contracts/execution"
import { defaultExecutionPolicy } from "../contracts/execution"
import {
  ExecutionSuspendedError,
  ExternalActionError,
  ExternalActionUnknownError,
  GraphExecutionError,
  ModelProviderError,
  RetryableNodeError,
  RuntimeError,
} from "../errors/runtime-errors"
import type { ExecutionStore } from "../ports/execution-store"
import type { ModelInvoker } from "../ports/model-invoker"

type EngineDependencies = {
  store: ExecutionStore
  modelInvoker: ModelInvoker
  handlers: NodeHandlerRegistry
  policy?: Partial<ExecutionPolicy>
  now?: () => Date
}

function errorEvidence(error: unknown): JsonObject {
  if (error instanceof RuntimeError) {
    return {
      name: error.name,
      code: error.code,
      message: error.message,
      ...(error.details ?? {}),
    }
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      code: "unexpected_error",
      message: error.message,
    }
  }

  return {
    name: "UnknownError",
    code: "unexpected_error",
    message: String(error),
  }
}

function outgoingEdges(
  graph: AutomationGraphDefinition,
  nodeKey: string
): GraphEdgeDefinition[] {
  return graph.edges.filter((edge) => edge.source === nodeKey)
}

function entryNode(graph: AutomationGraphDefinition): GraphNodeDefinition {
  if (graph.entryNodeKey) {
    const entry = graph.nodes.find((node) => node.key === graph.entryNodeKey)
    if (!entry || graph.nodes.some((node) => node.kind === "trigger")) {
      throw new GraphExecutionError(
        "Explicit entry must exist and cannot be combined with trigger nodes"
      )
    }
    return entry
  }
  const triggers = graph.nodes.filter((node) => node.kind === "trigger")
  if (triggers.length !== 1) {
    throw new GraphExecutionError(
      `Expected exactly one trigger node, found ${triggers.length}`
    )
  }
  return triggers[0]
}

function nextNode(
  graph: AutomationGraphDefinition,
  node: GraphNodeDefinition,
  selectedEdgeKey?: string
): GraphNodeDefinition | null {
  const outgoing = outgoingEdges(graph, node.key)

  let edge: GraphEdgeDefinition | undefined
  if (selectedEdgeKey) {
    edge = outgoing.find((candidate) => candidate.key === selectedEdgeKey)
    if (!edge) {
      throw new GraphExecutionError(
        `Node ${node.key} selected undefined edge ${selectedEdgeKey}`
      )
    }
  } else if (outgoing.length === 0) {
    return null
  } else if (outgoing.length === 1) {
    edge = outgoing[0]
  } else {
    throw new GraphExecutionError(
      `Node ${node.key} has ${outgoing.length} outgoing edges but selected no edge`
    )
  }

  const target = graph.nodes.find((candidate) => candidate.key === edge.target)
  if (!target) {
    throw new GraphExecutionError(
      `Edge ${edge.key} targets missing node ${edge.target}`
    )
  }
  return target
}

export class ExecutionEngine {
  private readonly policy: ExecutionPolicy
  private readonly now: () => Date

  constructor(private readonly dependencies: EngineDependencies) {
    this.policy = { ...defaultExecutionPolicy, ...dependencies.policy }
    this.now = dependencies.now ?? (() => new Date())
  }

  async execute(input: ExecuteAutomationInput): Promise<ExecutionResult> {
    const runCreatedAt = this.now()
    const triggerConnectionId = input.triggerConnectionKey
      ? input.connectionIdsByKey[input.triggerConnectionKey]
      : undefined

    if (input.triggerConnectionKey && !triggerConnectionId) {
      throw new GraphExecutionError(
        `Missing trigger connection mapping for ${input.triggerConnectionKey}`
      )
    }

    const run = await this.dependencies.store.claimRun({
      automationId: input.automationId,
      automationVersionId: input.automationVersionId,
      mode: input.mode,
      input: input.input,
      triggerSnapshot: input.triggerSnapshot,
      triggerIntegrationKey: input.triggerIntegrationKey,
      triggerConnectionId,
      idempotencyKey: input.idempotencyKey,
      createdAt: runCreatedAt,
    })

    const identity = {
      runId: run.id,
      automationVersionId: run.automationVersionId,
      admission: run.created ? ("created" as const) : ("duplicate" as const),
    }
    if (!run.created) {
      // Never start nodes or replay an external effect for a duplicate delivery,
      // including failed/unknown and crash-left queued/running runs.
      if (run.status === "succeeded")
        return { ...identity, status: run.status, output: run.output }
      if (run.status === "failed")
        return { ...identity, status: run.status, error: run.error }
      return { ...identity, status: run.status }
    }

    await this.dependencies.store.startRun(run.id, this.now())

    const outputs = new Map<string, JsonValue>()
    let currentInput = input.input
    let currentNode: GraphNodeDefinition | null
    let nodeSequence = 0

    try {
      currentNode = entryNode(input.graph)

      while (currentNode) {
        const graphNode = currentNode
        let retryOfNodeExecutionId: string | undefined
        let nodeRetryCount = 0
        let advanced = false

        while (!advanced) {
          nodeSequence += 1
          if (nodeSequence > this.policy.maxNodeExecutions) {
            throw new GraphExecutionError(
              `Execution exceeded max node count ${this.policy.maxNodeExecutions}`
            )
          }

          const nodeExecution =
            await this.dependencies.store.startNodeExecution({
              runId: run.id,
              sequence: nodeSequence,
              nodeKey: graphNode.key,
              nodeKind: graphNode.kind,
              input: currentInput,
              startedAt: this.now(),
              retryOfNodeExecutionId,
            })

          if (
            !this.policy.allowExternalActions &&
            (graphNode.kind === "action" || graphNode.kind === "verify")
          ) {
            const output: JsonObject = {
              reason: "external_action_suppressed_by_execution_policy",
            }
            await this.dependencies.store.skipNodeExecution(
              nodeExecution.id,
              output,
              this.now()
            )
            outputs.set(graphNode.key, output)
            currentInput = output
            currentNode = nextNode(input.graph, graphNode)
            advanced = true
            continue
          }

          let modelSequence = 0
          let actionSequence = 0

          const context: NodeExecutionContext = {
            runId: run.id,
            nodeExecutionId: nodeExecution.id,
            mode: input.mode,
            node: graphNode,
            graph: input.graph,
            runInput: input.input,
            input: currentInput,
            outputOf: (nodeKey) => outputs.get(nodeKey) ?? null,

            invokeModel: async (
              request: ModelRequest
            ): Promise<ModelResponse> => {
              const modelConnectionId = request.connectionKey
                ? input.connectionIdsByKey[request.connectionKey]
                : undefined
              if (request.connectionKey && !modelConnectionId)
                throw new Error("Missing model connection binding")
              let lastError: unknown

              for (
                let attempt = 0;
                attempt <= this.policy.maxModelRetries;
                attempt += 1
              ) {
                modelSequence += 1
                const invocation =
                  await this.dependencies.store.startModelInvocation({
                    nodeExecutionId: nodeExecution.id,
                    sequence: modelSequence,
                    request,
                    connectionId: modelConnectionId,
                    startedAt: this.now(),
                  })
                const monotonicStartedAt = Date.now()

                try {
                  const response =
                    await this.dependencies.modelInvoker.invoke(request)
                  await this.dependencies.store.completeModelInvocation({
                    id: invocation.id,
                    response,
                    durationMs: Math.max(0, Date.now() - monotonicStartedAt),
                    finishedAt: this.now(),
                  })
                  return response
                } catch (error) {
                  lastError = error
                  await this.dependencies.store.failModelInvocation({
                    id: invocation.id,
                    error: errorEvidence(error),
                    durationMs: Math.max(0, Date.now() - monotonicStartedAt),
                    providerRequestId:
                      error instanceof ModelProviderError
                        ? error.providerRequestId
                        : undefined,
                    finishedAt: this.now(),
                  })

                  const retryable =
                    error instanceof ModelProviderError && error.transient
                  if (!retryable || attempt === this.policy.maxModelRetries) {
                    throw error
                  }
                }
              }

              throw (
                lastError ?? new GraphExecutionError("Model invocation failed")
              )
            },

            performAction: async (
              action: PerformActionInput
            ): Promise<PerformActionResult> => {
              const connectionId =
                input.connectionIdsByKey[action.connectionKey]
              if (!connectionId) {
                throw new GraphExecutionError(
                  `Missing connection mapping for ${action.connectionKey}`
                )
              }

              actionSequence += 1
              const idempotencyKey = `${run.id}:${graphNode.key}:${actionSequence}`
              const claim = await this.dependencies.store.claimActionExecution({
                nodeExecutionId: nodeExecution.id,
                sequence: actionSequence,
                connectionId,
                integrationKey: action.integrationKey,
                actionKey: action.actionKey,
                idempotencyKey,
                request:
                  action.resource === undefined
                    ? action.request
                    : { resource: action.resource, input: action.request },
                startedAt: this.now(),
              })

              if (!claim.created) {
                if (
                  claim.executionStatus === "succeeded" &&
                  claim.response !== null
                ) {
                  return {
                    actionExecutionId: claim.id,
                    response: claim.response,
                    externalRef: claim.externalRef ?? undefined,
                  }
                }
                if (claim.executionStatus === "unknown") {
                  throw new ExternalActionUnknownError(
                    `Previous ${action.integrationKey}/${action.actionKey} outcome is unknown`
                  )
                }
                throw new ExternalActionError(
                  `Action ${action.integrationKey}/${action.actionKey} was already claimed with status ${claim.executionStatus}`
                )
              }

              try {
                const result = await action.perform()
                await this.dependencies.store.completeActionExecution({
                  id: claim.id,
                  response: result.response,
                  externalRef: result.externalRef,
                  finishedAt: this.now(),
                })
                return { actionExecutionId: claim.id, ...result }
              } catch (error) {
                await this.dependencies.store.failActionExecution({
                  id: claim.id,
                  status:
                    error instanceof ExternalActionUnknownError
                      ? "unknown"
                      : "failed",
                  error: errorEvidence(error),
                  finishedAt: this.now(),
                })
                throw error
              }
            },

            verifyAction: async (
              verification: VerifyActionInput
            ): Promise<VerificationResult> => {
              const result = await verification.verify()
              await this.dependencies.store.completeActionVerification({
                id: verification.actionExecutionId,
                status: result.status,
                evidence: result.evidence,
                verifiedByNodeExecutionId: nodeExecution.id,
                verifiedAt: this.now(),
              })
              return result
            },
          }

          try {
            const handler = this.dependencies.handlers.get(graphNode.key)
            if (!handler) {
              throw new GraphExecutionError(
                `No handler registered for node ${graphNode.key}`
              )
            }

            const result = await handler.execute(context)
            const followingNode = nextNode(
              input.graph,
              graphNode,
              result.selectedEdgeKey
            )
            const output = result.output ?? null

            await this.dependencies.store.completeNodeExecution({
              id: nodeExecution.id,
              output,
              selectedEdgeKey: result.selectedEdgeKey,
              finishedAt: this.now(),
            })

            // Omitted output is pass-through; an explicit JSON null is data.
            if (Object.hasOwn(result, "output")) {
              outputs.set(graphNode.key, output)
              currentInput = output
            }

            currentNode = followingNode
            advanced = true
          } catch (error) {
            if (error instanceof ExecutionSuspendedError) throw error
            await this.dependencies.store.failNodeExecution(
              nodeExecution.id,
              errorEvidence(error),
              this.now()
            )

            if (
              error instanceof RetryableNodeError &&
              nodeRetryCount < this.policy.maxNodeRetries
            ) {
              nodeRetryCount += 1
              retryOfNodeExecutionId = nodeExecution.id
              continue
            }

            throw error
          }
        }
      }

      const finalOutput = nodeSequence === 0 ? null : currentInput
      await this.dependencies.store.completeRun(run.id, finalOutput, this.now())
      return { ...identity, status: "succeeded", output: finalOutput }
    } catch (error) {
      if (error instanceof ExecutionSuspendedError)
        return { ...identity, status: "running" }
      const evidence = errorEvidence(error)
      await this.dependencies.store.failRun(run.id, evidence, this.now())
      return { ...identity, status: "failed", error: evidence }
    }
  }
}

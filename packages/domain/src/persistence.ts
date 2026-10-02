import { z } from "zod"

export const automationStatusValues = ["active", "paused", "archived"] as const
export const connectionStatusValues = [
  "active",
  "disabled",
  "archived",
] as const
export const connectionCheckStatusValues = ["healthy", "error"] as const
export const interactionChannelDirectionValues = [
  "inbound",
  "outbound",
  "bidirectional",
] as const
export const interactionChannelStatusValues = [
  "active",
  "disabled",
  "archived",
] as const
export const runModeValues = ["live", "replay", "test"] as const
export const runStatusValues = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const
export const nodeKindValues = [
  "trigger",
  "decision",
  "transform",
  "action",
  "verify",
  "terminal",
] as const
export const nodeExecutionStatusValues = [
  "running",
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
] as const
export const modelInvocationStatusValues = [
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const
export const actionExecutionStatusValues = [
  "running",
  "succeeded",
  "failed",
  "unknown",
] as const
export const verificationStatusValues = [
  "pending",
  "verified",
  "unverified",
  "failed",
] as const
export const feedbackVerdictValues = ["correct", "incorrect"] as const

export type AutomationStatus = (typeof automationStatusValues)[number]
export type ConnectionStatus = (typeof connectionStatusValues)[number]
export type ConnectionCheckStatus = (typeof connectionCheckStatusValues)[number]
export type InteractionChannelDirection =
  (typeof interactionChannelDirectionValues)[number]
export type InteractionChannelStatus =
  (typeof interactionChannelStatusValues)[number]
export type RunMode = (typeof runModeValues)[number]
export type RunStatus = (typeof runStatusValues)[number]
export type NodeKind = (typeof nodeKindValues)[number]
export type NodeExecutionStatus = (typeof nodeExecutionStatusValues)[number]
export type ModelInvocationStatus = (typeof modelInvocationStatusValues)[number]
export type ActionExecutionStatus = (typeof actionExecutionStatusValues)[number]
export type VerificationStatus = (typeof verificationStatusValues)[number]
export type FeedbackVerdict = (typeof feedbackVerdictValues)[number]

export const jsonValueSchema = z.json()
export type JsonValue = z.infer<typeof jsonValueSchema>

export const jsonObjectSchema = z.record(z.string(), jsonValueSchema)
export type JsonObject = z.infer<typeof jsonObjectSchema>

export const graphNodeDefinitionSchema = z.object({
  key: z.string().trim().min(1),
  kind: z.enum(nodeKindValues),
  label: z.string().trim().min(1).optional(),
  config: jsonObjectSchema.default({}),
})

export const graphEdgeDefinitionSchema = z.object({
  key: z.string().trim().min(1),
  source: z.string().trim().min(1),
  target: z.string().trim().min(1),
  label: z.string().trim().min(1).optional(),
})

export const automationGraphDefinitionSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    entryNodeKey: z.string().trim().min(1).optional(),
    nodes: z.array(graphNodeDefinitionSchema).min(1),
    edges: z.array(graphEdgeDefinitionSchema),
  })
  .superRefine((graph, ctx) => {
    const nodeKeys = new Set<string>()
    for (const [index, node] of graph.nodes.entries()) {
      if (nodeKeys.has(node.key)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate node key: ${node.key}`,
          path: ["nodes", index, "key"],
        })
      }
      nodeKeys.add(node.key)
    }

    const edgeKeys = new Set<string>()
    for (const [index, edge] of graph.edges.entries()) {
      if (edgeKeys.has(edge.key)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate edge key: ${edge.key}`,
          path: ["edges", index, "key"],
        })
      }
      edgeKeys.add(edge.key)

      if (!nodeKeys.has(edge.source)) {
        ctx.addIssue({
          code: "custom",
          message: `Unknown edge source: ${edge.source}`,
          path: ["edges", index, "source"],
        })
      }

      if (!nodeKeys.has(edge.target)) {
        ctx.addIssue({
          code: "custom",
          message: `Unknown edge target: ${edge.target}`,
          path: ["edges", index, "target"],
        })
      }
    }
  })

export type GraphNodeDefinition = z.infer<typeof graphNodeDefinitionSchema>
export type GraphEdgeDefinition = z.infer<typeof graphEdgeDefinitionSchema>
export type AutomationGraphDefinition = z.infer<
  typeof automationGraphDefinitionSchema
>

export function findGraphNode(
  graph: AutomationGraphDefinition,
  nodeKey: string
) {
  return graph.nodes.find((node) => node.key === nodeKey)
}

export function isValidSelectedEdge(
  graph: AutomationGraphDefinition,
  nodeKey: string,
  edgeKey: string
) {
  return graph.edges.some(
    (edge) => edge.key === edgeKey && edge.source === nodeKey
  )
}

export type * from "./archive-recovery"

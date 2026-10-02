import { and, desc, eq } from "drizzle-orm"
import {
  automations,
  automationVersions,
  connections,
  type Database,
} from "@workspace/db"
import {
  assertEmailTriageDefinitionSemantics,
  assertRecoverableArchiveBranch,
} from "@workspace/automations/email-triage"
import {
  automationGraphDefinitionSchema,
  type AutomationGraphDefinition,
} from "@workspace/domain/persistence"
import { sha256Json } from "../lib/stable-json"
import { ConnectionError } from "./service"
export type BindingChoice = {
  id: string
  key: string
  providerKey: string
  label: string
  status: string
  authState: string
}
export function configureEmailTriageGraph(
  graph: AutomationGraphDefinition,
  mailbox: BindingChoice,
  model: BindingChoice | null,
  modelName: string
) {
  if (mailbox.providerKey !== "google" || mailbox.status === "archived")
    throw new ConnectionError("invalid_mailbox_connection")
  if (
    model &&
    (!["openai", "anthropic"].includes(model.providerKey) ||
      model.status === "archived" ||
      !modelName.trim())
  )
    throw new ConnectionError("invalid_model_connection")
  const next = structuredClone(assertEmailTriageDefinitionSemantics(graph))
  for (const node of next.nodes) {
    if (node.config.integrationKey === "gmail")
      node.config.connectionKey = mailbox.key
    if (node.key === "classify_email") {
      node.config.modelProvider = model?.providerKey ?? "testkit"
      node.config.model = model
        ? modelName.trim()
        : "email-triage-classifier-v1"
      if (model) node.config.modelConnectionKey = model.key
      else delete node.config.modelConnectionKey
    }
  }
  assertEmailTriageDefinitionSemantics(next)
  assertRecoverableArchiveBranch(next)
  return next
}
export function createAutomationBindingService(db: Database) {
  return {
    async get() {
      const [row] = await db
        .select({ automation: automations, version: automationVersions })
        .from(automations)
        .innerJoin(
          automationVersions,
          and(
            eq(automations.activeVersionId, automationVersions.id),
            eq(automations.id, automationVersions.automationId)
          )
        )
        .where(eq(automations.key, "email-triage"))
      if (!row) throw new ConnectionError("automation_not_found")
      const choices = await db
        .select({
          id: connections.id,
          key: connections.key,
          label: connections.label,
          providerKey: connections.providerKey,
          status: connections.status,
          authState: connections.authState,
        })
        .from(connections)
      const mailbox = row.version.graphDefinition.nodes.find(
        (n) => n.key === "gmail_event"
      )?.config.connectionKey
      const model = row.version.graphDefinition.nodes.find(
        (n) => n.key === "classify_email"
      )?.config
      return {
        version: row.version.versionNumber,
        mailboxConnectionId: choices.find((c) => c.key === mailbox)?.id ?? null,
        modelConnectionId:
          choices.find((c) => c.key === model?.modelConnectionKey)?.id ?? null,
        model: typeof model?.model === "string" ? model.model : "",
        connections: choices,
      }
    },
    async save(input: {
      expectedVersion: number
      mailboxConnectionId: string
      modelConnectionId: string | null
      model: string
    }) {
      return db.transaction(async (tx) => {
        const [automation] = await tx
          .select()
          .from(automations)
          .where(eq(automations.key, "email-triage"))
          .for("update")
        if (!automation?.activeVersionId)
          throw new ConnectionError("automation_not_found")
        const [current] = await tx
          .select()
          .from(automationVersions)
          .where(
            and(
              eq(automationVersions.id, automation.activeVersionId),
              eq(automationVersions.automationId, automation.id)
            )
          )
        if (!current || current.versionNumber !== input.expectedVersion)
          throw new ConnectionError("automation_changed")
        const [mailbox] = await tx
          .select()
          .from(connections)
          .where(eq(connections.id, input.mailboxConnectionId))
          .for("share")
        const [model] = input.modelConnectionId
          ? await tx
              .select()
              .from(connections)
              .where(eq(connections.id, input.modelConnectionId))
              .for("share")
          : []
        if (!mailbox || (input.modelConnectionId && !model))
          throw new ConnectionError("connection_not_found")
        const graph = configureEmailTriageGraph(
          automationGraphDefinitionSchema.parse(current.graphDefinition),
          mailbox,
          model ?? null,
          input.model
        )
        const hash = sha256Json(graph)
        if (hash === current.definitionHash)
          return { version: current.versionNumber }
        const [latest] = await tx
          .select({ number: automationVersions.versionNumber })
          .from(automationVersions)
          .where(eq(automationVersions.automationId, automation.id))
          .orderBy(desc(automationVersions.versionNumber))
          .limit(1)
        const number = (latest?.number ?? 0) + 1
        const [created] = await tx
          .insert(automationVersions)
          .values({
            automationId: automation.id,
            versionNumber: number,
            definitionSchemaVersion: graph.schemaVersion,
            graphDefinition: graph,
            definitionHash: hash,
            sourceRevision: current.sourceRevision,
          })
          .returning({ id: automationVersions.id })
        await tx
          .update(automations)
          .set({ activeVersionId: created.id, updatedAt: new Date() })
          .where(eq(automations.id, automation.id))
        return { version: number }
      })
    },
  }
}

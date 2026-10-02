import { and, desc, eq } from "drizzle-orm"
import {
  automationVersions,
  automations,
  connections,
  createDatabase,
} from "@workspace/db"
import { emailSummaryAutomation } from "@workspace/automations"
import { emailTriageAutomation } from "@workspace/automations/email-triage"
import { sha256Json } from "./lib/stable-json"

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/control_plane"

const { db, client } = createDatabase(databaseUrl)

async function bootstrapAutomation(
  definition: typeof emailTriageAutomation | typeof emailSummaryAutomation
) {
  const definitionHash = sha256Json(definition.definition)

  return db.transaction(async (tx) => {
    let [automation] = await tx
      .select()
      .from(automations)
      .where(eq(automations.key, definition.key))
      .limit(1)

    if (!automation) {
      ;[automation] = await tx
        .insert(automations)
        .values({
          key: definition.key,
          name: definition.name,
          description: definition.description,
          status: "paused",
        })
        .returning()
    }

    const [matchingVersion] = await tx
      .select()
      .from(automationVersions)
      .where(
        and(
          eq(automationVersions.automationId, automation.id),
          eq(automationVersions.definitionHash, definitionHash)
        )
      )
      .orderBy(desc(automationVersions.versionNumber))
      .limit(1)

    let version = matchingVersion

    if (!version) {
      const [latestVersion] = await tx
        .select()
        .from(automationVersions)
        .where(eq(automationVersions.automationId, automation.id))
        .orderBy(desc(automationVersions.versionNumber))
        .limit(1)

      ;[version] = await tx
        .insert(automationVersions)
        .values({
          automationId: automation.id,
          versionNumber: (latestVersion?.versionNumber ?? 0) + 1,
          definitionSchemaVersion: definition.definition.schemaVersion,
          graphDefinition: definition.definition,
          definitionHash,
          sourceRevision: process.env.SOURCE_REVISION ?? null,
        })
        .returning()
    }

    if (!automation.activeVersionId) {
      ;[automation] = await tx
        .update(automations)
        .set({
          activeVersionId: version.id,
          updatedAt: new Date(),
        })
        .where(eq(automations.id, automation.id))
        .returning()
    }

    return {
      automation,
      version,
      definitionHash,
      activeChanged: automation.activeVersionId === version.id,
    }
  })
}

async function bootstrapConnections() {
  await db
    .insert(connections)
    .values([
      {
        key: "google-primary",
        providerKey: "google",
        label: "Primary Google",
        credentialRef: null,
        externalPrincipalType: null,
        externalPrincipalId: null,
        grants: {},
        config: {},
        status: "disabled",
        lastCheckStatus: null,
      },
      {
        key: "telegram-atlas-bot",
        providerKey: "telegram",
        label: "Atlas Telegram bot",
        credentialRef: null,
        externalPrincipalType: null,
        externalPrincipalId: null,
        grants: {},
        config: {},
        status: "disabled",
        lastCheckStatus: null,
      },
    ])
    .onConflictDoNothing({ target: connections.key })
}

try {
  const result = await bootstrapAutomation(emailTriageAutomation)
  await bootstrapAutomation(emailSummaryAutomation)
  await bootstrapConnections()

  const versionCreatedOrFound = `v${result.version.versionNumber}`
  const active =
    result.automation.activeVersionId === result.version.id
      ? "active-baseline"
      : "candidate-only"

  console.log(
    `Bootstrap complete: ${emailTriageAutomation.key} ${versionCreatedOrFound} (${active}), connections ensured`
  )
} finally {
  await client.end()
}

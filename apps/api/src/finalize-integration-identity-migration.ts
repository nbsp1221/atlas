import { and, eq, inArray } from "drizzle-orm"
import {
  automations,
  automationVersions,
  connections,
  createDatabase,
  type Database,
} from "@workspace/db"

const legacyConnectionKeys = ["gmail-primary", "telegram-personal"] as const

export async function finalizeIntegrationIdentityMigration(db: Database) {
  const [row] = await db
    .select({
      automation: automations,
      version: automationVersions,
    })
    .from(automations)
    .innerJoin(
      automationVersions,
      and(
        eq(automationVersions.id, automations.activeVersionId),
        eq(automationVersions.automationId, automations.id)
      )
    )
    .where(eq(automations.key, "email-triage"))
    .limit(1)

  if (!row) {
    throw new Error("Email Triage active version was not found")
  }

  const graph = row.version.graphDefinition
  const serialized = JSON.stringify(graph)

  if (
    graph.schemaVersion < 2 ||
    serialized.includes("gmail-primary") ||
    serialized.includes("telegram-personal") ||
    !serialized.includes('"connectionKey":"google-primary"')
  ) {
    throw new Error(
      "Refusing to archive legacy connections before canonical Email Triage activation"
    )
  }

  const archived = await db
    .update(connections)
    .set({
      status: "archived",
      updatedAt: new Date(),
    })
    .where(inArray(connections.key, [...legacyConnectionKeys]))
    .returning({ key: connections.key })

  return {
    activeVersion: row.version.versionNumber,
    archivedConnectionKeys: archived.map((connection) => connection.key),
  }
}

async function main() {
  const databaseUrl =
    process.env.DATABASE_URL ??
    "postgres://postgres:postgres@localhost:5432/control_plane"
  const { db, client } = createDatabase(databaseUrl)

  try {
    const result = await finalizeIntegrationIdentityMigration(db)
    console.log(
      `Finalized integration migration on Email Triage v${result.activeVersion}: archived ${result.archivedConnectionKeys.join(", ") || "no legacy connections"}`
    )
  } finally {
    await client.end()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main()
}

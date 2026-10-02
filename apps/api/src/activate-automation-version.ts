import { and, eq } from "drizzle-orm"
import {
  automationVersions,
  automations,
  createDatabase,
  type Database,
} from "@workspace/db"

export async function activateAutomationVersion(
  db: Database,
  automationKey: string,
  versionNumber: number
) {
  const [automation] = await db
    .select()
    .from(automations)
    .where(eq(automations.key, automationKey))
    .limit(1)

  if (!automation) {
    throw new Error(`Automation not found: ${automationKey}`)
  }

  const [version] = await db
    .select()
    .from(automationVersions)
    .where(
      and(
        eq(automationVersions.automationId, automation.id),
        eq(automationVersions.versionNumber, versionNumber)
      )
    )
    .limit(1)

  if (!version) {
    throw new Error(
      `Automation version not found: ${automationKey} v${versionNumber}`
    )
  }

  const [updated] = await db
    .update(automations)
    .set({
      activeVersionId: version.id,
      updatedAt: new Date(),
    })
    .where(eq(automations.id, automation.id))
    .returning()

  return { automation: updated, version }
}

async function main() {
  const automationKey = process.argv[2]
  const versionNumber = Number(process.argv[3])

  if (
    !automationKey ||
    !Number.isInteger(versionNumber) ||
    versionNumber <= 0
  ) {
    throw new Error(
      "Usage: pnpm --filter api activate-version <automation-key> <version-number>"
    )
  }

  const databaseUrl =
    process.env.DATABASE_URL ??
    "postgres://postgres:postgres@localhost:5432/control_plane"
  const { db, client } = createDatabase(databaseUrl)

  try {
    const result = await activateAutomationVersion(
      db,
      automationKey,
      versionNumber
    )
    console.log(
      `Activated ${result.automation.key} v${result.version.versionNumber}`
    )
  } finally {
    await client.end()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main()
}

import { createDatabase } from "@workspace/db"
import {
  initializeCredentialStorage,
  rotateCredentialBatch,
  validateCredentialStorage,
} from "./connections/key-maintenance"

// Operator-only local command. No HTTP endpoint, automatic key creation, or key output.
async function main() {
  const [command, ...flags] = process.argv.slice(2)
  if (
    !["validate", "rotate"].includes(command ?? "") ||
    (command === "validate" && flags.length !== 0) ||
    (command === "rotate" &&
      (flags.length !== 3 ||
        !["--apply", "--writers-stopped", "--backup-verified"].every((flag) =>
          flags.includes(flag)
        ))) ||
    !process.env.DATABASE_URL
  )
    throw new Error("usage")
  const { db, client } = createDatabase(process.env.DATABASE_URL)
  try {
    const { crypto, inventory } = await initializeCredentialStorage(
      db,
      process.env
    )
    if (command === "validate") {
      console.log(JSON.stringify({ status: "validated", ...inventory }))
      return
    }
    if (!crypto) throw new Error("unconfigured")
    // Bound each invocation; invoke again to resume from stored keyVersion checkpoints.
    let rotated = 0
    for (let batch = 0; batch < 10; batch++) {
      const result = await rotateCredentialBatch(db, crypto, 100)
      rotated += result.rotated
      if (result.rotated === 0) break
    }
    const after = await validateCredentialStorage(db, crypto)
    const remaining = Object.entries(after.keyVersions)
      .filter(([version]) => version !== crypto.activeVersion)
      .reduce((sum, [, count]) => sum + count, 0)
    console.log(
      JSON.stringify({
        status: remaining ? "resume_required" : "rotation_complete",
        rotated,
        remaining,
        activeVersion: crypto.activeVersion,
        inventory: after,
        backupNotice:
          "Retained backups still require their original key versions.",
      })
    )
  } finally {
    await client.end()
  }
}
main().catch(() => {
  // Never emit database driver errors, environment, payloads, keys, or stack traces.
  console.error(
    "credential_key_command_failed; validate requires no flags; rotate requires --apply --writers-stopped --backup-verified"
  )
  process.exitCode = 1
})

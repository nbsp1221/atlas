import { createDatabase } from "@workspace/db"
import { readAdminAuthConfig } from "./config"
import { provisionOwner } from "./provision-owner"

async function main() {
  if (
    process.argv.slice(2).join(" ") !== "--apply" ||
    !process.env.DATABASE_URL ||
    !readAdminAuthConfig(process.env) ||
    process.stdin.isTTY
  )
    throw new Error("owner_provisioning_input_required")
  let input = ""
  for await (const chunk of process.stdin) {
    input += chunk.toString()
    if (Buffer.byteLength(input) > 4096) throw new Error("invalid_owner_input")
  }
  const parsed: unknown = JSON.parse(input)
  if (!parsed || typeof parsed !== "object")
    throw new Error("invalid_owner_input")
  const { db, client } = createDatabase(process.env.DATABASE_URL)
  try {
    await provisionOwner(db, parsed as Parameters<typeof provisionOwner>[1])
    console.log("Owner provisioned.")
  } finally {
    await client.end()
  }
}

main().catch(() => {
  console.error("owner_provisioning_failed")
  process.exitCode = 1
})

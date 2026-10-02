import { randomUUID } from "node:crypto"
import { hashPassword } from "better-auth/crypto"
import { z } from "zod"
import { authAccount, authUser, type createDatabase } from "@workspace/db"
import { ATLAS_OWNER_ID } from "./config"

type Database = ReturnType<typeof createDatabase>["db"]

const ownerInput = z
  .object({
    email: z.string().trim().email().max(320),
    name: z.string().trim().min(1).max(100),
    password: z.string().min(12).max(128),
  })
  .strict()

export type ProvisionOwnerInput = z.input<typeof ownerInput>

// Operator-only helper. Invoking this against a real installation
// creates persistent access and requires separate explicit approval.
// Never mount it as a route or call it automatically at startup.
export async function provisionOwner(
  db: Database,
  input: ProvisionOwnerInput
): Promise<{ id: string }> {
  const parsed = ownerInput.safeParse(input)
  if (!parsed.success) {
    throw new Error("invalid_owner_input")
  }

  const email = parsed.data.email.toLowerCase()
  const password = await hashPassword(parsed.data.password)

  try {
    await db.transaction(async (tx) => {
      // Fixed primary key plus the schema constraint prevents
      // concurrent bootstrap attempts from creating multiple owners.
      await tx.insert(authUser).values({
        id: ATLAS_OWNER_ID,
        email,
        name: parsed.data.name,
        emailVerified: false,
      })

      await tx.insert(authAccount).values({
        id: randomUUID(),
        accountId: ATLAS_OWNER_ID,
        providerId: "credential",
        userId: ATLAS_OWNER_ID,
        password,
      })
    })
  } catch {
    // Do not propagate driver errors containing SQL parameters.
    // No overwrite, upsert or implicit recovery of an existing owner.
    throw new Error("owner_provisioning_failed")
  }

  return { id: ATLAS_OWNER_ID }
}

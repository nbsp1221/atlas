import { and, eq, gt, lt, sql } from "drizzle-orm"
import type { Database } from "./read-repository"
import {
  connections,
  credentialSecrets,
  oauthClients,
  oauthAttempts,
  automationVersions,
  automations,
  interactionChannels,
} from "../schema"
export type ConnectionRow = typeof connections.$inferSelect
export type SecretRow = typeof credentialSecrets.$inferSelect
export type NewSecret = typeof credentialSecrets.$inferInsert
export type ConnectionChange = Partial<
  Pick<
    ConnectionRow,
    | "status"
    | "authState"
    | "externalPrincipalType"
    | "externalPrincipalId"
    | "grants"
    | "lastCheckStatus"
    | "lastCheckedAt"
    | "lastError"
  >
> & { secret?: NewSecret; clearSecret?: boolean }
export class ConnectionConflict extends Error {
  constructor(readonly code = "connection_changed") {
    super(code)
  }
}
export function createConnectionRepository(db: Database) {
  return {
    async list() {
      return db.select().from(connections)
    },
    async usage(key: string, id: string) {
      const current = await db
        .select({
          name: automations.name,
          graph: automationVersions.graphDefinition,
        })
        .from(automations)
        .innerJoin(
          automationVersions,
          eq(automations.activeVersionId, automationVersions.id)
        )
      const channels = await db
        .select({ key: interactionChannels.key })
        .from(interactionChannels)
        .where(eq(interactionChannels.connectionId, id))
      const names = current
        .filter((row) =>
          row.graph.nodes.some(
            (node) =>
              node.config.connectionKey === key ||
              node.config.modelConnectionKey === key ||
              channels.some((c) => node.config.interactionChannelKey === c.key)
          )
        )
        .map((row) => row.name)
      return [...new Set(names)]
    },
    async create(input: {
      id: string
      providerKey: string
      label: string
      secret: NewSecret
      grants?: ConnectionRow["grants"]
      principalType?: string | null
      principalId?: string | null
      authState?: ConnectionRow["authState"]
      oauthClientRevision?: number
    }) {
      return db.transaction(async (tx) => {
        if (input.oauthClientRevision !== undefined) {
          const [client] = await tx
            .select()
            .from(oauthClients)
            .where(eq(oauthClients.providerKey, "google"))
            .for("share")
          if (!client || client.revision !== input.oauthClientRevision)
            throw new ConnectionConflict("oauth_client_changed")
        }
        await tx.insert(credentialSecrets).values(input.secret)
        const [row] = await tx
          .insert(connections)
          .values({
            id: input.id,
            key: `${input.providerKey}-${input.id}`,
            providerKey: input.providerKey,
            label: input.label,
            credentialId: input.secret.id,
            credentialRef: null,
            config: {},
            grants: input.grants ?? {},
            status: "active",
            authState: input.authState ?? "unchecked",
            externalPrincipalType: input.principalType,
            externalPrincipalId: input.principalId,
          })
          .returning()
        return row!
      })
    },
    // Row lock also serializes refresh, replacement, disable, and forgetting. Provider calls
    // inside the callback have a hard timeout. No process-local-only refresh mutex.
    async mutate<T>(
      id: string,
      revision: number | undefined,
      work: (
        row: ConnectionRow,
        secret: SecretRow | null
      ) => Promise<{ change: ConnectionChange; result: T }>,
      oauthClientRevision?: number,
      incrementRevision = true
    ) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(connections)
          .where(eq(connections.id, id))
          .for("update")
        if (!row) throw new ConnectionConflict("connection_not_found")
        if (revision !== undefined && revision !== row.revision)
          throw new ConnectionConflict()
        const [secret] = row.credentialId
          ? await tx
              .select()
              .from(credentialSecrets)
              .where(eq(credentialSecrets.id, row.credentialId))
          : []
        if (oauthClientRevision !== undefined) {
          const [client] = await tx
            .select()
            .from(oauthClients)
            .where(eq(oauthClients.providerKey, "google"))
            .for("share")
          if (!client || client.revision !== oauthClientRevision)
            throw new ConnectionConflict("oauth_client_changed")
        }
        const { change, result } = await work(row, secret ?? null)
        if (Object.keys(change).length === 0) return { connection: row, result }
        const { secret: replacement, clearSecret, ...metadata } = change
        let credentialId = row.credentialId
        if (replacement) {
          await tx.insert(credentialSecrets).values(replacement)
          credentialId = replacement.id
        }
        if (clearSecret) credentialId = null
        const [updated] = await tx
          .update(connections)
          .set({
            ...metadata,
            credentialId,
            credentialRef: null,
            revision: row.revision + (incrementRevision ? 1 : 0),
            updatedAt: new Date(),
          })
          .where(eq(connections.id, id))
          .returning()
        if (row.credentialId && row.credentialId !== credentialId)
          await tx
            .delete(credentialSecrets)
            .where(eq(credentialSecrets.id, row.credentialId))
        return { connection: updated!, result }
      })
    },
    async listOAuthClients() {
      return db
        .select({
          providerKey: oauthClients.providerKey,
          clientId: oauthClients.clientId,
          revision: oauthClients.revision,
        })
        .from(oauthClients)
    },
    async googleClient() {
      const [row] = await db
        .select({ client: oauthClients, secret: credentialSecrets })
        .from(oauthClients)
        .innerJoin(
          credentialSecrets,
          eq(oauthClients.credentialId, credentialSecrets.id)
        )
        .where(eq(oauthClients.providerKey, "google"))
      return row ?? null
    },
    async saveGoogleClient(
      clientId: string,
      secret: NewSecret,
      revision?: number
    ) {
      return db.transaction(async (tx) => {
        // Serializes the first insert too, where no row yet exists.
        await tx.execute(sql`select pg_advisory_xact_lock(711224, 1)`)
        const [old] = await tx
          .select()
          .from(oauthClients)
          .where(eq(oauthClients.providerKey, "google"))
          .for("update")
        if (old && old.revision !== revision) throw new ConnectionConflict()
        // Changing client identity would strand existing refresh tokens. Revoke/forget first.
        const active = await tx
          .select({ id: connections.id })
          .from(connections)
          .where(
            and(
              eq(connections.providerKey, "google"),
              sql`${connections.credentialId} is not null`
            )
          )
          .limit(1)
        if (old && old.clientId !== clientId && active.length)
          throw new ConnectionConflict("oauth_client_in_use")
        await tx.insert(credentialSecrets).values(secret)
        if (old) {
          await tx
            .update(oauthClients)
            .set({
              clientId,
              credentialId: secret.id,
              revision: old.revision + 1,
              updatedAt: new Date(),
            })
            .where(eq(oauthClients.providerKey, "google"))
          await tx
            .delete(credentialSecrets)
            .where(eq(credentialSecrets.id, old.credentialId))
        } else
          await tx.insert(oauthClients).values({
            providerKey: "google",
            clientId,
            credentialId: secret.id,
          })
        await tx.delete(oauthAttempts)
      })
    },
    async createAttempt(attempt: typeof oauthAttempts.$inferInsert) {
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${attempt.sessionId}, 711225))`
        )
        await tx
          .delete(oauthAttempts)
          .where(lt(oauthAttempts.expiresAt, new Date()))
        // Only one pending authorization per browser session; a newer attempt cancels old ones.
        await tx
          .delete(oauthAttempts)
          .where(eq(oauthAttempts.sessionId, attempt.sessionId))
        await tx.insert(oauthAttempts).values(attempt)
      })
    },
    async consumeAttempt(hash: string, sessionId: string) {
      const [row] = await db
        .delete(oauthAttempts)
        .where(
          and(
            eq(oauthAttempts.stateHash, hash),
            eq(oauthAttempts.sessionId, sessionId),
            gt(oauthAttempts.expiresAt, new Date())
          )
        )
        .returning()
      return row ?? null
    },
  }
}
export type ConnectionRepository = ReturnType<typeof createConnectionRepository>

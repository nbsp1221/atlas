import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core"
export type StoredEnvelope = {
  formatVersion: number
  keyVersion: string
  nonce: string
  ciphertext: string
  authTag: string
}
export const credentialSecrets = pgTable("credential_secrets", {
  id: uuid("id").primaryKey(),
  providerKey: text("provider_key").notNull(),
  authType: text("auth_type").notNull(),
  envelope: jsonb("envelope").$type<StoredEnvelope>().notNull(),
  revision: integer("revision").default(1).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
})
export const oauthClients = pgTable("oauth_clients", {
  providerKey: text("provider_key").primaryKey(),
  clientId: text("client_id").notNull(),
  credentialId: uuid("credential_id")
    .notNull()
    .unique()
    .references(() => credentialSecrets.id, { onDelete: "restrict" }),
  revision: integer("revision").default(1).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
})
export const oauthAttempts = pgTable("oauth_attempts", {
  stateHash: text("state_hash").primaryKey(),
  sessionId: text("session_id").notNull(),
  connectionId: uuid("connection_id"),
  connectionRevision: integer("connection_revision"),
  label: text("label").notNull(),
  clientRevision: integer("client_revision").notNull(),
  verifier: jsonb("verifier").$type<StoredEnvelope>().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
})

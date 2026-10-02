import { sql } from "drizzle-orm"
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"

const date = (name: string) =>
  timestamp(name, { withTimezone: true })

export const authUser = pgTable(
  "auth_user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    createdAt: date("created_at").notNull().defaultNow(),
    updatedAt: date("updated_at").notNull().defaultNow(),
  },
  (table) => [
    // Intentional single-owner installation boundary.
    // Any future multi-user design requires an explicit migration.
    check(
      "auth_user_single_owner_ck",
      sql`${table.id} = 'atlas-owner'`
    ),
  ]
)

export const authSession = pgTable(
  "auth_session",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    expiresAt: date("expires_at").notNull(),
    createdAt: date("created_at").notNull().defaultNow(),
    updatedAt: date("updated_at").notNull().defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("auth_session_user_idx").on(table.userId),
    index("auth_session_expiry_idx").on(table.expiresAt),
  ]
)

export const authAccount = pgTable(
  "auth_account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),

    // Better Auth adapter fields. Atlas owner login enables only
    // credential authentication; Google connections use another store.
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: date("access_token_expires_at"),
    refreshTokenExpiresAt: date("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),

    createdAt: date("created_at").notNull().defaultNow(),
    updatedAt: date("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("auth_account_provider_account_uq").on(
      table.providerId,
      table.accountId
    ),
    uniqueIndex("auth_account_user_provider_uq").on(
      table.userId,
      table.providerId
    ),
    check(
      "auth_account_credential_only_ck",
      sql`
        ${table.providerId} = 'credential'
        and ${table.accountId} = ${table.userId}
        and ${table.password} is not null
        and ${table.accessToken} is null
        and ${table.refreshToken} is null
        and ${table.idToken} is null
        and ${table.accessTokenExpiresAt} is null
        and ${table.refreshTokenExpiresAt} is null
        and ${table.scope} is null
      `
    ),
  ]
)

export const authVerification = pgTable(
  "auth_verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: date("expires_at").notNull(),
    createdAt: date("created_at").notNull().defaultNow(),
    updatedAt: date("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("auth_verification_identifier_idx").on(table.identifier),
  ]
)

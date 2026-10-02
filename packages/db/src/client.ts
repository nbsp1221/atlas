import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"

export function createDatabase(databaseUrl: string) {
  const client = postgres(databaseUrl)
  // Dedicated single-connection client for session advisory ownership. Keep
  // the connection string in this boundary rather than copying driver internals.
  const createSessionClient = () => postgres(databaseUrl, { max: 1 })
  const db = Object.assign(drizzle(client), { createSessionClient })

  return { db, client }
}

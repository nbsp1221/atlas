import { serve } from "@hono/node-server"
import { createDatabase } from "@workspace/db"
import { startArchiveRecoveryWorker } from "./composition/archive-recovery"
import { createApplication } from "./app"
import { listenerOptions, mountWebAssets } from "./transport"

async function start() {
  if (!process.env.DATABASE_URL)
    throw new Error("database_configuration_required")
  const { db, client } = createDatabase(process.env.DATABASE_URL)
  try {
    const { app } = await createApplication(db)
    mountWebAssets(app, process.env)
    const options = listenerOptions(process.env)
    const server = serve({ ...options, fetch: app.fetch })
    const stopArchiveRecovery = startArchiveRecoveryWorker(db)
    const shutdown = async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await stopArchiveRecovery()
      await client.end()
    }
    process.once("SIGINT", () => {
      void shutdown()
    })
    process.once("SIGTERM", () => {
      void shutdown()
    })
    console.log("Atlas API listening on port " + options.port)
  } catch {
    await client.end()
    throw new Error("atlas_startup_failed")
  }
}

start().catch(() => {
  console.error("atlas_startup_failed")
  process.exitCode = 1
})

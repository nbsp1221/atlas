import { codeAutomationRoutes } from "./http/routes/code-automations"
import {
  createReadRepository,
  createConnectionRepository,
  type Database,
} from "@workspace/db"
import { Hono } from "hono"
import { emailTriageTestRunRoutes } from "./http/routes/email-triage-test-runs"
import {
  automationReadModel,
  connectionReadModel,
  overviewReadModel,
  runDetailReadModel,
  runListReadModels,
} from "./read-models"

import { createAdminAuth } from "./auth"
import { readAdminAuthConfig } from "./auth/config"
import { initializeCredentialStorage } from "./connections/key-maintenance"
import {
  createConnectionService,
  type ProviderOperations,
} from "./connections/service"
import { createAutomationBindingService } from "./connections/automation-bindings"
import { connectionRoutes } from "./http/routes/connections"
import { automationConnectionRoutes } from "./http/routes/automation-connections"

export async function createApplication(
  db: Database,
  env: NodeJS.ProcessEnv = process.env,
  provider?: ProviderOperations
) {
  const { crypto } = await initializeCredentialStorage(db, env)
  const security = createAdminAuth(db, env)
  const config = readAdminAuthConfig(env)
  const connections = createConnectionService(
    createConnectionRepository(db),
    crypto,
    config?.origin ?? null,
    provider
  )
  const repository = createReadRepository(db)
  const app = new Hono()
  app.all("/api/auth/*", (context) => security.handler(context.req.raw))
  app.use("/api", security.requireOwner)
  app.use("/api/*", security.requireOwner)
  app.route("/", connectionRoutes(connections, security))
  app.route(
    "/",
    automationConnectionRoutes(createAutomationBindingService(db), security)
  )
  app.route("/", codeAutomationRoutes(db))
  app.route("/", emailTriageTestRunRoutes(db))

  const since24h = () => new Date(Date.now() - 24 * 60 * 60 * 1000)

  app.get("/health", (context) => {
    return context.json({ status: "ok" })
  })

  app.get("/api/overview", async (context) => {
    const bundle = await repository.overviewSince(since24h())
    return context.json(overviewReadModel(bundle))
  })

  app.get("/api/automations", async (context) => {
    const rows = await repository.listAutomations()
    const models = await Promise.all(
      rows.map((row) => automationReadModel(repository, row, since24h()))
    )

    return context.json(models.filter((model) => model !== null))
  })

  app.get("/api/automations/:key", async (context) => {
    const row = await repository.findAutomationByKey(context.req.param("key"))
    const model = await automationReadModel(repository, row, since24h())

    if (!model) {
      return context.json({ error: "automation_not_found" }, 404)
    }

    return context.json(model)
  })

  app.get("/api/runs", async (context) => {
    const bundle = await repository.listRuns(100)
    return context.json(runListReadModels(bundle))
  })

  app.get("/api/runs/:id", async (context) => {
    const bundle = await repository.findRun(context.req.param("id"))

    if (!bundle) {
      return context.json({ error: "run_not_found" }, 404)
    }

    return Response.json(runDetailReadModel(bundle))
  })

  app.get("/api/connections", async (context) => {
    const rows = await repository.listConnections()
    return context.json(rows.map(connectionReadModel))
  })

  app.onError((_error, context) => {
    return context.json({ error: "internal_error" }, 500)
  })

  return { app, security }
}

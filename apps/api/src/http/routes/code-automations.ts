import { Hono } from "hono"
import { z } from "zod"
import { RuntimeError } from "@workspace/automation-runtime"
import type { Database } from "@workspace/db"
import {
  CodeAutomationError,
  executeCodeAutomation,
  inspectCodeAutomation,
} from "../../composition/registered-code-automations"
const requestSchema = z.strictObject({
  version: z.number().int().positive(),
  input: z.json(),
})
export function codeAutomationRoutes(db: Database) {
  const routes = new Hono()
  routes.get(
    "/api/code-automations/:key/versions/:version",
    async (context) => {
      const version = Number(context.req.param("version"))
      if (!Number.isSafeInteger(version) || version < 1)
        return context.json({ error: "invalid_version" }, 400)
      try {
        const selected = await inspectCodeAutomation(
          db,
          context.req.param("key"),
          version
        )
        return context.json({
          key: context.req.param("key"),
          version,
          definitionHash: selected.bundle.version!.definitionHash,
          graph: selected.graph,
          fixture: selected.registered.fixture,
          execution: "trusted_in_process",
          sourceScope:
            "self-contained callable, schemas and adapter; not a full deployment identity",
        })
      } catch (error) {
        if (error instanceof CodeAutomationError)
          return context.json(
            { error: error.code, message: error.message },
            error.status
          )
        throw error
      }
    }
  )
  routes.post("/api/code-automations/:key/test-runs", async (context) => {
    let body: unknown
    try {
      body = await context.req.json()
    } catch {
      return context.json({ error: "invalid_json" }, 400)
    }
    const parsed = requestSchema.safeParse(body)
    if (!parsed.success)
      return context.json(
        { error: "invalid_request", issues: parsed.error.issues },
        400
      )
    try {
      const result = await executeCodeAutomation(
        db,
        context.req.param("key"),
        parsed.data.version,
        parsed.data.input
      )
      return context.json({ ...result, version: parsed.data.version }, 201)
    } catch (error) {
      if (error instanceof CodeAutomationError)
        return context.json(
          { error: error.code, message: error.message },
          error.status
        )
      if (error instanceof RuntimeError)
        return context.json({ error: error.code, ...error.details }, 400)
      throw error
    }
  })
  return routes
}

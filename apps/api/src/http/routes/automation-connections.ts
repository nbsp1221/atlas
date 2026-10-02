import { Hono, type MiddlewareHandler } from "hono"
import { bodyLimit } from "hono/body-limit"
import { z } from "zod"
import type { createAutomationBindingService } from "../../connections/automation-bindings"
import { ConnectionError } from "../../connections/service"
const body = z
  .object({
    expectedVersion: z.number().int().positive(),
    mailboxConnectionId: z.uuid(),
    modelConnectionId: z.uuid().nullable(),
    model: z.string().trim().max(200),
  })
  .strict()
export function automationConnectionRoutes(
  service: ReturnType<typeof createAutomationBindingService>,
  security: {
    requireOwner: MiddlewareHandler
    requireFreshOwner: MiddlewareHandler
  }
) {
  const app = new Hono(),
    path = "/api/settings/automations/email-triage/connections"
  app.use(path, security.requireOwner)
  app.use(
    path,
    bodyLimit({
      maxSize: 4096,
      onError: (c) => c.json({ error: "request_too_large" }, 413),
    })
  )
  app.get(path, async (c) => {
    c.header("Cache-Control", "no-store")
    return c.json(await service.get())
  })
  app.post(path, security.requireFreshOwner, async (c) =>
    c.json(await service.save(body.parse(await c.req.json())))
  )
  app.onError((error, c) => {
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return c.json({ error: "invalid_request" }, 400)
    if (error instanceof ConnectionError)
      return c.json({ error: error.code }, 409)
    return c.json({ error: "configuration_failed" }, 500)
  })
  return app
}

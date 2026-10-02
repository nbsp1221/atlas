import { Hono, type Context, type MiddlewareHandler } from "hono"
import { bodyLimit } from "hono/body-limit"
import { z } from "zod"
import { ConnectionConflict } from "@workspace/db"
import { ProviderError, GoogleGrantError } from "@workspace/integrations"
import {
  ConnectionError,
  type ConnectionService,
} from "../../connections/service"
const revision = z.number().int().positive()
const secret = z
  .string()
  .min(8)
  .max(16384)
  .refine((value) => !/[\r\n\0]/.test(value))
const label = z.string().trim().min(1).max(100)
const apiKey = z
  .object({
    providerKey: z.enum(["openai", "anthropic", "telegram"]),
    label,
    secret,
  })
  .strict()
const replace = z.object({ revision, secret }).strict()
const change = z.object({ revision }).strict()
const googleClient = z
  .object({
    clientId: z
      .string()
      .regex(/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/)
      .max(300),
    clientSecret: secret,
    revision: revision.optional(),
  })
  .strict()
const authorize = z
  .object({
    label: label.optional(),
    connectionId: z.uuid().optional(),
    revision: revision.optional(),
  })
  .strict()
  .refine((input) => !!input.connectionId === !!input.revision)
const uuid = z.uuid()
export function connectionRoutes(
  service: ConnectionService,
  security: {
    requireOwner: MiddlewareHandler
    requireFreshOwner: MiddlewareHandler
    sessionId: (context: Context) => string
  }
) {
  const app = new Hono()
  app.use("/api/settings/*", security.requireOwner)
  app.use(
    "/api/settings/*",
    bodyLimit({
      maxSize: 32768,
      onError: (context) => context.json({ error: "request_too_large" }, 413),
    })
  )
  app.use("/api/settings/*", async (context, next) => {
    context.header("Cache-Control", "no-store")
    context.header("Referrer-Policy", "no-referrer")
    if (context.req.method !== "GET")
      return security.requireFreshOwner(context, next)
    await next()
  })
  app.get("/api/settings/connections", async (c) =>
    c.json(await service.list())
  )
  app.post("/api/settings/connections/api-key", async (c) =>
    c.json(await service.addApiKey(apiKey.parse(await c.req.json())), 201)
  )
  app.put("/api/settings/oauth-clients/google", async (c) =>
    c.json(
      await service.saveGoogleClient(googleClient.parse(await c.req.json()))
    )
  )
  app.post("/api/settings/connections/google/authorize", async (c) =>
    c.json(
      await service.authorize({
        ...authorize.parse(await c.req.json()),
        sessionId: security.sessionId(c),
      })
    )
  )
  app.get("/api/settings/connections/google/callback", async (c) => {
    try {
      const query = z
        .object({
          state: z.string().min(20).max(256),
          code: z.string().max(8192).optional(),
          error: z.string().max(256).optional(),
        })
        .parse(c.req.query())
      await service.callback({
        sessionId: security.sessionId(c),
        state: query.state,
        code: query.code,
        denied: !!query.error,
      })
      return c.redirect("/connections?oauth=complete", 303)
    } catch {
      return c.redirect("/connections?oauth=failed", 303)
    }
  })
  app.post("/api/settings/connections/:id/replace", async (c) => {
    const input = replace.parse(await c.req.json())
    return c.json(
      await service.replace(
        uuid.parse(c.req.param("id")),
        input.revision,
        input.secret
      )
    )
  })
  app.post("/api/settings/connections/:id/test", async (c) => {
    const input = change.parse(await c.req.json())
    return c.json(
      await service.test(uuid.parse(c.req.param("id")), input.revision)
    )
  })
  for (const action of [
    "disconnect",
    "forget",
    "archive",
    "revoke",
    "resume",
  ] as const)
    app.post(`/api/settings/connections/:id/${action}`, async (c) => {
      const input = change.parse(await c.req.json())
      return c.json(
        await service.lifecycle(
          uuid.parse(c.req.param("id")),
          input.revision,
          action
        )
      )
    })
  app.onError((error, c) => {
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return c.json({ error: "invalid_request" }, 400)
    if (error instanceof ConnectionConflict)
      return c.json(
        { error: error.code },
        error.code === "connection_not_found" ? 404 : 409
      )
    if (error instanceof ConnectionError)
      return c.json({ error: error.code }, 409)
    if (error instanceof ProviderError)
      return c.json({ error: error.code }, 502)
    if (error instanceof GoogleGrantError)
      return c.json({ error: "reauth_required" }, 409)
    return c.json({ error: "connection_operation_failed" }, 500)
  })
  return app
}

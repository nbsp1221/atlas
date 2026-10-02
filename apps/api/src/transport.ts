import { readFileSync, statSync } from "node:fs"
import { createServer } from "node:https"
import path from "node:path"
import { serveStatic } from "@hono/node-server/serve-static"
import type { Hono } from "hono"
import { readAdminAuthConfig } from "./auth/config"

export function listenerOptions(env: NodeJS.ProcessEnv) {
  const port = Number(env.API_PORT ?? 3001)
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("invalid_listener_port")
  const hostname = env.ATLAS_LISTEN_HOST ?? "127.0.0.1"
  const keyPath = env.ATLAS_TLS_KEY_FILE
  const certPath = env.ATLAS_TLS_CERT_FILE
  const config = readAdminAuthConfig(env)
  // Configured auth must never silently fall back to an HTTP listener.
  if (keyPath || certPath || config) {
    if (!keyPath || !certPath) throw new Error("native_tls_required")
    return {
      port,
      hostname,
      createServer,
      serverOptions: {
        key: readFileSync(keyPath),
        cert: readFileSync(certPath),
        minVersion: "TLSv1.2" as const,
      },
    }
  }
  return { port, hostname }
}

export function mountWebAssets(app: Hono, env: NodeJS.ProcessEnv) {
  if (!env.ATLAS_WEB_DIST) return
  const absolute = path.resolve(env.ATLAS_WEB_DIST)
  if (!statSync(path.join(absolute, "index.html")).isFile())
    throw new Error("web_assets_unavailable")
  const root = path.relative(process.cwd(), absolute)
  // Unknown APIs must not fall through to the public SPA shell.
  app.all("/api", (c) => c.json({ error: "not_found" }, 404))
  app.all("/api/*", (c) => c.json({ error: "not_found" }, 404))
  app.use("*", async (c, next) => {
    c.header("Referrer-Policy", "no-referrer")
    c.header("X-Content-Type-Options", "nosniff")
    if (!["GET", "HEAD"].includes(c.req.method))
      return c.json({ error: "method_not_allowed" }, 405)
    await next()
  })
  app.use("*", serveStatic({ root }))
  app.get("*", serveStatic({ root, path: "index.html" }))
}

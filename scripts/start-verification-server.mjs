import { spawn } from "node:child_process"
import {
  assertPortAvailable,
  verificationServerConfig,
} from "./verification-isolation.mjs"

// Validate before starting either process. Explicit child env prevents API
// fallback to the canonical database and binds Vite's proxy to this API.
const config = verificationServerConfig(process.env)
const target = process.argv[2]
if (!["api", "web", "secure"].includes(target))
  throw new Error("Expected api, web or secure")
await assertPortAvailable(target === "api" ? config.apiPort : config.webPort)
const args =
  target === "api" || target === "secure"
    ? ["--dir", "../api", "start"]
    : [
        "exec",
        "vite",
        "--host",
        "127.0.0.1",
        "--port",
        String(config.webPort),
        "--strictPort",
      ]
const child = spawn("pnpm", args, {
  env: {
    ...process.env,
    ...config.env,
    ...(target === "secure"
      ? { API_PORT: String(config.webPort), ATLAS_LISTEN_HOST: "localhost" }
      : {}),
  },
  stdio: "inherit",
})
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal))
}
child.once("error", (error) => {
  console.error(error.message)
  process.exitCode = 1
})
child.once("exit", (code) => {
  process.exitCode = code ?? 1
})

import { spawn, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import net from "node:net"

// Own both the database server and every disposable database. Never use the
// host's default PostgreSQL listener or change the installation's compose file.
const port = await new Promise((resolve, reject) => {
  const probe = net.createServer()
  probe.on("error", reject)
  probe.listen(0, "127.0.0.1", () => {
    const selected = probe.address().port
    probe.close(() => resolve(selected))
  })
})
const name = "atlas-verification-" + randomBytes(8).toString("hex")
const started = spawnSync(
  "docker",
  [
    "run",
    "--rm",
    "-d",
    "--name",
    name,
    "-e",
    "POSTGRES_PASSWORD=postgres",
    "-p",
    `127.0.0.1:${port}:5432`,
    "postgres:17-alpine",
  ],
  { encoding: "utf8" }
)
if (started.error || started.status !== 0)
  throw new Error("Local verification PostgreSQL could not start")
const containerId = started.stdout.trim()
try {
  let ready = false
  for (let attempt = 0; attempt < 30; attempt++) {
    if (
      spawnSync(
        "docker",
        ["exec", containerId, "pg_isready", "-U", "postgres"],
        { stdio: "ignore" }
      ).status === 0
    ) {
      ready = true
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  if (!ready) throw new Error("Local verification PostgreSQL readiness failed")
  const env = {
    ...process.env,
    ATLAS_VERIFY_DATABASE_BASE_URL: `postgres://postgres:postgres@127.0.0.1:${port}`,
    ATLAS_VERIFY_POSTGRES_CONTAINER: name,
    ...(existsSync("/usr/bin/google-chrome") &&
    !process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: "/usr/bin/google-chrome" }
      : {}),
  }
  const child = spawn("pnpm", ["verify"], {
    env,
    stdio: "inherit",
    detached: true,
  })
  const stop = () => {
    if (child.pid) process.kill(-child.pid, "SIGTERM")
  }
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code) => resolve(code ?? 1))
  })
  process.removeListener("SIGINT", stop)
  process.removeListener("SIGTERM", stop)
  process.exitCode = code
} finally {
  // Use the exact ID returned by our successful run, never a preexisting name.
  const stopped = spawnSync("docker", ["stop", containerId], {
    stdio: "ignore",
  })
  if (stopped.status !== 0) {
    console.error("Owned verification container cleanup failed.")
    process.exitCode = 1
  }
}

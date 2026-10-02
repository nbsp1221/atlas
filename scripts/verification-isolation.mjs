import { randomBytes } from "node:crypto"
import net from "node:net"
import { fileURLToPath } from "node:url"

export function verificationEvidenceDirectory(
  area,
  runId = process.env.VERIFICATION_RUN_ID
) {
  verificationDatabaseName("e2e", runId)
  if (!/^[a-z][a-z0-9-]*$/.test(area))
    throw new Error("Invalid verification evidence area")
  return fileURLToPath(
    new URL(
      `../audit/admin-auth/verification/${runId}/${area}`,
      import.meta.url
    )
  )
}

function verificationDatabaseBase() {
  const value =
    process.env.ATLAS_VERIFY_DATABASE_BASE_URL ??
    "postgres://postgres:postgres@localhost:5432"
  const url = new URL(value)
  if (
    url.protocol !== "postgres:" ||
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    url.username !== "postgres" ||
    url.password !== "postgres" ||
    !url.port ||
    url.pathname ||
    url.search ||
    url.hash
  )
    throw new Error("Invalid isolated verification database base")
  if (
    process.env.ATLAS_VERIFY_DATABASE_BASE_URL &&
    !process.env.ATLAS_VERIFY_POSTGRES_CONTAINER
  )
    throw new Error("An explicit verification container is required")
  return value
}

// Direct-workspace checks can use a separately owned PostgreSQL container.
// Do not retarget the application's DATABASE_URL or reuse a host production DB.
export function verificationPostgresArgs(args) {
  const container = process.env.ATLAS_VERIFY_POSTGRES_CONTAINER
  if (!container) return args
  if (!/^atlas-[a-z0-9-]+$/.test(container))
    throw new Error("Invalid verification container")
  verificationDatabaseBase()
  if (args[0] === "compose" && args[1] === "up")
    return ["exec", container, "pg_isready", "-U", "postgres"]
  if (args.slice(0, 4).join(" ") === "compose exec -T postgres")
    return ["exec", "-i", container, ...args.slice(4)]
  throw new Error("Unsupported verification PostgreSQL command")
}

export function createVerificationRunId() {
  return randomBytes(12).toString("hex")
}

export function verificationDatabaseName(purpose, runId) {
  if (
    !["schema", "runtime", "e2e", "upgrade"].includes(purpose) ||
    typeof runId !== "string" ||
    runId.length !== 24 ||
    !/^[a-f0-9]{24}$/.test(runId)
  ) {
    throw new Error("Invalid verification database purpose or run ID")
  }
  return `control_plane_verify_${purpose}_${runId}`
}

export function verificationDatabaseUrl(purpose, runId) {
  return `${verificationDatabaseBase()}/${verificationDatabaseName(purpose, runId)}`
}

// CREATE must succeed before ownership is recorded. Never reset or adopt an
// existing database, even if its name resembles one of our disposable databases.
export function ownedVerificationDatabases(
  admin,
  runId = createVerificationRunId()
) {
  const owned = new Set()
  return {
    runId,
    create(purpose) {
      const name = verificationDatabaseName(purpose, runId)
      admin(`CREATE DATABASE ${name};`)
      owned.add(name)
      return verificationDatabaseUrl(purpose, runId)
    },
    cleanup() {
      const errors = []
      for (const name of owned) {
        try {
          // No FORCE: never terminate another process's connections.
          admin(`DROP DATABASE ${name};`)
          owned.delete(name)
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length)
        throw new AggregateError(errors, "Verification database cleanup failed")
    },
  }
}

function port(value, fallback) {
  const text = value ?? String(fallback)
  const result = Number(text)
  if (
    !/^\d+$/.test(text) ||
    !Number.isInteger(result) ||
    result < 1024 ||
    result > 65535
  ) {
    throw new Error("Invalid verification port")
  }
  return result
}

export function verificationServerConfig(env) {
  const runId = env.VERIFICATION_RUN_ID
  const expectedUrl = verificationDatabaseUrl("e2e", runId)
  if (env.DATABASE_URL !== expectedUrl) {
    throw new Error(
      "Refusing browser tests: DATABASE_URL must match this verification run's isolated e2e database"
    )
  }
  const apiPort = port(env.VERIFY_API_PORT, 43001)
  const webPort = port(env.VERIFY_WEB_PORT, 44174)
  const secure = !!env.ATLAS_TLS_CERT_FILE
  if (
    apiPort === webPort ||
    [apiPort, webPort].some((value) => [3001, 4174].includes(value))
  ) {
    throw new Error(
      "Verification requires distinct, non-canonical API and web ports"
    )
  }
  if (env.API_PORT !== undefined && env.API_PORT !== String(apiPort)) {
    throw new Error("API_PORT does not match VERIFY_API_PORT")
  }
  return {
    apiPort,
    webPort,
    apiUrl: `${secure ? "https://localhost" : "http://127.0.0.1"}:${apiPort}`,
    webUrl: `${secure ? "https://localhost" : "http://127.0.0.1"}:${webPort}`,
    env: {
      ...Object.fromEntries(
        [
          "ATLAS_VERIFY_DATABASE_BASE_URL",
          "ATLAS_VERIFY_POSTGRES_CONTAINER",
          "ATLAS_AUTH_SECRET",
          "ATLAS_PUBLIC_URL",
          "ATLAS_TLS_KEY_FILE",
          "ATLAS_TLS_CERT_FILE",
          "ATLAS_WEB_DIST",
          "ATLAS_CREDENTIAL_KEYS",
          "ATLAS_CREDENTIAL_ACTIVE_KEY",
          "ATLAS_TEST_OWNER_PASSWORD",
          "ATLAS_TEST_STORAGE_STATE",
          "ATLAS_FAKE_MAILBOX_DIR",
        ]
          .filter((key) => env[key] !== undefined)
          .map((key) => [key, env[key]])
      ),
      DATABASE_URL: expectedUrl,
      VERIFICATION_RUN_ID: runId,
      VERIFY_API_PORT: String(apiPort),
      VERIFY_WEB_PORT: String(webPort),
      API_PORT: String(apiPort),
    },
  }
}

export function apiProxyTarget(env) {
  if (env.VERIFICATION_RUN_ID !== undefined)
    return verificationServerConfig(env).apiUrl
  return `http://127.0.0.1:${port(env.API_PORT, 3001)}`
}

export function verificationWebServers(env) {
  const config = verificationServerConfig(env)
  if (env.ATLAS_TLS_CERT_FILE) {
    if (
      !env.ATLAS_TLS_KEY_FILE ||
      env.ATLAS_PUBLIC_URL !== config.webUrl ||
      !env.ATLAS_WEB_DIST
    )
      throw new Error("Incomplete native HTTPS verification configuration")
    return [
      {
        command: "node ../../scripts/start-verification-server.mjs secure",
        url: config.webUrl + "/health",
        env: config.env,
        reuseExistingServer: false,
        ignoreHTTPSErrors: true,
        timeout: 30_000,
      },
    ]
  }
  return [
    {
      command: "node ../../scripts/start-verification-server.mjs api",
      url: `${config.apiUrl}/health`,
      env: config.env,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "node ../../scripts/start-verification-server.mjs web",
      url: config.webUrl,
      env: config.env,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ]
}

export async function assertPortAvailable(portNumber) {
  await new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once("error", () =>
      reject(
        new Error(
          `Verification port ${portNumber} is occupied; refusing to reuse a server`
        )
      )
    )
    // Check the same wildcard bind used by the API, including IPv4 listeners.
    probe.listen({ port: portNumber, exclusive: true }, () =>
      probe.close(resolve)
    )
  })
}

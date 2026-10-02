import { verificationPostgresArgs } from "./verification-isolation.mjs"
import { spawnSync } from "node:child_process"
import { ownedVerificationDatabases } from "./verification-isolation.mjs"

function run(command, args, env = {}) {
  if (command === "docker") args = verificationPostgresArgs(args)
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: "inherit",
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (exit ${result.status}, signal ${result.signal})`
    )
  }
}

// This runner never accepts a caller-supplied database, resets an existing one,
// or force-drops somebody else's connections. CREATE must establish ownership.
const databases = ownedVerificationDatabases((sql) => {
  run("docker", [
    "compose",
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    sql,
  ])
})

try {
  // API source tsconfig deliberately excludes tests; check this fixture explicitly.
  run("pnpm", [
    "--filter",
    "api",
    "exec",
    "tsc",
    "--ignoreConfig",
    "--noEmit",
    "--target",
    "es2022",
    "--module",
    "esnext",
    "--moduleResolution",
    "bundler",
    "--strict",
    "--types",
    "node",
    "--skipLibCheck",
    "--esModuleInterop",
    "test/message-admission-verification.ts",
    "test/message-admission-http-worker.ts",
  ])
  run("docker", ["compose", "up", "-d", "--wait", "--no-recreate", "postgres"])
  const env = {
    DATABASE_URL: databases.create("e2e"),
    VERIFICATION_RUN_ID: databases.runId,
  }
  run("pnpm", ["--filter", "@workspace/db", "db:migrate"], env)
  run("pnpm", ["--filter", "api", "bootstrap"], env)
  run(
    "pnpm",
    [
      "--filter",
      "api",
      "exec",
      "tsx",
      "test/message-admission-verification.ts",
    ],
    env
  )
} finally {
  databases.cleanup()
}

console.log("Message admission HTTP/PostgreSQL verification: PASS")

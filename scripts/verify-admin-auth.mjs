import { spawnSync } from "node:child_process"
import {
  ownedVerificationDatabases,
  verificationPostgresArgs,
} from "./verification-isolation.mjs"
function run(command, args, env = {}) {
  const result = spawnSync(
    command,
    command === "docker" ? verificationPostgresArgs(args) : args,
    { env: { ...process.env, ...env }, stdio: "inherit" }
  )
  if (result.error || result.status !== 0)
    throw new Error("Isolated administrator-auth verification failed")
}
const databases = ownedVerificationDatabases((sql) =>
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
)
try {
  const env = {
    DATABASE_URL: databases.create("runtime"),
    RESTORE_DATABASE_URL: databases.create("upgrade"),
    VERIFICATION_RUN_ID: databases.runId,
  }
  run("pnpm", ["--filter", "@workspace/db", "db:migrate"], env)
  run("pnpm", ["--filter", "api", "bootstrap"], env)
  run(
    "pnpm",
    ["--filter", "api", "exec", "tsx", "test/admin-auth-verification.ts"],
    env
  )
  const raceEnv = {
    DATABASE_URL: databases.create("e2e"),
    VERIFICATION_RUN_ID: databases.runId,
  }
  run("pnpm", ["--filter", "@workspace/db", "db:migrate"], raceEnv)
  run(
    "pnpm",
    ["--filter", "api", "exec", "tsx", "test/admin-auth-races-verification.ts"],
    raceEnv
  )
} finally {
  databases.cleanup()
}
console.log("Isolated administrator-auth verification: PASS")

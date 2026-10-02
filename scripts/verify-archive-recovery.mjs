import { verificationPostgresArgs } from "./verification-isolation.mjs"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ownedVerificationDatabases } from "./verification-isolation.mjs"
function run(command, args, env = {}) {
  if (command === "docker") args = verificationPostgresArgs(args)
  const r = spawnSync(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: "inherit",
  })
  if (r.error) throw r.error
  if (r.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed (${r.status})`)
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
const fixtureRoot = mkdtempSync(join(tmpdir(), "atlas-archive-verify-"))
try {
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
    "test/archive-recovery-verification.ts",
    "test/archive-recovery-worker.ts",
  ])
  run("docker", ["compose", "up", "-d", "--wait", "--no-recreate", "postgres"])
  const env = {
    DATABASE_URL: databases.create("e2e"),
    VERIFICATION_RUN_ID: databases.runId,
    ATLAS_FAKE_MAILBOX_DIR: fixtureRoot,
  }
  run("pnpm", ["--filter", "@workspace/db", "db:migrate"], env)
  run("pnpm", ["--filter", "api", "bootstrap"], env)
  run(
    "pnpm",
    ["--filter", "api", "exec", "tsx", "test/archive-recovery-verification.ts"],
    env
  )
} finally {
  databases.cleanup()
  rmSync(fixtureRoot, { recursive: true })
}
console.log("Archive-only recovery verification: PASS")

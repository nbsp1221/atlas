import { verificationPostgresArgs } from "./verification-isolation.mjs"
import { randomBytes } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import {
  assertPortAvailable,
  ownedVerificationDatabases,
  verificationDatabaseUrl,
  verificationServerConfig,
} from "./verification-isolation.mjs"

function run(command, args, env = {}) {
  if (command === "docker") args = verificationPostgresArgs(args)
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: "inherit",
  })
  if (result.error) throw result.error
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed (exit ${result.status}, signal ${result.signal})`
    )
}

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

const fixtureRoot = mkdtempSync(join(tmpdir(), "atlas-full-verify-"))
process.env.ATLAS_FAKE_MAILBOX_DIR = fixtureRoot
const candidateRoot = resolve(
  "audit/admin-auth/verification",
  databases.runId,
  "build"
)
const certPath = join(fixtureRoot, "cert.pem")
const keyPath = join(fixtureRoot, "key.pem")

const authEnv = {
  ATLAS_AUTH_SECRET: randomBytes(48).toString("base64url"),
  ATLAS_PUBLIC_URL:
    "https://localhost:" + (process.env.VERIFY_WEB_PORT ?? "44174"),
  ATLAS_TLS_CERT_FILE: certPath,
  ATLAS_TLS_KEY_FILE: keyPath,
  ATLAS_WEB_DIST: join(candidateRoot, "web"),
  ATLAS_CREDENTIAL_ACTIVE_KEY: "fixture",
  ATLAS_CREDENTIAL_KEYS: JSON.stringify({
    fixture: randomBytes(32).toString("base64"),
  }),
  ATLAS_TEST_OWNER_PASSWORD: randomBytes(24).toString("base64url"),
  ATLAS_TEST_STORAGE_STATE: join(fixtureRoot, "browser-state.json"),
}

try {
  run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
    "-keyout",
    keyPath,
    "-out",
    certPath,
  ])
  // Fail before any database work when canonical/mismatched ports are supplied.
  const e2eConfig = verificationServerConfig({
    ...process.env,
    ...authEnv,
    VERIFICATION_RUN_ID: databases.runId,
    DATABASE_URL: verificationDatabaseUrl("e2e", databases.runId),
    API_PORT: process.env.VERIFY_API_PORT ?? "43001",
  })
  await assertPortAvailable(e2eConfig.apiPort)
  await assertPortAvailable(e2eConfig.webPort)

  run("node", ["--test", "scripts/test/*.test.mjs"])
  run("pnpm", ["check:boundaries"])
  // Keep the full gate within the supported 2 GiB sandbox budget.
  run("pnpm", ["typecheck", "--concurrency=1"])
  run("pnpm", ["--filter", "api", "exec", "tsc", "-p", "tsconfig.test.json"])
  run("pnpm", ["--filter", "web", "exec", "tsc", "-p", "tsconfig.test.json"])
  run("pnpm", ["lint", "--concurrency=1"])
  run("pnpm", [
    "--filter",
    "api",
    "exec",
    "tsc",
    "-p",
    "tsconfig.build.json",
    "--outDir",
    join(candidateRoot, "api"),
  ])
  run("pnpm", ["--filter", "web", "exec", "tsc", "-b"])
  run("pnpm", [
    "--filter",
    "web",
    "exec",
    "vite",
    "build",
    "--outDir",
    join(candidateRoot, "web"),
  ])
  run("docker", ["compose", "up", "-d", "--wait", "--no-recreate", "postgres"])

  const schemaUrl = databases.create("schema")
  run("pnpm", ["--filter", "@workspace/db", "db:migrate"], {
    DATABASE_URL: schemaUrl,
  })
  run("pnpm", ["--filter", "@workspace/db", "db:verify"], {
    DATABASE_URL: schemaUrl,
  })

  const runtimeUrl = databases.create("runtime")
  run("pnpm", ["--filter", "@workspace/db", "db:migrate"], {
    DATABASE_URL: runtimeUrl,
  })
  run("pnpm", ["--filter", "api", "bootstrap"], { DATABASE_URL: runtimeUrl })
  run("pnpm", ["--filter", "api", "runtime:verify"], {
    DATABASE_URL: runtimeUrl,
  })

  databases.create("e2e")
  run("pnpm", ["--filter", "@workspace/db", "db:migrate"], e2eConfig.env)
  run("pnpm", ["--filter", "api", "bootstrap"], e2eConfig.env)
  run(
    "pnpm",
    ["--filter", "api", "exec", "tsx", "test/provision-verification-owner.ts"],
    e2eConfig.env
  )
  run("pnpm", ["test", "--concurrency=1"], e2eConfig.env)
  run("node", ["scripts/verify-connections.mjs"])
  run("node", ["scripts/verify-key-maintenance.mjs"])
  run("node", ["scripts/verify-admin-auth.mjs"])
  run("pnpm", ["verify:upgrade"])
  run("node", ["scripts/verify-message-admission.mjs"])
  run("node", ["scripts/verify-archive-recovery.mjs"])
} finally {
  databases.cleanup()
  rmSync(fixtureRoot, { recursive: true })
}

console.log("Full verification gate: PASS")

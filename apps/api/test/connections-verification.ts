import { verificationDatabaseUrl, verificationPostgresArgs } from "../../../scripts/verification-isolation.mjs"
import { spawnSync } from "node:child_process"
import { runDetailReadModel } from "../src/read-models"
import { runDetailSchema } from "@workspace/domain"
import { createAutomationBindingService } from "../src/connections/automation-bindings"
import { executeEmailTriageTestRun } from "../src/composition/execute-email-triage-test-run"
import { fakeEmail } from "@workspace/automation-simulation"
import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import {
  createDatabase,
  createConnectionRepository,
  connections,
  credentialSecrets,
  oauthClients,
  interactionChannels,
  automationVersions,
  createReadRepository,
  modelInvocations,
} from "@workspace/db"
import { CredentialCrypto } from "../src/connections/crypto"
import {
  createConnectionService,
  defaultProviderOperations,
  type ProviderOperations,
} from "../src/connections/service"
import {
  GOOGLE_SCOPES,
  ProviderError,
  GoogleGrantError,
} from "@workspace/integrations"
const runId = process.env.VERIFICATION_RUN_ID
if (
  !runId ||
  !/^[a-f0-9]{24}$/.test(runId) ||
  process.env.DATABASE_URL !==
    verificationDatabaseUrl("runtime", runId)
)
  throw new Error("Refusing non-isolated Connections database")
const { db, client } = createDatabase(process.env.DATABASE_URL),
  repo = createConnectionRepository(db)
const crypto = new CredentialCrypto("unit", {
  unit: randomBytes(32).toString("base64"),
})
let probeFailure = false,
  googleFailure = false,
  refreshCount = 0,
  sub = "fixture-google-sub",
  refreshRejected = false,
  expired = false,
  exchangeWait: Promise<void> | null = null
const providers: ProviderOperations = {
  ...defaultProviderOperations,
  checkOpenAI: async () => {
    if (probeFailure) throw new ProviderError("provider_auth_rejected")
    return { principalType: null, principalId: null, scopes: ["models.list"] }
  },
  exchangeGoogleCode: async () => {
    if (exchangeWait) await exchangeWait
    return {
      accessToken: "synthetic-access",
      refreshToken: "synthetic-refresh",
      expiresAt: expired ? 0 : Date.now() + 3600000,
      scopes: GOOGLE_SCOPES,
    }
  },
  checkGoogle: async (tokens) => {
    if (googleFailure) throw new ProviderError("provider_unavailable")
    return {
      principalType: "google-sub",
      principalId: sub,
      scopes: tokens.scopes,
    }
  },
  refreshGoogleTokens: async (_client, tokens) => {
    refreshCount++
    await new Promise((r) => setTimeout(r, 30))
    if (refreshRejected) throw new GoogleGrantError()
    return {
      ...tokens,
      accessToken: "synthetic-access-new",
      refreshToken: "synthetic-refresh-rotated",
      expiresAt: Date.now() + 3600000,
    }
  },
  revokeGoogleTokens: async () => {},
}
const service = createConnectionService(
  repo,
  crypto,
  "https://atlas.example",
  providers
)
const current = async (id: string) =>
  (await service.list()).connections.find((c) => c.id === id)!
const stateOf = (authorizationUrl: string) =>
  new URL(authorizationUrl).searchParams.get("state")!
try {
  const added = (
    await service.addApiKey({
      providerKey: "openai",
      label: "Reusable test",
      secret: "synthetic-private-canary",
    })
  ).connection
  assert.equal(added.authState, "unchecked")
  assert(
    !JSON.stringify(await service.list()).includes("synthetic-private-canary")
  )
  const [stored] = await db.select().from(credentialSecrets)
  assert(stored)
  assert(!JSON.stringify(stored).includes("synthetic-private-canary"))
  await service.test(added.id, added.revision)
  let row = await current(added.id)
  assert.equal(row.authState, "ready")
  const before = await db.select().from(credentialSecrets)
  probeFailure = true
  await assert.rejects(
    () => service.replace(row.id, row.revision, "bad-synthetic"),
    /provider_auth_rejected/
  )
  probeFailure = false
  assert.deepEqual(await db.select().from(credentialSecrets), before)
  await assert.rejects(
    () => service.replace(row.id, added.revision, "new-synthetic"),
    /connection_changed/
  )
  await service.replace(row.id, row.revision, "new-synthetic")
  row = await current(row.id)
  assert.equal(row.id, added.id)
  await db.insert(interactionChannels).values({
    key: "fixture-channel",
    label: "fixture",
    integrationKey: "openai",
    connectionId: row.id,
    endpointRef: {
      integrationKey: "openai",
      resourceType: "fixture",
      externalId: "fixture",
    },
    direction: "outbound",
    status: "active",
    config: {},
  })
  await service.lifecycle(row.id, row.revision, "disconnect")
  row = await current(row.id)
  assert(row.hasSecret)
  assert.equal(row.status, "disabled")
  await assert.rejects(
    () => service.resolveLive(row.id, "openai", ["models.list"]),
    /connection_unavailable/
  )
  await service.lifecycle(row.id, row.revision, "resume")
  row = await current(row.id)
  assert.equal(row.status, "active")
  await service.resolveLive(row.id, "openai", ["models.list"])
  await service.lifecycle(row.id, row.revision, "disconnect")
  row = await current(row.id)
  await service.lifecycle(row.id, row.revision, "forget")
  row = await current(row.id)
  assert(!row.hasSecret)
  await service.lifecycle(row.id, row.revision, "archive")
  row = await current(row.id)
  assert.equal(row.status, "archived")
  await assert.rejects(() =>
    db.delete(connections).where(eq(connections.id, row.id))
  )
  assert.equal(
    (
      await db
        .select()
        .from(interactionChannels)
        .where(eq(interactionChannels.key, "fixture-channel"))
    ).length,
    1
  )
  await service.saveGoogleClient({
    clientId: "fixture-a.apps.googleusercontent.com",
    clientSecret: "synthetic-client-value",
  })
  const auth = await service.authorize({
    sessionId: "session-one",
    label: "Google fixture",
  })
  await assert.rejects(
    () =>
      service.callback({
        sessionId: "wrong-session",
        state: stateOf(auth.authorizationUrl),
        code: "synthetic-code",
      }),
    /oauth_attempt_invalid/
  )
  const google = (
    await service.callback({
      sessionId: "session-one",
      state: stateOf(auth.authorizationUrl),
      code: "synthetic-code",
    })
  ).connection
  assert.equal(google.authState, "ready")
  assert.equal(google.principalId, sub)
  await assert.rejects(
    () =>
      service.callback({
        sessionId: "session-one",
        state: stateOf(auth.authorizationUrl),
        code: "synthetic-code",
      }),
    /oauth_attempt_invalid/
  )
  const reconnect = await service.authorize({
    sessionId: "session-one",
    connectionId: google.id,
    revision: google.revision,
  })
  sub = "wrong-account"
  await assert.rejects(
    () =>
      service.callback({
        sessionId: "session-one",
        state: stateOf(reconnect.authorizationUrl),
        code: "synthetic-code",
      }),
    /account_mismatch/
  )
  sub = "fixture-google-sub"
  assert.equal((await current(google.id)).principalId, sub)
  // Refresh rotates successfully, then account check fails: durable token must still rotate.
  expired = true
  const another = await service.authorize({
    sessionId: "session-two",
    label: "Refresh fixture",
  })
  const rotating = (
    await service.callback({
      sessionId: "session-two",
      state: stateOf(another.authorizationUrl),
      code: "synthetic-code",
    })
  ).connection
  googleFailure = true
  await service.test(rotating.id, rotating.revision)
  googleFailure = false
  const [r] = await db
    .select()
    .from(connections)
    .where(eq(connections.id, rotating.id))
  const [secret] = await db
    .select()
    .from(credentialSecrets)
    .where(eq(credentialSecrets.id, r.credentialId!))
  assert.equal(
    (
      crypto.decrypt(secret.envelope, {
        id: secret.id,
        provider: "google",
        authType: "oauth2",
      }) as { refreshToken: string }
    ).refreshToken,
    "synthetic-refresh-rotated"
  )
  await service.test(rotating.id, (await current(rotating.id)).revision)
  // Another expired connection, simultaneous reads share one refresh.
  const concurrentAuth = await service.authorize({
    sessionId: "session-three",
    label: "Concurrent",
  })
  const concurrent = (
    await service.callback({
      sessionId: "session-three",
      state: stateOf(concurrentAuth.authorizationUrl),
      code: "synthetic-code",
    })
  ).connection
  const start = refreshCount
  await Promise.all([
    service.resolveLive(concurrent.id, "google", GOOGLE_SCOPES),
    service.resolveLive(concurrent.id, "google", GOOGLE_SCOPES),
  ])
  assert.equal(refreshCount - start, 1)
  assert.equal((await current(concurrent.id)).revision, concurrent.revision)
  // Revoked refresh is persisted as reauth-required, not repeatedly retried.
  const revokedAuth = await service.authorize({
    sessionId: "session-four",
    label: "Revoked",
  })
  const revoked = (
    await service.callback({
      sessionId: "session-four",
      state: stateOf(revokedAuth.authorizationUrl),
      code: "synthetic-code",
    })
  ).connection
  refreshRejected = true
  await assert.rejects(
    () => service.resolveLive(revoked.id, "google", GOOGLE_SCOPES),
    /reauth_required/
  )
  refreshRejected = false
  assert.equal((await current(revoked.id)).authState, "reauth_required")
  // Callback client generation must remain the same through final DB commit.
  let release!: () => void
  exchangeWait = new Promise<void>((resolve) => {
    release = resolve
  })
  const raceAuth = await service.authorize({
    sessionId: "session-race",
    label: "Race",
  })
  const pending = service.callback({
    sessionId: "session-race",
    state: stateOf(raceAuth.authorizationUrl),
    code: "synthetic-code",
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  const config = (await repo.listOAuthClients())[0]
  await service.saveGoogleClient({
    clientId: config.clientId,
    clientSecret: "synthetic-client-rotation",
    revision: config.revision,
  })
  release()
  await assert.rejects(() => pending, /oauth_client_changed/)
  exchangeWait = null
  assert(!(await service.list()).connections.some((c) => c.label === "Race"))
  assert(!JSON.stringify(await service.list()).includes("synthetic-"))
  assert.equal((await db.select().from(oauthClients)).length, 1)
  const bindingService = createAutomationBindingService(db),
    selected = await bindingService.get()
  const [originalVersion] = await db
    .select()
    .from(automationVersions)
    .where(eq(automationVersions.versionNumber, selected.version))
  const modelConnection = (
    await service.addApiKey({
      providerKey: "openai",
      label: "Reusable model",
      secret: "synthetic-bound-key",
    })
  ).connection
  const configured = await bindingService.save({
    expectedVersion: selected.version,
    mailboxConnectionId: google.id,
    modelConnectionId: modelConnection.id,
    model: "fixture-model-name",
  })
  assert(configured.version > selected.version)
  await assert.rejects(
    () =>
      bindingService.save({
        expectedVersion: selected.version,
        mailboxConnectionId: google.id,
        modelConnectionId: null,
        model: "",
      }),
    /automation_changed/
  )
  const [unchanged] = await db
    .select()
    .from(automationVersions)
    .where(eq(automationVersions.id, originalVersion.id))
  assert.deepEqual(unchanged, originalVersion)
  const execution = await executeEmailTriageTestRun(db, {
    email: fakeEmail({ messageId: "connections-binding-fixture" }),
    scenario: { route: "no_action" },
  })
  assert.equal(execution.kind, "executed")
  if (execution.kind !== "executed")
    throw new Error("Bound fake execution failed")
  const bundle = await createReadRepository(db).findRun(execution.result.runId)
  assert(bundle)
  assert.equal(
    runDetailSchema.parse(runDetailReadModel(bundle)).modelInvocations[0]
      ?.connectionId,
    modelConnection.id
  )
  assert(
    (
      await db
        .select()
        .from(modelInvocations)
        .where(eq(modelInvocations.connectionId, modelConnection.id))
    ).length > 0
  )
  const immutableSnapshot = (value: typeof bundle) =>
    JSON.stringify({ ...value, automation: undefined })
  const snapshot = immutableSnapshot(bundle)
  assert(!snapshot.includes("synthetic-bound-key"))
  const latest = await bindingService.get()
  await bindingService.save({
    expectedVersion: latest.version,
    mailboxConnectionId: rotating.id,
    modelConnectionId: null,
    model: "",
  })
  assert.equal(
    immutableSnapshot(
      (await createReadRepository(db).findRun(execution.result.runId))!
    ),
    snapshot
  )
  // Reconnect a disabled initial Google shell establishes its first verified identity.
  const shell = (await service.list()).connections.find(
    (c) => c.key === "google-primary"
  )!
  const shellAttempt = await service.authorize({
    sessionId: "shell-session",
    connectionId: shell.id,
    revision: shell.revision,
  })
  const connectedShell = (
    await service.callback({
      sessionId: "shell-session",
      state: stateOf(shellAttempt.authorizationUrl),
      code: "synthetic-code",
    })
  ).connection
  assert.equal(connectedShell.id, shell.id)
  assert.equal(connectedShell.principalId, sub)
  // Newest authorization invalidates previous outstanding attempts for the same session.
  const attempts = await Promise.all([
    service.authorize({ sessionId: "concurrent-session" }),
    service.authorize({ sessionId: "concurrent-session" }),
  ])
  const results = await Promise.allSettled(
    attempts.map((attempt) =>
      service.callback({
        sessionId: "concurrent-session",
        state: stateOf(attempt.authorizationUrl),
        denied: true,
      })
    )
  )
  assert.equal(
    results.filter(
      (result) =>
        result.status === "rejected" &&
        String(result.reason).includes("oauth_attempt_invalid")
    ).length,
    1
  )

  providers.revokeGoogleTokens = async () => {
    throw new ProviderError("provider_unavailable")
  }
  const beforeRevoke = await current(google.id)
  const failedRevoke = (
    await service.lifecycle(google.id, beforeRevoke.revision, "revoke")
  ).connection
  assert.equal(failedRevoke.status, "disabled")
  assert.equal(failedRevoke.authState, "error")
  assert.equal(failedRevoke.lastErrorCode, "revocation_failed")
  assert(failedRevoke.hasSecret)
  await assert.rejects(
    () => service.lifecycle(google.id, failedRevoke.revision, "resume"),
    /connection_unavailable/
  )
  const restoreUrl = process.env.RESTORE_DATABASE_URL
  assert.equal(
    restoreUrl,
    verificationDatabaseUrl("upgrade", runId)
  )
  const dump = spawnSync(
    "docker",
    verificationPostgresArgs([
      "compose",
      "exec",
      "-T",
      "postgres",
      "pg_dump",
      "-U",
      "postgres",
      "--no-owner",
      "--no-acl",
      "--format=custom",
      `control_plane_verify_runtime_${runId}`,
    ]),
    { maxBuffer: 32 * 1024 * 1024 }
  )
  assert.equal(dump.status, 0, "Isolated fixture backup failed")
  const restore = spawnSync(
    "docker",
    verificationPostgresArgs([
      "compose",
      "exec",
      "-T",
      "postgres",
      "pg_restore",
      "-U",
      "postgres",
      "--no-owner",
      "--no-acl",
      "-d",
      `control_plane_verify_upgrade_${runId}`,
    ]),
    { input: dump.stdout, maxBuffer: 32 * 1024 * 1024 }
  )
  assert.equal(restore.status, 0, "Isolated fixture restore failed")
  const restored = createDatabase(restoreUrl!)
  try {
    const restoredRows = await restored.db.select().from(credentialSecrets)
    assert.deepEqual(
      restoredRows.map((r) => r.id).sort(),
      (await db.select().from(credentialSecrets)).map((r) => r.id).sort()
    )
    for (const row of restoredRows)
      crypto.decrypt(row.envelope, {
        id: row.id,
        provider: row.providerKey,
        authType: row.authType,
      })
    const restoredModels = await restored.db.select().from(modelInvocations)
    assert.equal(
      restoredModels.length,
      (await db.select().from(modelInvocations)).length
    )
    console.log(
      "Isolated database backup/restore + matching-key credential decryption: PASS"
    )
  } finally {
    await restored.client.end()
  }
  console.log(
    "Connections lifecycle, secret rollback, history preservation, OAuth replay/account/client-race and refresh concurrency: PASS"
  )
} finally {
  await client.end()
}

import { verifyCodeAutomations } from "./verify-code-automations"
import assert from "node:assert/strict"
import { eq } from "drizzle-orm"
import {
  connections,
  createDatabase,
  createReadRepository,
} from "@workspace/db"
import { fakeEmail } from "@workspace/automation-simulation"
import { executeEmailTriageTestRun } from "../src/composition/execute-email-triage-test-run"

const databaseUrl = process.env.DATABASE_URL
assert(databaseUrl, "DATABASE_URL is required")

const requestedVersionRaw = process.env.AUTOMATION_VERSION
const requestedVersion = requestedVersionRaw
  ? Number(requestedVersionRaw)
  : undefined
if (
  requestedVersion !== undefined &&
  (!Number.isInteger(requestedVersion) || requestedVersion <= 0)
) {
  throw new Error("AUTOMATION_VERSION must be a positive integer")
}

const { db, client } = createDatabase(databaseUrl)
const readRepository = createReadRepository(db)

async function execute(
  name: string,
  scenario: Parameters<typeof executeEmailTriageTestRun>[1]["scenario"]
) {
  const result = await executeEmailTriageTestRun(db, {
    email: fakeEmail({
      messageId: `runtime-${name}`,
      subject: `Runtime scenario: ${name}`,
    }),
    version: requestedVersion,
    scenario,
  })
  assert.equal(result.kind, "executed", `${name}: execution setup failed`)
  if (result.kind !== "executed") throw new Error("unreachable")

  const bundle = await readRepository.findRun(result.result.runId)
  assert(bundle, `${name}: run not found after execution`)
  return { execution: result.result, bundle }
}

async function main() {
  const activeBaseline =
    await readRepository.findAutomationVersion("email-triage")
  assert(activeBaseline?.version, "Email Triage active version is required")
  const activeVersionId = activeBaseline.automation.activeVersionId

  const target = requestedVersion
    ? await readRepository.findAutomationVersion(
        "email-triage",
        requestedVersion
      )
    : activeBaseline
  assert(target?.version, "Requested Email Triage version is required")
  assert.equal(target.version.graphDefinition.schemaVersion, 2)

  const serializedGraph = JSON.stringify(target.version.graphDefinition)
  assert(!serializedGraph.includes("gmail-primary"))
  assert(!serializedGraph.includes("telegram-personal"))
  assert(serializedGraph.includes('"integrationKey":"gmail"'))
  assert(serializedGraph.includes('"connectionKey":"google-primary"'))
  assert(
    serializedGraph.includes('"interactionChannelKey":"personal-notifications"')
  )
  process.stdout.write(
    `✓ canonical Email Triage v${target.version.versionNumber} graph bindings verified\n`
  )

  const liveBaseline = await readRepository.overviewSince(new Date(0))
  const liveBaselineCounts = {
    runs: liveBaseline.runs.length,
    actions: liveBaseline.actions.length,
    models: liveBaseline.models.length,
  }

  const expectedActions = {
    notify: ["telegram", "send-message"],
    archive: ["gmail", "archive-message"],
    spam: ["gmail", "report-spam"],
  } as const

  for (const route of ["notify", "archive", "spam"] as const) {
    const { execution, bundle } = await execute(`${route}-verified`, {
      route,
      verificationBehavior: "verified",
    })
    assert.equal(execution.status, "succeeded")
    assert.equal(bundle.run.mode, "test")
    assert.equal(bundle.run.status, "succeeded")
    assert.equal(bundle.run.triggerIntegrationKey, null)
    assert.equal(bundle.run.triggerConnectionId, null)
    assert.equal(bundle.models.length, 1)
    assert.equal(bundle.actions.length, 1)
    assert.equal(bundle.actions[0].executionStatus, "succeeded")
    assert.equal(bundle.actions[0].verificationStatus, "verified")
    assert.equal(bundle.actions[0].integrationKey, expectedActions[route][0])
    assert.equal(bundle.actions[0].actionKey, expectedActions[route][1])
    assert.equal(
      bundle.nodes.find((node) => node.nodeKey === "classify_email")
        ?.selectedEdgeKey,
      route
    )

    if (route === "notify") {
      const request = bundle.actions[0].requestSnapshot as {
        resource?: {
          integrationKey?: string
          resourceType?: string
          externalId?: string
        }
      }
      assert.deepEqual(request.resource, {
        integrationKey: "telegram",
        resourceType: "chat",
        externalId: "fake-personal-chat",
      })
    }

    process.stdout.write(
      `✓ ${route} -> ${bundle.actions[0].integrationKey}/${bundle.actions[0].actionKey} -> verified\n`
    )
  }

  {
    const { execution, bundle } = await execute("no-action", {
      route: "no_action",
    })
    assert.equal(execution.status, "succeeded")
    assert.equal(bundle.actions.length, 0)
    assert.deepEqual(
      bundle.nodes.map((node) => node.nodeKey),
      ["gmail_event", "classify_email", "no_action"]
    )
    process.stdout.write("✓ no_action terminates without ActionExecution\n")
  }

  {
    const { execution, bundle } = await execute("model-retry", {
      route: "archive",
      modelTransientFailures: 2,
    })
    assert.equal(execution.status, "succeeded")
    const classifier = bundle.nodes.filter(
      (node) => node.nodeKey === "classify_email"
    )
    assert.equal(classifier.length, 1)
    const calls = bundle.models.filter(
      (model) => model.nodeExecutionId === classifier[0].id
    )
    assert.deepEqual(
      calls.map((call) => call.status),
      ["failed", "failed", "succeeded"]
    )
    process.stdout.write(
      "✓ provider retry = multiple ModelInvocations inside one NodeExecution\n"
    )
  }

  {
    const { execution, bundle } = await execute("node-retry", {
      route: "notify",
      verificationTransientFailures: 1,
    })
    assert.equal(execution.status, "succeeded")
    const verificationNodes = bundle.nodes.filter(
      (node) => node.nodeKey === "verify_delivery"
    )
    assert.equal(verificationNodes.length, 2)
    assert.equal(verificationNodes[0].status, "failed")
    assert.equal(verificationNodes[1].status, "succeeded")
    assert.equal(
      verificationNodes[1].retryOfNodeExecutionId,
      verificationNodes[0].id
    )
    assert.equal(bundle.actions[0].verificationStatus, "verified")
    process.stdout.write(
      "✓ whole-node retry remains distinct from provider retry\n"
    )
  }

  {
    const { execution, bundle } = await execute("model-permanent-failure", {
      modelPermanentFailure: true,
    })
    assert.equal(execution.status, "failed")
    assert.equal(bundle.run.status, "failed")
    assert.equal(bundle.models.length, 1)
    assert.equal(bundle.models[0].status, "failed")
    assert.equal(bundle.actions.length, 0)
    assert.equal(bundle.run.error?.code, "fake_model_permanent")
    process.stdout.write("✓ permanent model failure remains inspectable\n")
  }

  {
    const { execution, bundle } = await execute("malformed-model-output", {
      malformedModelOutput: true,
    })
    assert.equal(execution.status, "failed")
    assert.equal(bundle.run.error?.code, "invalid_node_output")
    assert.equal(bundle.models[0].status, "succeeded")
    assert.equal(
      bundle.nodes.find((node) => node.nodeKey === "classify_email")?.status,
      "failed"
    )
    process.stdout.write(
      "✓ malformed structured output is preserved and rejected\n"
    )
  }

  {
    const { execution, bundle } = await execute("undefined-route", {
      modelOutputOverride: {
        route: "delete_everything",
        confidence: 1,
      },
    })
    assert.equal(execution.status, "failed")
    assert.equal(bundle.run.error?.code, "invalid_node_output")
    assert.equal(bundle.actions.length, 0)
    process.stdout.write("✓ model cannot invent an undefined route\n")
  }

  {
    const { execution, bundle } = await execute("action-failure", {
      route: "notify",
      actionBehavior: "failure",
    })
    assert.equal(execution.status, "failed")
    assert.equal(bundle.actions.length, 1)
    assert.equal(bundle.actions[0].executionStatus, "failed")
    assert.equal(bundle.actions[0].verificationStatus, "pending")
    assert.equal(bundle.run.error?.code, "external_action_failure")
    process.stdout.write("✓ external action failure is retained\n")
  }

  {
    const { execution, bundle } = await execute("action-unknown", {
      route: "notify",
      actionBehavior: "unknown",
    })
    assert.equal(execution.status, "failed")
    assert.equal(bundle.actions[0].executionStatus, "unknown")
    assert.equal(bundle.run.error?.code, "external_action_unknown")
    process.stdout.write("✓ unknown external outcome remains distinct\n")
  }

  for (const verificationStatus of ["unverified", "failed"] as const) {
    const { execution, bundle } = await execute(
      `verification-${verificationStatus}`,
      {
        route: "notify",
        verificationBehavior: verificationStatus,
      }
    )
    assert.equal(execution.status, "succeeded")
    assert.equal(bundle.run.status, "succeeded")
    assert.equal(bundle.actions[0].verificationStatus, verificationStatus)
    process.stdout.write(
      `✓ Run completion remains independent from ${verificationStatus} verification\n`
    )
  }

  const [googleConnection] = await db
    .select()
    .from(connections)
    .where(eq(connections.key, "google-primary"))
    .limit(1)
  assert(googleConnection)

  await db
    .update(connections)
    .set({ providerKey: "telegram" })
    .where(eq(connections.id, googleConnection.id))

  try {
    const mismatch = await executeEmailTriageTestRun(db, {
      email: fakeEmail({
        messageId: "runtime-provider-mismatch",
        subject: "Provider mismatch",
      }),
      version: requestedVersion,
      scenario: { route: "archive" },
    })
    assert.equal(mismatch.kind, "binding_error")
    if (mismatch.kind !== "binding_error") throw new Error("unreachable")
    assert.equal(mismatch.code, "provider_mismatch")
    process.stdout.write(
      "✓ Gmail + Telegram authority is rejected in preflight\n"
    )
  } finally {
    await db
      .update(connections)
      .set({ providerKey: "google" })
      .where(eq(connections.id, googleConnection.id))
  }

  const overview = await readRepository.overviewSince(new Date(0))
  assert.equal(overview.runs.length, liveBaselineCounts.runs)
  assert.equal(overview.actions.length, liveBaselineCounts.actions)
  assert.equal(overview.models.length, liveBaselineCounts.models)
  process.stdout.write("✓ test runs do not contaminate live Overview metrics\n")

  const after = await readRepository.findAutomationVersion("email-triage")
  assert(after?.version)
  assert.equal(after.automation.activeVersionId, activeVersionId)
  process.stdout.write(
    "✓ test execution does not activate a candidate version\n"
  )

  const allRuns = await readRepository.listRuns(100)
  const testRuns = allRuns.rows.filter((row) => row.run.mode === "test")
  assert(testRuns.length >= 12)
  process.stdout.write(
    `✓ ${testRuns.length} provider-independent test runs persisted end-to-end\n`
  )
}

try {
  await main()
  await verifyCodeAutomations(db)
} finally {
  await client.end()
}

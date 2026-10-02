import assert from "node:assert/strict"
import { eq } from "drizzle-orm"
import {
  automationGraphDefinitionSchema,
  isValidSelectedEdge,
  type AutomationGraphDefinition,
} from "@workspace/domain/persistence"
import { createDatabase } from "../src/client"
import {
  actionExecutions,
  automationVersions,
  automations,
  connections,
  interactionChannels,
  modelInvocations,
  nodeExecutions,
  nodeFeedback,
  runs,
} from "../src/schema"

const databaseUrl = process.env.DATABASE_URL
assert(databaseUrl, "DATABASE_URL is required")

const { db, client } = createDatabase(databaseUrl)

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

const at = (minute: number, second = 0, millisecond = 0) =>
  new Date(Date.UTC(2026, 8, 29, 0, minute, second, millisecond))

const ids = {
  automation: {
    email: uuid(1),
    purchase: uuid(2),
  },
  version: {
    emailV7: uuid(101),
    emailV8: uuid(102),
    emailV9: uuid(103),
    purchaseV1: uuid(104),
  },
  connection: {
    gmail: uuid(201),
    telegram: uuid(202),
  },
  run: {
    toss: uuid(301),
    github: uuid(302),
    cloudflare: uuid(303),
    newsletter: uuid(304),
    personal: uuid(305),
    crash: uuid(306),
    retry: uuid(307),
    replay: uuid(308),
    purchaseParent: uuid(309),
    purchaseChild: uuid(310),
  },
  node: {
    tossTrigger: uuid(1001),
    tossClassify: uuid(1002),
    tossNotify: uuid(1003),
    tossVerify: uuid(1004),

    githubTrigger: uuid(1011),
    githubClassify: uuid(1012),
    githubArchive: uuid(1013),
    githubVerify: uuid(1014),

    cloudflareTrigger: uuid(1021),
    cloudflareClassify: uuid(1022),
    cloudflareNotify: uuid(1023),
    cloudflareVerify: uuid(1024),

    newsletterTrigger: uuid(1031),
    newsletterClassify: uuid(1032),
    newsletterArchive: uuid(1033),
    newsletterVerify: uuid(1034),

    personalTrigger: uuid(1041),
    personalClassify: uuid(1042),
    personalTerminal: uuid(1043),

    crashTrigger: uuid(1051),
    crashClassify: uuid(1052),
    crashNotify: uuid(1053),

    retryTrigger: uuid(1061),
    retryClassify: uuid(1062),
    retryArchive: uuid(1063),
    retryVerifyFailed: uuid(1064),
    retryVerifySucceeded: uuid(1065),

    replayClassify: uuid(1071),
    replayActionSkipped: uuid(1072),

    purchaseParentClassify: uuid(1081),
    purchaseParentInvoke: uuid(1082),

    purchaseInput: uuid(1091),
    purchaseExtract: uuid(1092),
    purchaseWrite: uuid(1093),
  },
}

function emailGraph(
  model: string,
  includePurchase = false
): AutomationGraphDefinition {
  const graph = {
    schemaVersion: 1,
    nodes: [
      {
        key: "gmail_event",
        kind: "trigger" as const,
        label: "Gmail event",
        config: {},
      },
      {
        key: "classify_email",
        kind: "decision" as const,
        label: "Classify mail",
        config: { modelProvider: "provider-x", model, prompt: "classifier-v4" },
      },
      {
        key: "archive_email",
        kind: "action" as const,
        label: "Archive",
        config: { connectionKey: "google-primary" },
      },
      {
        key: "notify_user",
        kind: "action" as const,
        label: "Notify",
        config: { connectionKey: "telegram-atlas-bot" },
      },
      {
        key: "report_spam",
        kind: "action" as const,
        label: "Spam",
        config: { connectionKey: "google-primary" },
      },
      {
        key: "no_action",
        kind: "terminal" as const,
        label: "No action",
        config: {},
      },
      {
        key: "verify_archive",
        kind: "verify" as const,
        label: "Verify archive",
        config: {},
      },
      {
        key: "verify_delivery",
        kind: "verify" as const,
        label: "Verify delivery",
        config: {},
      },
      {
        key: "verify_spam",
        kind: "verify" as const,
        label: "Verify spam",
        config: {},
      },
      ...(includePurchase
        ? [
            {
              key: "invoke_purchase_extraction",
              kind: "action" as const,
              label: "Extract purchase",
              config: { automationKey: "purchase-extraction" },
            },
          ]
        : []),
    ],
    edges: [
      { key: "trigger", source: "gmail_event", target: "classify_email" },
      { key: "archive", source: "classify_email", target: "archive_email" },
      { key: "notify", source: "classify_email", target: "notify_user" },
      { key: "spam", source: "classify_email", target: "report_spam" },
      { key: "no_action", source: "classify_email", target: "no_action" },
      {
        key: "archive_verify",
        source: "archive_email",
        target: "verify_archive",
      },
      {
        key: "notify_verify",
        source: "notify_user",
        target: "verify_delivery",
      },
      { key: "spam_verify", source: "report_spam", target: "verify_spam" },
      ...(includePurchase
        ? [
            {
              key: "purchase",
              source: "classify_email",
              target: "invoke_purchase_extraction",
            },
          ]
        : []),
    ],
  }

  return automationGraphDefinitionSchema.parse(graph)
}

const emailV7Graph = emailGraph("Jev")
const emailV8Graph = emailGraph("AlternativeModel")
const emailV9Graph = emailGraph("Jev", true)
const purchaseV1Graph = automationGraphDefinitionSchema.parse({
  schemaVersion: 1,
  nodes: [
    {
      key: "purchase_input",
      kind: "trigger",
      label: "Purchase input",
      config: {},
    },
    {
      key: "extract_purchase",
      kind: "decision",
      label: "Extract purchase",
      config: { modelProvider: "provider-x", model: "Jev" },
    },
    {
      key: "write_purchase_fact",
      kind: "action",
      label: "Write purchase fact",
      config: { target: "local-db" },
    },
  ],
  edges: [
    { key: "extract", source: "purchase_input", target: "extract_purchase" },
    {
      key: "success",
      source: "extract_purchase",
      target: "write_purchase_fact",
    },
  ],
})

assert.equal(
  isValidSelectedEdge(emailV7Graph, "classify_email", "purchase"),
  false
)
assert.equal(
  isValidSelectedEdge(emailV9Graph, "classify_email", "purchase"),
  true
)

type PgError = {
  code?: string
  constraint_name?: string
  constraint?: string
  cause?: PgError
}

function postgresError(error: unknown): PgError {
  const wrapped = error as PgError
  return wrapped.code ? wrapped : (wrapped.cause ?? wrapped)
}

async function expectPgError(
  label: string,
  expectedCode: string,
  operation: () => Promise<unknown>
) {
  try {
    await operation()
    assert.fail(`${label}: expected PostgreSQL error ${expectedCode}`)
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error
    const pgError = postgresError(error)
    assert.equal(
      pgError.code,
      expectedCode,
      `${label}: expected PostgreSQL ${expectedCode}, got ${pgError.code ?? "unknown"}`
    )
    process.stdout.write(`✓ ${label} -> ${expectedCode}\n`)
  }
}

async function insertRun(values: typeof runs.$inferInsert) {
  await db.insert(runs).values(values)
}

async function insertNode(values: typeof nodeExecutions.$inferInsert) {
  await db.insert(nodeExecutions).values(values)
}

async function main() {
  await db.insert(automations).values([
    {
      id: ids.automation.email,
      key: "email-triage",
      name: "Email Triage",
      status: "active",
    },
    {
      id: ids.automation.purchase,
      key: "purchase-extraction",
      name: "Purchase Extraction",
      status: "active",
    },
  ])

  await db.insert(automationVersions).values([
    {
      id: ids.version.emailV7,
      automationId: ids.automation.email,
      versionNumber: 7,
      definitionSchemaVersion: 1,
      graphDefinition: emailV7Graph,
      definitionHash: "sha256:email-v7",
      sourceRevision: "fixture:email-v7",
    },
    {
      id: ids.version.emailV8,
      automationId: ids.automation.email,
      versionNumber: 8,
      definitionSchemaVersion: 1,
      graphDefinition: emailV8Graph,
      definitionHash: "sha256:email-v8",
      sourceRevision: "fixture:email-v8",
    },
    {
      id: ids.version.emailV9,
      automationId: ids.automation.email,
      versionNumber: 9,
      definitionSchemaVersion: 1,
      graphDefinition: emailV9Graph,
      definitionHash: "sha256:email-v9-purchase",
      sourceRevision: "fixture:email-v9",
    },
    {
      id: ids.version.purchaseV1,
      automationId: ids.automation.purchase,
      versionNumber: 1,
      definitionSchemaVersion: 1,
      graphDefinition: purchaseV1Graph,
      definitionHash: "sha256:purchase-v1",
      sourceRevision: "fixture:purchase-v1",
    },
  ])

  await db
    .update(automations)
    .set({ activeVersionId: ids.version.emailV9 })
    .where(eq(automations.id, ids.automation.email))
  await db
    .update(automations)
    .set({ activeVersionId: ids.version.purchaseV1 })
    .where(eq(automations.id, ids.automation.purchase))

  await db.insert(connections).values([
    {
      id: ids.connection.gmail,
      key: "google-primary",
      providerKey: "google",
      label: "Primary Google",
      externalPrincipalType: "account",
      externalPrincipalId: "google-account-stable-id",
      grants: {
        scopes: ["https://www.googleapis.com/auth/gmail.modify"],
      },
      config: {},
      credentialRef: "secret:google-primary",
      status: "active",
      lastCheckStatus: "healthy",
      lastCheckedAt: at(0),
    },
    {
      id: ids.connection.telegram,
      key: "telegram-atlas-bot",
      providerKey: "telegram",
      label: "Atlas Telegram bot",
      externalPrincipalType: "bot",
      externalPrincipalId: "telegram-bot-stable-id",
      grants: {},
      config: {},
      credentialRef: "secret:telegram-atlas-bot",
      status: "active",
      lastCheckStatus: "healthy",
      lastCheckedAt: at(0),
    },
  ])

  await db.insert(interactionChannels).values({
    id: uuid(203),
    key: "personal-notifications",
    label: "Personal notifications",
    integrationKey: "telegram",
    connectionId: ids.connection.telegram,
    endpointRef: {
      integrationKey: "telegram",
      resourceType: "chat",
      externalId: "personal-chat",
    },
    direction: "outbound",
    status: "active",
    config: {},
    createdAt: at(0),
    updatedAt: at(0),
  })

  // S1: Toss -> notify -> verified.
  await insertRun({
    id: ids.run.toss,
    automationId: ids.automation.email,
    automationVersionId: ids.version.emailV7,
    mode: "live",
    status: "succeeded",
    triggerIntegrationKey: "gmail",
    triggerConnectionId: ids.connection.gmail,
    idempotencyKey: "gmail:google-primary:m_toss",
    triggerSnapshot: { providerMessageId: "m_toss" },
    inputSnapshot: { subject: "Open API 문의에 답변드립니다", body: "..." },
    outputSnapshot: { route: "notify" },
    createdAt: at(1),
    startedAt: at(1, 1),
    finishedAt: at(1, 5),
  })
  await db.insert(nodeExecutions).values([
    {
      id: ids.node.tossTrigger,
      runId: ids.run.toss,
      sequence: 1,
      nodeKey: "gmail_event",
      nodeKind: "trigger",
      status: "succeeded",
      inputSnapshot: { providerMessageId: "m_toss" },
      startedAt: at(1, 1),
      finishedAt: at(1, 1),
    },
    {
      id: ids.node.tossClassify,
      runId: ids.run.toss,
      sequence: 2,
      nodeKey: "classify_email",
      nodeKind: "decision",
      status: "succeeded",
      selectedEdgeKey: "notify",
      inputSnapshot: { subject: "Open API 문의에 답변드립니다", body: "..." },
      outputSnapshot: { route: "notify" },
      startedAt: at(1, 2),
      finishedAt: at(1, 3),
    },
    {
      id: ids.node.tossNotify,
      runId: ids.run.toss,
      sequence: 3,
      nodeKey: "notify_user",
      nodeKind: "action",
      status: "succeeded",
      inputSnapshot: { route: "notify" },
      outputSnapshot: { action: "telegram.notify" },
      startedAt: at(1, 3),
      finishedAt: at(1, 4),
    },
    {
      id: ids.node.tossVerify,
      runId: ids.run.toss,
      sequence: 4,
      nodeKey: "verify_delivery",
      nodeKind: "verify",
      status: "succeeded",
      inputSnapshot: { action: "telegram.notify" },
      outputSnapshot: { result: "verified" },
      startedAt: at(1, 4),
      finishedAt: at(1, 5),
    },
  ])
  await db.insert(modelInvocations).values({
    id: uuid(2001),
    nodeExecutionId: ids.node.tossClassify,
    sequence: 1,
    status: "succeeded",
    modelProvider: "provider-x",
    model: "Jev",
    modelParameters: { temperature: 0 },
    providerRequestId: "req-toss",
    inputSnapshot: { subject: "Open API 문의에 답변드립니다", body: "..." },
    outputSnapshot: { route: "notify" },
    usageDetails: { input: 1281, output: 14 },
    costDetails: { totalUsd: 0.000021 },
    costUsd: "0.000021000000",
    durationMs: 174,
    startedAt: at(1, 2),
    finishedAt: at(1, 3),
  })
  await db.insert(actionExecutions).values({
    id: uuid(3001),
    nodeExecutionId: ids.node.tossNotify,
    sequence: 1,
    connectionId: ids.connection.telegram,
    integrationKey: "telegram",
    actionKey: "send-message",
    idempotencyKey: "r_toss:notify_user:0",
    executionStatus: "succeeded",
    verificationStatus: "verified",
    verifiedByNodeExecutionId: ids.node.tossVerify,
    externalRef: "telegram:823410",
    requestSnapshot: { redacted: true },
    responseSnapshot: { messageId: 823410 },
    verificationEvidence: { messageId: 823410 },
    startedAt: at(1, 3),
    finishedAt: at(1, 4),
    verifiedAt: at(1, 5),
  })

  // S2: Dependabot -> archive -> verified.
  await insertRun({
    id: ids.run.github,
    automationId: ids.automation.email,
    automationVersionId: ids.version.emailV7,
    mode: "live",
    status: "succeeded",
    triggerIntegrationKey: "gmail",
    triggerConnectionId: ids.connection.gmail,
    idempotencyKey: "gmail:google-primary:m_github",
    triggerSnapshot: { providerMessageId: "m_github" },
    inputSnapshot: { subject: "[GitHub] Dependabot alert" },
    outputSnapshot: { route: "archive" },
    createdAt: at(10),
    startedAt: at(10, 1),
    finishedAt: at(10, 5),
  })
  await db.insert(nodeExecutions).values([
    {
      id: ids.node.githubTrigger,
      runId: ids.run.github,
      sequence: 1,
      nodeKey: "gmail_event",
      nodeKind: "trigger",
      status: "succeeded",
      inputSnapshot: { providerMessageId: "m_github" },
      startedAt: at(10, 1),
      finishedAt: at(10, 1),
    },
    {
      id: ids.node.githubClassify,
      runId: ids.run.github,
      sequence: 2,
      nodeKey: "classify_email",
      nodeKind: "decision",
      status: "succeeded",
      selectedEdgeKey: "archive",
      inputSnapshot: { subject: "[GitHub] Dependabot alert" },
      outputSnapshot: { route: "archive" },
      startedAt: at(10, 2),
      finishedAt: at(10, 3),
    },
    {
      id: ids.node.githubArchive,
      runId: ids.run.github,
      sequence: 3,
      nodeKey: "archive_email",
      nodeKind: "action",
      status: "succeeded",
      inputSnapshot: { providerMessageId: "m_github" },
      outputSnapshot: { action: "gmail.archive" },
      startedAt: at(10, 3),
      finishedAt: at(10, 4),
    },
    {
      id: ids.node.githubVerify,
      runId: ids.run.github,
      sequence: 4,
      nodeKey: "verify_archive",
      nodeKind: "verify",
      status: "succeeded",
      inputSnapshot: { providerMessageId: "m_github" },
      outputSnapshot: { inboxLabelPresent: false },
      startedAt: at(10, 4),
      finishedAt: at(10, 5),
    },
  ])
  await db.insert(modelInvocations).values({
    id: uuid(2002),
    nodeExecutionId: ids.node.githubClassify,
    sequence: 1,
    status: "succeeded",
    modelProvider: "provider-x",
    model: "Jev",
    modelParameters: { temperature: 0 },
    providerRequestId: "req-github",
    inputSnapshot: { subject: "[GitHub] Dependabot alert" },
    outputSnapshot: { route: "archive" },
    usageDetails: { input: 820, output: 12 },
    costUsd: "0.000014000000",
    durationMs: 160,
    startedAt: at(10, 2),
    finishedAt: at(10, 3),
  })
  await db.insert(actionExecutions).values({
    id: uuid(3002),
    nodeExecutionId: ids.node.githubArchive,
    sequence: 1,
    connectionId: ids.connection.gmail,
    integrationKey: "gmail",
    actionKey: "archive-message",
    idempotencyKey: "r_github:archive_email:0",
    executionStatus: "succeeded",
    verificationStatus: "verified",
    verifiedByNodeExecutionId: ids.node.githubVerify,
    externalRef: "gmail:m_github",
    requestSnapshot: { providerMessageId: "m_github" },
    responseSnapshot: { ok: true },
    verificationEvidence: { inboxLabelPresent: false },
    startedAt: at(10, 3),
    finishedAt: at(10, 4),
    verifiedAt: at(10, 5),
  })

  // S3: Invoice -> notify -> unverified.
  await insertRun({
    id: ids.run.cloudflare,
    automationId: ids.automation.email,
    automationVersionId: ids.version.emailV7,
    mode: "live",
    status: "succeeded",
    triggerIntegrationKey: "gmail",
    triggerConnectionId: ids.connection.gmail,
    idempotencyKey: "gmail:google-primary:m_cf",
    triggerSnapshot: { providerMessageId: "m_cf" },
    inputSnapshot: { subject: "Invoice #38291" },
    outputSnapshot: { route: "notify" },
    createdAt: at(20),
    startedAt: at(20, 1),
    finishedAt: at(20, 5),
  })
  await db.insert(nodeExecutions).values([
    {
      id: ids.node.cloudflareTrigger,
      runId: ids.run.cloudflare,
      sequence: 1,
      nodeKey: "gmail_event",
      nodeKind: "trigger",
      status: "succeeded",
      inputSnapshot: { providerMessageId: "m_cf" },
      startedAt: at(20, 1),
      finishedAt: at(20, 1),
    },
    {
      id: ids.node.cloudflareClassify,
      runId: ids.run.cloudflare,
      sequence: 2,
      nodeKey: "classify_email",
      nodeKind: "decision",
      status: "succeeded",
      selectedEdgeKey: "notify",
      inputSnapshot: { subject: "Invoice #38291" },
      outputSnapshot: { route: "notify" },
      startedAt: at(20, 2),
      finishedAt: at(20, 3),
    },
    {
      id: ids.node.cloudflareNotify,
      runId: ids.run.cloudflare,
      sequence: 3,
      nodeKey: "notify_user",
      nodeKind: "action",
      status: "succeeded",
      inputSnapshot: { route: "notify" },
      outputSnapshot: { action: "telegram.notify" },
      startedAt: at(20, 3),
      finishedAt: at(20, 4),
    },
    {
      id: ids.node.cloudflareVerify,
      runId: ids.run.cloudflare,
      sequence: 4,
      nodeKey: "verify_delivery",
      nodeKind: "verify",
      status: "succeeded",
      inputSnapshot: { action: "telegram.notify" },
      outputSnapshot: { result: "unverified" },
      startedAt: at(20, 4),
      finishedAt: at(20, 5),
    },
  ])
  await db.insert(modelInvocations).values({
    id: uuid(2003),
    nodeExecutionId: ids.node.cloudflareClassify,
    sequence: 1,
    status: "succeeded",
    modelProvider: "provider-x",
    model: "Jev",
    modelParameters: { temperature: 0 },
    inputSnapshot: { subject: "Invoice #38291" },
    outputSnapshot: { route: "notify" },
    usageDetails: { input: 944, output: 14 },
    costUsd: "0.000018000000",
    durationMs: 170,
    startedAt: at(20, 2),
    finishedAt: at(20, 3),
  })
  await db.insert(actionExecutions).values({
    id: uuid(3003),
    nodeExecutionId: ids.node.cloudflareNotify,
    sequence: 1,
    connectionId: ids.connection.telegram,
    integrationKey: "telegram",
    actionKey: "send-message",
    idempotencyKey: "r_cloudflare:notify_user:0",
    executionStatus: "succeeded",
    verificationStatus: "unverified",
    verifiedByNodeExecutionId: ids.node.cloudflareVerify,
    externalRef: "telegram:823411",
    requestSnapshot: { redacted: true },
    responseSnapshot: { messageId: 823411 },
    verificationEvidence: { reason: "no_independent_delivery_signal" },
    startedAt: at(20, 3),
    finishedAt: at(20, 4),
    verifiedAt: at(20, 5),
  })

  // S4: Newsletter -> archive -> verified.
  await insertRun({
    id: ids.run.newsletter,
    automationId: ids.automation.email,
    automationVersionId: ids.version.emailV7,
    mode: "live",
    status: "succeeded",
    triggerIntegrationKey: "gmail",
    triggerConnectionId: ids.connection.gmail,
    idempotencyKey: "gmail:google-primary:m_news",
    triggerSnapshot: { providerMessageId: "m_news" },
    inputSnapshot: { subject: "Weekly AI Digest" },
    outputSnapshot: { route: "archive" },
    createdAt: at(30),
    startedAt: at(30, 1),
    finishedAt: at(30, 5),
  })
  await db.insert(nodeExecutions).values([
    {
      id: ids.node.newsletterTrigger,
      runId: ids.run.newsletter,
      sequence: 1,
      nodeKey: "gmail_event",
      nodeKind: "trigger",
      status: "succeeded",
      inputSnapshot: { providerMessageId: "m_news" },
      startedAt: at(30, 1),
      finishedAt: at(30, 1),
    },
    {
      id: ids.node.newsletterClassify,
      runId: ids.run.newsletter,
      sequence: 2,
      nodeKey: "classify_email",
      nodeKind: "decision",
      status: "succeeded",
      selectedEdgeKey: "archive",
      inputSnapshot: { subject: "Weekly AI Digest" },
      outputSnapshot: { route: "archive" },
      startedAt: at(30, 2),
      finishedAt: at(30, 3),
    },
    {
      id: ids.node.newsletterArchive,
      runId: ids.run.newsletter,
      sequence: 3,
      nodeKey: "archive_email",
      nodeKind: "action",
      status: "succeeded",
      inputSnapshot: { providerMessageId: "m_news" },
      outputSnapshot: { action: "gmail.archive" },
      startedAt: at(30, 3),
      finishedAt: at(30, 4),
    },
    {
      id: ids.node.newsletterVerify,
      runId: ids.run.newsletter,
      sequence: 4,
      nodeKey: "verify_archive",
      nodeKind: "verify",
      status: "succeeded",
      inputSnapshot: { providerMessageId: "m_news" },
      outputSnapshot: { inboxLabelPresent: false },
      startedAt: at(30, 4),
      finishedAt: at(30, 5),
    },
  ])
  await db.insert(modelInvocations).values({
    id: uuid(2004),
    nodeExecutionId: ids.node.newsletterClassify,
    sequence: 1,
    status: "succeeded",
    modelProvider: "provider-x",
    model: "Jev",
    modelParameters: {},
    inputSnapshot: { subject: "Weekly AI Digest" },
    outputSnapshot: { route: "archive" },
    usageDetails: { input: 760, output: 11 },
    costUsd: "0.000012000000",
    durationMs: 150,
    startedAt: at(30, 2),
    finishedAt: at(30, 3),
  })
  await db.insert(actionExecutions).values({
    id: uuid(3004),
    nodeExecutionId: ids.node.newsletterArchive,
    sequence: 1,
    connectionId: ids.connection.gmail,
    integrationKey: "gmail",
    actionKey: "archive-message",
    idempotencyKey: "r_news:archive_email:0",
    executionStatus: "succeeded",
    verificationStatus: "verified",
    verifiedByNodeExecutionId: ids.node.newsletterVerify,
    externalRef: "gmail:m_news",
    requestSnapshot: { providerMessageId: "m_news" },
    responseSnapshot: { ok: true },
    verificationEvidence: { inboxLabelPresent: false },
    startedAt: at(30, 3),
    finishedAt: at(30, 4),
    verifiedAt: at(30, 5),
  })

  // S5: Personal email -> no_action.
  await insertRun({
    id: ids.run.personal,
    automationId: ids.automation.email,
    automationVersionId: ids.version.emailV7,
    mode: "live",
    status: "succeeded",
    triggerIntegrationKey: "gmail",
    triggerConnectionId: ids.connection.gmail,
    idempotencyKey: "gmail:google-primary:m_personal",
    triggerSnapshot: { providerMessageId: "m_personal" },
    inputSnapshot: { subject: "Lunch next week?" },
    outputSnapshot: { route: "no_action" },
    createdAt: at(40),
    startedAt: at(40, 1),
    finishedAt: at(40, 4),
  })
  await db.insert(nodeExecutions).values([
    {
      id: ids.node.personalTrigger,
      runId: ids.run.personal,
      sequence: 1,
      nodeKey: "gmail_event",
      nodeKind: "trigger",
      status: "succeeded",
      inputSnapshot: { providerMessageId: "m_personal" },
      startedAt: at(40, 1),
      finishedAt: at(40, 1),
    },
    {
      id: ids.node.personalClassify,
      runId: ids.run.personal,
      sequence: 2,
      nodeKey: "classify_email",
      nodeKind: "decision",
      status: "succeeded",
      selectedEdgeKey: "no_action",
      inputSnapshot: { subject: "Lunch next week?" },
      outputSnapshot: { route: "no_action" },
      startedAt: at(40, 2),
      finishedAt: at(40, 3),
    },
    {
      id: ids.node.personalTerminal,
      runId: ids.run.personal,
      sequence: 3,
      nodeKey: "no_action",
      nodeKind: "terminal",
      status: "succeeded",
      inputSnapshot: { route: "no_action" },
      outputSnapshot: { terminal: true },
      startedAt: at(40, 3),
      finishedAt: at(40, 4),
    },
  ])
  await db.insert(modelInvocations).values({
    id: uuid(2005),
    nodeExecutionId: ids.node.personalClassify,
    sequence: 1,
    status: "succeeded",
    modelProvider: "provider-x",
    model: "Jev",
    modelParameters: {},
    inputSnapshot: { subject: "Lunch next week?" },
    outputSnapshot: { route: "no_action" },
    usageDetails: { input: 602, output: 13 },
    costUsd: "0.000009000000",
    durationMs: 140,
    startedAt: at(40, 2),
    finishedAt: at(40, 3),
  })

  // S7: provider outcome unknown after process loss.
  await insertRun({
    id: ids.run.crash,
    automationId: ids.automation.email,
    automationVersionId: ids.version.emailV7,
    mode: "live",
    status: "failed",
    triggerIntegrationKey: "gmail",
    triggerConnectionId: ids.connection.gmail,
    idempotencyKey: "gmail:google-primary:m_crash",
    triggerSnapshot: { providerMessageId: "m_crash" },
    inputSnapshot: { subject: "Important reply" },
    error: { code: "worker_lost" },
    createdAt: at(50),
    startedAt: at(50, 1),
    finishedAt: at(50, 4),
  })
  await db.insert(nodeExecutions).values([
    {
      id: ids.node.crashTrigger,
      runId: ids.run.crash,
      sequence: 1,
      nodeKey: "gmail_event",
      nodeKind: "trigger",
      status: "succeeded",
      inputSnapshot: { providerMessageId: "m_crash" },
      startedAt: at(50, 1),
      finishedAt: at(50, 1),
    },
    {
      id: ids.node.crashClassify,
      runId: ids.run.crash,
      sequence: 2,
      nodeKey: "classify_email",
      nodeKind: "decision",
      status: "succeeded",
      selectedEdgeKey: "notify",
      inputSnapshot: { subject: "Important reply" },
      outputSnapshot: { route: "notify" },
      startedAt: at(50, 2),
      finishedAt: at(50, 3),
    },
    {
      id: ids.node.crashNotify,
      runId: ids.run.crash,
      sequence: 3,
      nodeKey: "notify_user",
      nodeKind: "action",
      status: "failed",
      inputSnapshot: { route: "notify" },
      error: { code: "worker_lost_after_io_boundary" },
      startedAt: at(50, 3),
      finishedAt: at(50, 4),
    },
  ])
  await db.insert(modelInvocations).values({
    id: uuid(2006),
    nodeExecutionId: ids.node.crashClassify,
    sequence: 1,
    status: "succeeded",
    modelProvider: "provider-x",
    model: "Jev",
    modelParameters: {},
    inputSnapshot: { subject: "Important reply" },
    outputSnapshot: { route: "notify" },
    usageDetails: { input: 700, output: 12 },
    startedAt: at(50, 2),
    finishedAt: at(50, 3),
  })
  await db.insert(actionExecutions).values({
    id: uuid(3005),
    nodeExecutionId: ids.node.crashNotify,
    sequence: 1,
    connectionId: ids.connection.telegram,
    integrationKey: "telegram",
    actionKey: "send-message",
    idempotencyKey: "r_crash:notify_user:0",
    executionStatus: "unknown",
    verificationStatus: "pending",
    requestSnapshot: { redacted: true },
    error: { code: "worker_lost_after_io_boundary" },
    startedAt: at(50, 3),
  })

  // S8: provider retry stays inside one NodeExecution; whole-node retry is separate.
  await insertRun({
    id: ids.run.retry,
    automationId: ids.automation.email,
    automationVersionId: ids.version.emailV7,
    mode: "live",
    status: "succeeded",
    triggerIntegrationKey: "gmail",
    triggerConnectionId: ids.connection.gmail,
    idempotencyKey: "gmail:google-primary:m_retry",
    triggerSnapshot: { providerMessageId: "m_retry" },
    inputSnapshot: { subject: "Retry case" },
    outputSnapshot: { route: "archive" },
    createdAt: at(60),
    startedAt: at(60, 1),
    finishedAt: at(60, 8),
  })
  await db.insert(nodeExecutions).values([
    {
      id: ids.node.retryTrigger,
      runId: ids.run.retry,
      sequence: 1,
      nodeKey: "gmail_event",
      nodeKind: "trigger",
      status: "succeeded",
      inputSnapshot: { providerMessageId: "m_retry" },
      startedAt: at(60, 1),
      finishedAt: at(60, 1),
    },
    {
      id: ids.node.retryClassify,
      runId: ids.run.retry,
      sequence: 2,
      nodeKey: "classify_email",
      nodeKind: "decision",
      status: "succeeded",
      selectedEdgeKey: "archive",
      inputSnapshot: { subject: "Retry case" },
      outputSnapshot: { route: "archive" },
      startedAt: at(60, 2),
      finishedAt: at(60, 4),
    },
    {
      id: ids.node.retryArchive,
      runId: ids.run.retry,
      sequence: 3,
      nodeKey: "archive_email",
      nodeKind: "action",
      status: "succeeded",
      inputSnapshot: { providerMessageId: "m_retry" },
      outputSnapshot: { action: "gmail.archive" },
      startedAt: at(60, 4),
      finishedAt: at(60, 5),
    },
    {
      id: ids.node.retryVerifyFailed,
      runId: ids.run.retry,
      sequence: 4,
      nodeKey: "verify_archive",
      nodeKind: "verify",
      status: "failed",
      inputSnapshot: { providerMessageId: "m_retry" },
      error: { code: "temporary_read_failure" },
      startedAt: at(60, 5),
      finishedAt: at(60, 6),
    },
    {
      id: ids.node.retryVerifySucceeded,
      runId: ids.run.retry,
      sequence: 5,
      nodeKey: "verify_archive",
      nodeKind: "verify",
      status: "succeeded",
      retryOfNodeExecutionId: ids.node.retryVerifyFailed,
      inputSnapshot: { providerMessageId: "m_retry" },
      outputSnapshot: { inboxLabelPresent: false },
      startedAt: at(60, 6),
      finishedAt: at(60, 7),
    },
  ])
  await db.insert(modelInvocations).values([
    {
      id: uuid(2007),
      nodeExecutionId: ids.node.retryClassify,
      sequence: 1,
      status: "failed",
      modelProvider: "provider-x",
      model: "Jev",
      modelParameters: {},
      providerRequestId: "req-retry-429",
      inputSnapshot: { subject: "Retry case" },
      error: { httpStatus: 429 },
      durationMs: 83,
      startedAt: at(60, 2),
      finishedAt: at(60, 2, 1),
    },
    {
      id: uuid(2008),
      nodeExecutionId: ids.node.retryClassify,
      sequence: 2,
      status: "succeeded",
      modelProvider: "provider-x",
      model: "Jev",
      modelParameters: {},
      providerRequestId: "req-retry-ok",
      inputSnapshot: { subject: "Retry case" },
      outputSnapshot: { route: "archive" },
      usageDetails: { input: 901, output: 12 },
      costUsd: "0.000015000000",
      durationMs: 190,
      startedAt: at(60, 3),
      finishedAt: at(60, 4),
    },
  ])
  await db.insert(actionExecutions).values({
    id: uuid(3006),
    nodeExecutionId: ids.node.retryArchive,
    sequence: 1,
    connectionId: ids.connection.gmail,
    integrationKey: "gmail",
    actionKey: "archive-message",
    idempotencyKey: "r_retry:archive_email:0",
    executionStatus: "succeeded",
    verificationStatus: "verified",
    verifiedByNodeExecutionId: ids.node.retryVerifySucceeded,
    externalRef: "gmail:m_retry",
    requestSnapshot: { providerMessageId: "m_retry" },
    responseSnapshot: { ok: true },
    verificationEvidence: { inboxLabelPresent: false, attempts: 2 },
    startedAt: at(60, 4),
    finishedAt: at(60, 5),
    verifiedAt: at(60, 7),
  })

  // S9: replay on alternate model; external action suppressed.
  await insertRun({
    id: ids.run.replay,
    automationId: ids.automation.email,
    automationVersionId: ids.version.emailV8,
    mode: "replay",
    status: "succeeded",
    replayOfRunId: ids.run.toss,
    inputSnapshot: { subject: "Open API 문의에 답변드립니다", body: "..." },
    outputSnapshot: { route: "archive" },
    createdAt: at(70),
    startedAt: at(70, 1),
    finishedAt: at(70, 4),
  })
  await db.insert(nodeExecutions).values([
    {
      id: ids.node.replayClassify,
      runId: ids.run.replay,
      sequence: 1,
      nodeKey: "classify_email",
      nodeKind: "decision",
      status: "succeeded",
      selectedEdgeKey: "archive",
      inputSnapshot: { subject: "Open API 문의에 답변드립니다", body: "..." },
      outputSnapshot: { route: "archive" },
      startedAt: at(70, 1),
      finishedAt: at(70, 3),
    },
    {
      id: ids.node.replayActionSkipped,
      runId: ids.run.replay,
      sequence: 2,
      nodeKey: "archive_email",
      nodeKind: "action",
      status: "skipped",
      inputSnapshot: { route: "archive" },
      outputSnapshot: { reason: "replay_side_effect_suppressed" },
      startedAt: at(70, 3),
      finishedAt: at(70, 4),
    },
  ])
  await db.insert(modelInvocations).values({
    id: uuid(2009),
    nodeExecutionId: ids.node.replayClassify,
    sequence: 1,
    status: "succeeded",
    modelProvider: "provider-y",
    model: "AlternativeModel",
    modelParameters: { temperature: 0 },
    inputSnapshot: { subject: "Open API 문의에 답변드립니다", body: "..." },
    outputSnapshot: { route: "archive" },
    usageDetails: { input: 1281, cachedInput: 900, output: 10, reasoning: 31 },
    costDetails: { totalUsd: 0.00003 },
    costUsd: "0.000030000000",
    durationMs: 240,
    startedAt: at(70, 1),
    finishedAt: at(70, 3),
  })

  // S10: human correction is separate from execution evidence.
  await db.insert(nodeFeedback).values({
    id: uuid(4001),
    nodeExecutionId: ids.node.tossClassify,
    verdict: "incorrect",
    expectedOutput: { route: "archive" },
    note: "Useful, but not urgent; archive instead of notify.",
    createdAt: at(80),
    updatedAt: at(80),
  })

  // S11: child Automation is linked to the exact spawning NodeExecution.
  await insertRun({
    id: ids.run.purchaseParent,
    automationId: ids.automation.email,
    automationVersionId: ids.version.emailV9,
    mode: "live",
    status: "succeeded",
    triggerIntegrationKey: "gmail",
    triggerConnectionId: ids.connection.gmail,
    idempotencyKey: "gmail:google-primary:m_purchase",
    triggerSnapshot: { providerMessageId: "m_purchase" },
    inputSnapshot: { subject: "Your receipt" },
    outputSnapshot: { route: "purchase" },
    createdAt: at(90),
    startedAt: at(90, 1),
    finishedAt: at(90, 5),
  })
  await db.insert(nodeExecutions).values([
    {
      id: ids.node.purchaseParentClassify,
      runId: ids.run.purchaseParent,
      sequence: 1,
      nodeKey: "classify_email",
      nodeKind: "decision",
      status: "succeeded",
      selectedEdgeKey: "purchase",
      inputSnapshot: { subject: "Your receipt" },
      outputSnapshot: { route: "purchase" },
      startedAt: at(90, 1),
      finishedAt: at(90, 3),
    },
    {
      id: ids.node.purchaseParentInvoke,
      runId: ids.run.purchaseParent,
      sequence: 2,
      nodeKey: "invoke_purchase_extraction",
      nodeKind: "action",
      status: "succeeded",
      inputSnapshot: { emailRunId: ids.run.purchaseParent },
      outputSnapshot: { childRunId: ids.run.purchaseChild },
      startedAt: at(90, 3),
      finishedAt: at(90, 4),
    },
  ])
  await db.insert(modelInvocations).values({
    id: uuid(2010),
    nodeExecutionId: ids.node.purchaseParentClassify,
    sequence: 1,
    status: "succeeded",
    modelProvider: "provider-x",
    model: "Jev",
    modelParameters: {},
    inputSnapshot: { subject: "Your receipt" },
    outputSnapshot: { route: "purchase" },
    usageDetails: { input: 800, output: 12 },
    costUsd: "0.000014000000",
    durationMs: 180,
    startedAt: at(90, 1),
    finishedAt: at(90, 3),
  })

  await insertRun({
    id: ids.run.purchaseChild,
    automationId: ids.automation.purchase,
    automationVersionId: ids.version.purchaseV1,
    mode: "live",
    status: "succeeded",
    parentNodeExecutionId: ids.node.purchaseParentInvoke,
    idempotencyKey: "child:purchase-parent-invoke:purchase-extraction",
    triggerSnapshot: {
      source: "parent_node_execution",
      parentNodeExecutionId: ids.node.purchaseParentInvoke,
    },
    inputSnapshot: {
      emailRunId: ids.run.purchaseParent,
      subject: "Your receipt",
    },
    outputSnapshot: {
      merchant: "Example Store",
      amount: "20.00",
      currency: "USD",
    },
    createdAt: at(91),
    startedAt: at(91, 1),
    finishedAt: at(91, 5),
  })
  await db.insert(nodeExecutions).values([
    {
      id: ids.node.purchaseInput,
      runId: ids.run.purchaseChild,
      sequence: 1,
      nodeKey: "purchase_input",
      nodeKind: "trigger",
      status: "succeeded",
      inputSnapshot: { emailRunId: ids.run.purchaseParent },
      startedAt: at(91, 1),
      finishedAt: at(91, 1),
    },
    {
      id: ids.node.purchaseExtract,
      runId: ids.run.purchaseChild,
      sequence: 2,
      nodeKey: "extract_purchase",
      nodeKind: "decision",
      status: "succeeded",
      selectedEdgeKey: "success",
      inputSnapshot: { subject: "Your receipt" },
      outputSnapshot: {
        merchant: "Example Store",
        amount: "20.00",
        currency: "USD",
      },
      startedAt: at(91, 2),
      finishedAt: at(91, 4),
    },
    {
      id: ids.node.purchaseWrite,
      runId: ids.run.purchaseChild,
      sequence: 3,
      nodeKey: "write_purchase_fact",
      nodeKind: "action",
      status: "succeeded",
      inputSnapshot: {
        merchant: "Example Store",
        amount: "20.00",
        currency: "USD",
      },
      outputSnapshot: { stored: true },
      startedAt: at(91, 4),
      finishedAt: at(91, 5),
    },
  ])
  await db.insert(modelInvocations).values({
    id: uuid(2011),
    nodeExecutionId: ids.node.purchaseExtract,
    sequence: 1,
    status: "succeeded",
    modelProvider: "provider-x",
    model: "Jev",
    modelParameters: {},
    inputSnapshot: { subject: "Your receipt" },
    outputSnapshot: {
      merchant: "Example Store",
      amount: "20.00",
      currency: "USD",
    },
    usageDetails: { input: 650, output: 30 },
    costUsd: "0.000020000000",
    durationMs: 210,
    startedAt: at(91, 2),
    finishedAt: at(91, 4),
  })

  const counts = {
    automations: (await db.select().from(automations)).length,
    versions: (await db.select().from(automationVersions)).length,
    connections: (await db.select().from(connections)).length,
    interactionChannels: (await db.select().from(interactionChannels)).length,
    runs: (await db.select().from(runs)).length,
    nodes: (await db.select().from(nodeExecutions)).length,
    models: (await db.select().from(modelInvocations)).length,
    actions: (await db.select().from(actionExecutions)).length,
    feedback: (await db.select().from(nodeFeedback)).length,
  }

  assert.deepEqual(counts, {
    automations: 2,
    versions: 4,
    connections: 2,
    interactionChannels: 1,
    runs: 10,
    nodes: 34,
    models: 11,
    actions: 6,
    feedback: 1,
  })
  process.stdout.write(`✓ fixture rows inserted: ${JSON.stringify(counts)}\n`)

  await expectPgError("empty provider key", "23514", () =>
    db.insert(connections).values({
      id: uuid(3801),
      key: "invalid-provider",
      providerKey: "",
      label: "Invalid provider",
      grants: {},
      config: {},
      status: "disabled",
    })
  )

  await expectPgError("grants must be object", "23514", () =>
    db.insert(connections).values({
      id: uuid(3802),
      key: "invalid-grants",
      providerKey: "google",
      label: "Invalid grants",
      grants: [] as never,
      config: {},
      status: "disabled",
    })
  )

  await expectPgError("principal identity is a pair", "23514", () =>
    db.insert(connections).values({
      id: uuid(3803),
      key: "invalid-principal",
      providerKey: "google",
      label: "Invalid principal",
      externalPrincipalType: "account",
      externalPrincipalId: null,
      grants: {},
      config: {},
      status: "disabled",
    })
  )

  const secondGrantId = uuid(3804)
  await db.insert(connections).values({
    id: secondGrantId,
    key: "google-secondary-grant",
    providerKey: "google",
    label: "Second Google grant",
    externalPrincipalType: "account",
    externalPrincipalId: "google-account-stable-id",
    grants: { scopes: ["https://www.googleapis.com/auth/calendar"] },
    config: {},
    status: "disabled",
  })
  await db.delete(connections).where(eq(connections.id, secondGrantId))
  process.stdout.write(
    "✓ same provider principal may own multiple Connection grants\n"
  )

  await expectPgError(
    "trigger integration/connection must be paired",
    "23514",
    () =>
      insertRun({
        id: uuid(3805),
        automationId: ids.automation.email,
        automationVersionId: ids.version.emailV7,
        mode: "test",
        status: "queued",
        triggerIntegrationKey: "gmail",
        inputSnapshot: {},
        createdAt: at(99),
      })
  )

  await expectPgError("action integration key nonempty", "23514", () =>
    db.insert(actionExecutions).values({
      id: uuid(3806),
      nodeExecutionId: ids.node.cloudflareNotify,
      sequence: 4,
      connectionId: ids.connection.telegram,
      integrationKey: "",
      actionKey: "send-message",
      idempotencyKey: "invalid:empty-integration",
      executionStatus: "running",
      verificationStatus: "pending",
      requestSnapshot: {},
      startedAt: at(99, 1),
    })
  )

  await expectPgError("duplicate live trigger", "23505", () =>
    insertRun({
      id: uuid(3901),
      automationId: ids.automation.email,
      automationVersionId: ids.version.emailV7,
      mode: "live",
      status: "queued",
      triggerIntegrationKey: "gmail",
      triggerConnectionId: ids.connection.gmail,
      idempotencyKey: "gmail:google-primary:m_toss",
      inputSnapshot: {},
      createdAt: at(100),
    })
  )

  await expectPgError("automation/version ownership", "23503", () =>
    insertRun({
      id: uuid(3902),
      automationId: ids.automation.email,
      automationVersionId: ids.version.purchaseV1,
      mode: "test",
      status: "queued",
      inputSnapshot: {},
      createdAt: at(101),
    })
  )

  await expectPgError("active version ownership", "23503", () =>
    db
      .update(automations)
      .set({ activeVersionId: ids.version.purchaseV1 })
      .where(eq(automations.id, ids.automation.email))
  )

  await expectPgError("replay requires source run", "23514", () =>
    insertRun({
      id: uuid(3903),
      automationId: ids.automation.email,
      automationVersionId: ids.version.emailV8,
      mode: "replay",
      status: "queued",
      inputSnapshot: {},
      createdAt: at(102),
    })
  )

  await expectPgError("retry must target same run/node", "23503", () =>
    insertNode({
      id: uuid(3904),
      runId: ids.run.retry,
      sequence: 6,
      nodeKey: "notify_user",
      nodeKind: "action",
      status: "running",
      retryOfNodeExecutionId: ids.node.retryVerifyFailed,
      inputSnapshot: {},
      startedAt: at(103),
    })
  )

  await expectPgError("duplicate external action idempotency", "23505", () =>
    db.insert(actionExecutions).values({
      id: uuid(3905),
      nodeExecutionId: ids.node.cloudflareNotify,
      sequence: 2,
      connectionId: ids.connection.telegram,
      integrationKey: "telegram",
      actionKey: "send-message",
      idempotencyKey: "r_toss:notify_user:0",
      executionStatus: "running",
      verificationStatus: "pending",
      requestSnapshot: {},
      startedAt: at(104),
    })
  )

  await expectPgError("verification timestamp state check", "23514", () =>
    db.insert(actionExecutions).values({
      id: uuid(3906),
      nodeExecutionId: ids.node.cloudflareNotify,
      sequence: 3,
      connectionId: ids.connection.telegram,
      integrationKey: "telegram",
      actionKey: "send-message",
      idempotencyKey: "invalid:verification:timestamp",
      executionStatus: "succeeded",
      verificationStatus: "pending",
      requestSnapshot: {},
      startedAt: at(105),
      finishedAt: at(105, 1),
      verifiedAt: at(105, 2),
    })
  )

  await expectPgError("one current feedback per node", "23505", () =>
    db.insert(nodeFeedback).values({
      id: uuid(3907),
      nodeExecutionId: ids.node.tossClassify,
      verdict: "correct",
      createdAt: at(106),
      updatedAt: at(106),
    })
  )

  await expectPgError("connection delete is restricted", "23503", () =>
    db.delete(connections).where(eq(connections.id, ids.connection.gmail))
  )

  await expectPgError("version delete is restricted", "23503", () =>
    db
      .delete(automationVersions)
      .where(eq(automationVersions.id, ids.version.emailV7))
  )

  process.stdout.write("✓ all schema constraint probes passed\n")
}

try {
  await main()
} finally {
  await client.end()
}

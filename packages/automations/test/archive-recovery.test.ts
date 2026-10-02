import assert from "node:assert/strict"
import test from "node:test"
import type {
  ArchiveRecoveryPolicy,
  ArchiveRecoveryRecord,
  AutomationGraphDefinition,
  JsonObject,
} from "@workspace/domain/persistence"
import {
  ArchiveProviderError,
  archiveFailure,
  archiveRetryAt,
  assertRecoverableArchiveBranch,
  decideArchiveRead,
  defaultArchiveRecoveryPolicy,
  processArchiveRecovery,
  validateArchiveRecoveryPolicy,
  type ArchiveMessageObservation,
  type ArchiveRecoveryMailPort,
  type ArchiveRecoveryStore,
} from "../src/email-triage/archive-recovery"
import { emailTriageDefinition } from "../src/email-triage/definition"

const epoch = new Date("2026-10-01T00:00:00.000Z")
const time = (ms = 0) => new Date(epoch.getTime() + ms)

function recovery(
  overrides: Partial<ArchiveRecoveryRecord> = {}
): ArchiveRecoveryRecord {
  return {
    actionExecutionId: "action-original",
    messageId: "message-original",
    initialRevision: "opaque:rev-A",
    state: "pending",
    nextOperation: "modify",
    nextAttemptAt: time(),
    writeNotBeforeAt: null,
    deadlineAt: time(60_000),
    policy: { ...defaultArchiveRecoveryPolicy },
    writeAttempts: 0,
    readAttempts: 0,
    inFlightOperation: null,
    inFlightAttempt: null,
    writeRetryAllowed: true,
    lastWriteOutcome: null,
    lastOutcome: null,
    createdAt: time(),
    updatedAt: time(),
    ...overrides,
  }
}

function observation(
  overrides: Partial<ArchiveMessageObservation> = {}
): ArchiveMessageObservation {
  return {
    messageId: "message-original",
    inInbox: true,
    revision: "opaque:rev-A",
    ...overrides,
  }
}

function graphNode(graph: AutomationGraphDefinition, key: string) {
  const node = graph.nodes.find((candidate) => candidate.key === key)
  assert(node)
  return node
}

test("the stored Email Triage graph has exactly the supported terminal archive continuation", () => {
  const stored = JSON.parse(
    JSON.stringify(emailTriageDefinition)
  ) as AutomationGraphDefinition
  assert.deepEqual(
    stored.edges.filter((edge) => edge.source === "archive_email"),
    [
      {
        key: "archive_verify",
        source: "archive_email",
        target: "verify_archive",
      },
    ]
  )
  assert.deepEqual(
    stored.edges.filter((edge) => edge.source === "verify_archive"),
    []
  )
  assert.doesNotThrow(() => assertRecoverableArchiveBranch(stored))
})

const unsupportedBranches: Array<
  [string, (graph: AutomationGraphDefinition) => void]
> = [
  [
    "missing archive",
    (graph) => {
      graph.nodes = graph.nodes.filter((node) => node.key !== "archive_email")
    },
  ],
  [
    "missing verification",
    (graph) => {
      graph.nodes = graph.nodes.filter((node) => node.key !== "verify_archive")
    },
  ],
  [
    "archive kind",
    (graph) => {
      graphNode(graph, "archive_email").kind = "terminal"
    },
  ],
  [
    "archive integration",
    (graph) => {
      graphNode(graph, "archive_email").config.integrationKey = "other-mail"
    },
  ],
  [
    "archive action",
    (graph) => {
      graphNode(graph, "archive_email").config.actionKey = "report-spam"
    },
  ],
  [
    "archive connection",
    (graph) => {
      graphNode(graph, "archive_email").config.connectionKey = "other-account"
    },
  ],
  [
    "verification kind",
    (graph) => {
      graphNode(graph, "verify_archive").kind = "action"
    },
  ],
  [
    "verification operation",
    (graph) => {
      graphNode(graph, "verify_archive").config.verificationKey = "message-spam"
    },
  ],
  [
    "verification integration",
    (graph) => {
      graphNode(graph, "verify_archive").config.integrationKey = "other-mail"
    },
  ],
  [
    "verification connection",
    (graph) => {
      graphNode(graph, "verify_archive").config.connectionKey = "other-account"
    },
  ],
  [
    "missing archive edge",
    (graph) => {
      graph.edges = graph.edges.filter(
        (edge) => edge.source !== "archive_email"
      )
    },
  ],
  [
    "renamed archive edge",
    (graph) => {
      graph.edges.find((edge) => edge.key === "archive_verify")!.key = "other"
    },
  ],
  [
    "wrong archive target",
    (graph) => {
      graph.edges.find((edge) => edge.key === "archive_verify")!.target =
        "verify_spam"
    },
  ],
  [
    "extra archive branch",
    (graph) => {
      graph.edges.push({
        key: "extra",
        source: "archive_email",
        target: "notify_user",
      })
    },
  ],
  [
    "nonterminal verification",
    (graph) => {
      graph.edges.push({
        key: "extra",
        source: "verify_archive",
        target: "notify_user",
      })
    },
  ],
]
for (const [name, mutate] of unsupportedBranches) {
  test(`recovery rejects stored branch drift: ${name}`, () => {
    const graph = structuredClone(emailTriageDefinition)
    mutate(graph)
    assert.throws(
      () => assertRecoverableArchiveBranch(graph),
      /supported terminal archive continuation|recovery (archive|verify) binding requires/
    )
  })
}

test("recovery defaults are the reviewed bounded fake-world policy", () => {
  assert.deepEqual(defaultArchiveRecoveryPolicy, {
    maxWrites: 3,
    maxReads: 6,
    deadlineMs: 60_000,
    baseDelayMs: 1_000,
    maxDelayMs: 8_000,
  })
  assert.deepEqual(
    validateArchiveRecoveryPolicy({ ...defaultArchiveRecoveryPolicy }),
    defaultArchiveRecoveryPolicy
  )
})

for (const field of Object.keys(defaultArchiveRecoveryPolicy) as Array<
  keyof ArchiveRecoveryPolicy
>) {
  for (const value of [
    0,
    -1,
    1.5,
    Infinity,
    NaN,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    test(`policy rejects ${field}=${String(value)}`, () => {
      assert.throws(
        () =>
          validateArchiveRecoveryPolicy({
            ...defaultArchiveRecoveryPolicy,
            [field]: value,
          }),
        /Invalid archive recovery policy/
      )
    })
  }
}

for (const override of [
  { maxWrites: 11 },
  { maxReads: 21 },
  { deadlineMs: 300_001 },
  { baseDelayMs: 8_001 },
]) {
  test(`policy rejects out-of-bounds override ${JSON.stringify(override)}`, () => {
    assert.throws(
      () =>
        validateArchiveRecoveryPolicy({
          ...defaultArchiveRecoveryPolicy,
          ...override,
        }),
      /bounded limits/
    )
  })
}

test("policy accepts inclusive maximum budgets and deadline", () => {
  assert.doesNotThrow(() =>
    validateArchiveRecoveryPolicy({
      maxWrites: 10,
      maxReads: 20,
      deadlineMs: 300_000,
      baseDelayMs: 8_000,
      maxDelayMs: 8_000,
    })
  )
})

const failures: Array<[number | null, string, boolean]> = [
  [400, "badRequest", false],
  [401, "authError", false],
  [403, "domainPolicy", false],
  [403, "insufficientPermissions", false],
  [403, "forbidden", false],
  [403, "rateLimitExceeded", true],
  [403, "userRateLimitExceeded", true],
  [404, "notFound", false],
  [429, "tooManyRequests", true],
  [500, "backendError", true],
  [502, "badGateway", true],
  [503, "unavailable", true],
  [504, "gatewayTimeout", true],
  [null, "timeout", true],
]
for (const [status, reason, retryable] of failures) {
  test(`classifies provider ${String(status)} ${reason} without inventing certainty`, () => {
    assert.deepEqual(
      archiveFailure(
        new ArchiveProviderError(
          "provider detail",
          status,
          reason,
          "none",
          9_000
        )
      ),
      {
        code: reason,
        message: "provider detail",
        status,
        effect: "none",
        retryable,
        retryAfterMs: 9_000,
      }
    )
    assert.equal(
      archiveFailure(
        new ArchiveProviderError("provider detail", status, reason)
      ).effect,
      "unknown"
    )
  })
}

test("unclassified adapter errors fail closed while retaining unknown effect", () => {
  for (const error of [new Error("untyped failure"), "untyped failure"]) {
    assert.deepEqual(archiveFailure(error), {
      code: "adapter_failure",
      message: "untyped failure",
      effect: "unknown",
      retryable: false,
    })
  }
})

test("negative provider Retry-After is clamped to zero and omitted when absent", () => {
  assert.equal(
    archiveFailure(
      new ArchiveProviderError("rate limit", 429, "rate", "none", -5)
    ).retryAfterMs,
    0
  )
  assert.equal(
    Object.hasOwn(
      archiveFailure(new ArchiveProviderError("rate limit", 429, "rate")),
      "retryAfterMs"
    ),
    false
  )
})

test("retry delay starts at one second and exponentially caps before bounded jitter", () => {
  for (const [attempts, expected] of [
    [0, 1_000],
    [1, 1_000],
    [2, 2_000],
    [3, 4_000],
    [4, 8_000],
    [10, 8_000],
    [100, 8_000],
  ]) {
    const record = recovery({ writeAttempts: attempts })
    assert.equal(
      archiveRetryAt(record, time(), () => 0).getTime(),
      time(expected).getTime()
    )
    assert.equal(
      archiveRetryAt(record, time(), () => 1).getTime(),
      time(expected * 1.25).getTime()
    )
  }
  assert.equal(
    archiveRetryAt(
      recovery({ writeAttempts: 1, readAttempts: 2 }),
      time(),
      () => 0
    ).getTime(),
    time(4_000).getTime()
  )
})

test("jitter is bounded, deterministic under a controlled random source, and floors fractions", () => {
  const record = recovery({ writeAttempts: 1 })
  for (const [random, delay] of [
    [-1, 1_000],
    [0, 1_000],
    [0.501, 1_125],
    [1, 1_250],
    [2, 1_250],
  ]) {
    assert.equal(
      archiveRetryAt(record, time(), () => random).getTime(),
      time(delay).getTime()
    )
  }
})

test("provider Retry-After is a minimum and may exceed the exponential cap", () => {
  const record = recovery({ writeAttempts: 10 })
  assert.equal(
    archiveRetryAt(record, time(), () => 1, 500).getTime(),
    time(10_000).getTime()
  )
  assert.equal(
    archiveRetryAt(record, time(), () => 1, 30_000).getTime(),
    time(30_000).getTime()
  )
})

test("wrong message identity fails closed even when the other message is absent from INBOX", () => {
  assert.deepEqual(
    decideArchiveRead(
      recovery(),
      observation({
        messageId: "message-other",
        inInbox: false,
      }),
      time()
    ),
    {
      kind: "finish",
      state: "stopped",
      evidence: { code: "invalid_message_observation" },
    }
  )
})

test("malformed boolean and empty opaque revision are not observations", () => {
  for (const observed of [
    observation({ revision: "" }),
    {
      ...observation(),
      inInbox: "false",
    } as unknown as ArchiveMessageObservation,
  ]) {
    assert.deepEqual(decideArchiveRead(recovery(), observed, time()), {
      kind: "finish",
      state: "stopped",
      evidence: { code: "invalid_message_observation" },
    })
  }
})

for (const outcome of ["unknown", "failed", "acknowledged", null] as const) {
  test(`INBOX absence records desired state without causal proof after ${String(outcome)}`, () => {
    const observed = observation({ inInbox: false, revision: "opaque:rev-B" })
    assert.deepEqual(
      decideArchiveRead(
        recovery({ lastWriteOutcome: outcome }),
        observed,
        time()
      ),
      {
        kind: "finish",
        state: "observed",
        evidence: {
          code: "desired_state_observed",
          ...observed,
          causality: "not_established",
        },
      }
    )
  })
}

test("any changed opaque revision stops old intent without attempting to order revisions", () => {
  for (const revision of [
    "opaque:rev-B",
    "0",
    "900719925474099312345",
    "older-looking-rev",
  ]) {
    const observed = observation({ revision })
    assert.deepEqual(
      decideArchiveRead(
        recovery({ writeAttempts: 1, lastWriteOutcome: "unknown" }),
        observed,
        time()
      ),
      {
        kind: "finish",
        state: "stopped",
        evidence: { code: "intent_superseded", ...observed },
      }
    )
  }
})

test("acknowledged modify with INBOX still present is verification mismatch, never another write", () => {
  const observed = observation()
  assert.deepEqual(
    decideArchiveRead(
      recovery({ writeAttempts: 1, lastWriteOutcome: "acknowledged" }),
      observed,
      time()
    ),
    {
      kind: "finish",
      state: "stopped",
      evidence: { code: "verification_mismatch", ...observed },
    }
  )
})

test("unchanged original intent retries only before the exact deadline and below write budget", () => {
  const record = recovery({ writeAttempts: 2, lastWriteOutcome: "unknown" })
  assert.deepEqual(decideArchiveRead(record, observation(), time(59_999)), {
    kind: "schedule",
    operation: "modify",
    at: time(59_999),
    evidence: { code: "unchanged_intent_observed", ...observation() },
  })
  for (const now of [time(60_000), time(60_001)]) {
    const decision = decideArchiveRead(record, observation(), now)
    assert.equal(decision.kind, "finish")
    assert.equal(decision.evidence.code, "intent_deadline_exceeded")
  }
  for (const writeAttempts of [3, 4]) {
    const decision = decideArchiveRead(
      recovery({ writeAttempts }),
      observation(),
      time()
    )
    assert.equal(decision.kind, "finish")
    assert.equal(decision.evidence.code, "write_budget_exhausted")
  }
})

// Pure in-memory port: no database, process, real time, or live provider.
// Each operation returns a snapshot so tests do not depend on shared references.
class MemoryStore implements ArchiveRecoveryStore {
  intentCurrent = true
  async isIntentCurrent() {
    return this.intentCurrent
  }
  readonly events: Array<{
    type: string
    operation?: "modify" | "get"
    evidence?: JsonObject
  }> = []
  constructor(public record: ArchiveRecoveryRecord = recovery()) {}
  async read() {
    return structuredClone(this.record)
  }
  async interrupted(now: Date) {
    this.events.push({
      type: "interrupted",
      operation: this.record.inFlightOperation ?? undefined,
    })
    if (this.record.inFlightOperation === "modify")
      this.record.lastWriteOutcome = "unknown"
    Object.assign(this.record, {
      inFlightOperation: null,
      inFlightAttempt: null,
      nextOperation: "get",
      nextAttemptAt: now,
      updatedAt: now,
    })
  }
  async reconcileBeforeRetry(now: Date) {
    this.events.push({ type: "reconcile" })
    Object.assign(this.record, {
      nextOperation: "get",
      nextAttemptAt: now,
      updatedAt: now,
    })
  }
  async start(operation: "modify" | "get", now: Date) {
    this.events.push({ type: "started", operation })
    const attempt =
      operation === "modify"
        ? ++this.record.writeAttempts
        : ++this.record.readAttempts
    Object.assign(this.record, {
      inFlightOperation: operation,
      inFlightAttempt: attempt,
      updatedAt: now,
    })
    return this.read()
  }
  async result(input: Parameters<ArchiveRecoveryStore["result"]>[0]) {
    this.events.push({
      type: "result",
      operation: input.operation,
      evidence: input.evidence,
    })
    Object.assign(this.record, {
      inFlightOperation: null,
      inFlightAttempt: null,
      nextOperation: input.nextOperation,
      nextAttemptAt: input.nextAttemptAt,
      lastOutcome: {
        ...input.evidence,
        ...(input.terminal ? { terminalDecision: input.terminal } : {}),
      },
      updatedAt: input.now,
      ...(input.writeNotBeforeAt === undefined
        ? {}
        : { writeNotBeforeAt: input.writeNotBeforeAt }),
      ...(input.writeRetryAllowed === undefined
        ? {}
        : { writeRetryAllowed: input.writeRetryAllowed }),
      ...(input.writeOutcome ? { lastWriteOutcome: input.writeOutcome } : {}),
    })
  }
  async finish(state: "observed" | "stopped", evidence: JsonObject, now: Date) {
    this.events.push({ type: "finish", evidence })
    Object.assign(this.record, {
      state,
      nextAttemptAt: null,
      lastOutcome: evidence,
      updatedAt: now,
    })
  }
}

function harness(record = recovery()) {
  const store = new MemoryStore(record)
  const calls: string[] = []
  let current = time()
  let modify: ArchiveRecoveryMailPort["modify"] = async () => ({
    accepted: true,
  })
  let get: ArchiveRecoveryMailPort["get"] = async () =>
    observation({ inInbox: false })
  const mail: ArchiveRecoveryMailPort = {
    async modify(messageId) {
      calls.push(`modify:${messageId}`)
      assert.equal(
        store.record.inFlightOperation,
        "modify",
        "dispatch must be persisted first"
      )
      return modify(messageId)
    },
    async get(messageId) {
      calls.push(`get:${messageId}`)
      assert.equal(
        store.record.inFlightOperation,
        "get",
        "dispatch must be persisted first"
      )
      return get(messageId)
    },
  }
  return {
    store,
    calls,
    setTime(ms: number) {
      current = time(ms)
    },
    setModify(next: ArchiveRecoveryMailPort["modify"]) {
      modify = next
    },
    setGet(next: ArchiveRecoveryMailPort["get"]) {
      get = next
    },
    run(
      hooks: Pick<
        Parameters<typeof processArchiveRecovery>[0],
        "afterResult"
      > = {}
    ) {
      return processArchiveRecovery({
        store,
        mail,
        now: () => current,
        random: () => 0,
        ...hooks,
      })
    },
  }
}

test("first acknowledged modify verifies the same message and never replays after completion", async () => {
  const h = harness()
  await h.run()
  assert.deepEqual(h.calls, ["modify:message-original", "get:message-original"])
  assert.equal(h.store.record.state, "observed")
  assert.equal(h.store.record.lastWriteOutcome, "acknowledged")
  assert.equal(h.store.record.lastOutcome?.causality, "not_established")
  h.setGet(async () => observation({ revision: "re-added-later" }))
  await h.run()
  assert.equal(h.calls.length, 2)
})

test("timeout after possible effect immediately reads back without a blind write", async () => {
  const h = harness()
  h.setModify(async () => {
    throw new ArchiveProviderError("timed out", null, "timeout")
  })
  await h.run()
  assert.deepEqual(h.calls, ["modify:message-original", "get:message-original"])
  assert.equal(h.store.record.state, "observed")
  assert.equal(h.store.record.lastWriteOutcome, "unknown")
  assert.equal(h.store.record.lastOutcome?.code, "desired_state_observed")
  assert.equal(h.store.record.lastOutcome?.causality, "not_established")
})

test("failed read preserves write uncertainty and resumes only another bounded GET", async () => {
  const h = harness()
  h.setModify(async () => {
    throw new ArchiveProviderError("timed out", null, "timeout")
  })
  h.setGet(async () => {
    throw new ArchiveProviderError(
      "read unavailable",
      503,
      "unavailable",
      "none",
      7_000
    )
  })
  await h.run()
  assert.equal(h.store.record.state, "pending")
  assert.equal(h.store.record.lastWriteOutcome, "unknown")
  assert.equal(h.store.record.nextOperation, "get")
  assert.equal(h.store.record.nextAttemptAt?.getTime(), time(7_000).getTime())
  await h.run()
  assert.equal(h.calls.length, 2)
  h.setTime(7_000)
  h.setGet(async () => observation({ inInbox: false }))
  await h.run()
  assert.deepEqual(h.calls, [
    "modify:message-original",
    "get:message-original",
    "get:message-original",
  ])
  assert.equal(h.store.record.writeAttempts, 1)
  assert.equal(h.store.record.readAttempts, 2)
  assert.equal(h.store.record.lastWriteOutcome, "unknown")
  assert.equal(h.store.record.state, "observed")
})

test("transient known-no-effect modify waits for Retry-After and reads before retrying", async () => {
  const h = harness()
  let writes = 0
  h.setModify(async () => {
    if (++writes === 1)
      throw new ArchiveProviderError(
        "rate limited",
        429,
        "rateLimitExceeded",
        "none",
        5_000
      )
    return { accepted: true }
  })
  h.setGet(async () => observation({ inInbox: writes < 2 }))
  await h.run()
  assert.deepEqual(h.calls, ["modify:message-original"])
  assert.equal(h.store.record.nextOperation, "get")
  assert.equal(h.store.record.nextAttemptAt?.getTime(), time(5_000).getTime())
  h.setTime(4_999)
  await h.run()
  assert.equal(h.calls.length, 1)
  h.setTime(5_000)
  await h.run()
  assert.deepEqual(h.calls, ["modify:message-original", "get:message-original"])
  const due = h.store.record.nextAttemptAt
  assert(due)
  h.setTime(due.getTime() - epoch.getTime())
  await h.run()
  assert.deepEqual(h.calls, [
    "modify:message-original",
    "get:message-original",
    "get:message-original",
    "modify:message-original",
    "get:message-original",
  ])
  assert.equal(h.store.record.state, "observed")
})

test("due modify retry reconciles afresh and stops if opaque revision changed during backoff", async () => {
  const h = harness(
    recovery({
      nextOperation: "modify",
      writeAttempts: 1,
      readAttempts: 1,
      lastWriteOutcome: "unknown",
    })
  )
  h.setGet(async () => observation({ revision: "opaque:newer-state" }))
  await h.run()
  assert.deepEqual(h.calls, ["get:message-original"])
  assert.equal(h.store.record.state, "stopped")
  assert.equal(h.store.record.lastOutcome?.code, "intent_superseded")
  assert.equal(h.store.record.writeAttempts, 1)
})

for (const [status, reason] of [
  [400, "badRequest"],
  [401, "authError"],
  [403, "domainPolicy"],
] as const) {
  test(`permanent ${status} known-no-effect modify stops without read or retry`, async () => {
    const h = harness()
    h.setModify(async () => {
      throw new ArchiveProviderError("permanent", status, reason, "none")
    })
    await h.run()
    assert.deepEqual(h.calls, ["modify:message-original"])
    assert.equal(h.store.record.state, "stopped")
    assert.equal(h.store.record.lastWriteOutcome, "failed")
    assert.equal(h.store.record.lastOutcome?.code, "permanent_failure")
  })
}

test("permanent read failure never permits another modify", async () => {
  const h = harness(
    recovery({
      nextOperation: "get",
      writeAttempts: 1,
      lastWriteOutcome: "unknown",
    })
  )
  h.setGet(async () => {
    throw new ArchiveProviderError("unauthorized", 401, "authError", "none")
  })
  await h.run()
  assert.deepEqual(h.calls, ["get:message-original"])
  assert.equal(h.store.record.state, "stopped")
  assert.equal(h.store.record.lastWriteOutcome, "unknown")
  assert.equal(h.store.record.lastOutcome?.code, "read_failed_permanently")
})

test("acknowledged write with INBOX present ends as mismatch and is never retried", async () => {
  const h = harness()
  h.setGet(async () => observation())
  await h.run()
  assert.deepEqual(h.calls, ["modify:message-original", "get:message-original"])
  assert.equal(h.store.record.state, "stopped")
  assert.equal(h.store.record.lastOutcome?.code, "verification_mismatch")
})

test("wrong message readback is not proof for the fixed target", async () => {
  const h = harness()
  h.setGet(async () => observation({ messageId: "other", inInbox: false }))
  await h.run()
  assert.equal(h.store.record.state, "stopped")
  assert.equal(h.store.record.lastOutcome?.code, "invalid_message_observation")
})

for (const operation of ["modify", "get"] as const) {
  test(`exact ${operation} budget boundary stops before dispatch`, async () => {
    const h = harness(
      recovery({
        nextOperation: operation,
        writeAttempts: 3,
        readAttempts: 6,
        lastWriteOutcome: "unknown",
      })
    )
    await h.run()
    assert.deepEqual(h.calls, [])
    assert.equal(
      h.store.record.lastOutcome?.code,
      operation === "modify"
        ? "write_budget_exhausted"
        : "read_budget_exhausted"
    )
    assert.equal(h.store.record.state, "stopped")
  })
  test(`exact deadline prevents ${operation} dispatch`, async () => {
    const h = harness(recovery({ nextOperation: operation }))
    h.setTime(60_000)
    await h.run()
    assert.deepEqual(h.calls, [])
    assert.equal(h.store.record.lastOutcome?.code, "intent_deadline_exceeded")
  })
}

test("last available read is allowed and cannot lead to an unbounded next read", async () => {
  const h = harness(
    recovery({
      nextOperation: "get",
      writeAttempts: 1,
      readAttempts: 5,
      lastWriteOutcome: "unknown",
    })
  )
  h.setGet(async () => {
    throw new ArchiveProviderError("unavailable", 503, "unavailable", "none")
  })
  await h.run()
  assert.equal(h.store.record.readAttempts, 6)
  const due = h.store.record.nextAttemptAt
  assert(due)
  h.setTime(due.getTime() - epoch.getTime())
  await h.run()
  assert.deepEqual(h.calls, ["get:message-original"])
  assert.equal(h.store.record.lastOutcome?.code, "read_budget_exhausted")
})

test("before-deadline read cannot schedule a write after the clock reaches the deadline", async () => {
  const h = harness(
    recovery({
      nextOperation: "get",
      writeAttempts: 1,
      lastWriteOutcome: "unknown",
    })
  )
  h.setTime(59_999)
  h.setGet(async () => {
    h.setTime(60_000)
    return observation()
  })
  await h.run()
  assert.deepEqual(h.calls, ["get:message-original"])
  assert.equal(h.store.record.state, "stopped")
  assert.equal(h.store.record.lastOutcome?.code, "intent_deadline_exceeded")
})

for (const operation of ["modify", "get"] as const) {
  test(`interrupted ${operation} counts its persisted start and reconciles only the fixed message`, async () => {
    const h = harness(
      recovery({
        writeAttempts: 1,
        readAttempts: operation === "get" ? 1 : 0,
        inFlightOperation: operation,
        inFlightAttempt: 1,
        lastWriteOutcome: operation === "get" ? "unknown" : null,
      })
    )
    await h.run()
    assert.equal(h.store.events[0].type, "interrupted")
    assert.deepEqual(h.calls, ["get:message-original"])
    assert.equal(h.store.record.writeAttempts, 1)
    assert.equal(h.store.record.readAttempts, operation === "get" ? 2 : 1)
    assert.equal(h.store.record.lastWriteOutcome, "unknown")
    assert.equal(h.store.record.state, "observed")
  })
}

for (const state of ["observed", "stopped"] as const) {
  test(`terminal ${state} recovery is an immutable no-op`, async () => {
    const h = harness(recovery({ state, inFlightOperation: "modify" }))
    const before = structuredClone(h.store.record)
    await h.run()
    assert.deepEqual(h.store.record, before)
    assert.deepEqual(h.store.events, [])
    assert.deepEqual(h.calls, [])
  })
}

for (const error of [
  new ArchiveProviderError(
    "bad request with uncertain effect",
    400,
    "badRequest"
  ),
  new ArchiveProviderError(
    "unauthorized with uncertain effect",
    401,
    "authError"
  ),
  new ArchiveProviderError(
    "domain policy with uncertain effect",
    403,
    "domainPolicy"
  ),
  new Error("unclassified adapter error"),
]) {
  test(`nonretryable uncertain write reconciles once and stops on unchanged INBOX: ${error.message}`, async () => {
    const h = harness()
    h.setModify(async () => {
      throw error
    })
    h.setGet(async () => observation())
    await h.run()
    assert.deepEqual(h.calls, [
      "modify:message-original",
      "get:message-original",
    ])
    assert.equal(h.store.record.state, "stopped")
    assert.equal(h.store.record.lastWriteOutcome, "unknown")
    assert.equal(h.store.record.writeRetryAllowed, false)
    assert.equal(h.store.record.lastOutcome?.code, "write_retry_forbidden")
  })
}

test("a read failure cannot erase a persisted ban on retrying a permanent uncertain write", async () => {
  const h = harness()
  h.setModify(async () => {
    throw new ArchiveProviderError("unauthorized", 401, "authError")
  })
  h.setGet(async () => {
    throw new ArchiveProviderError(
      "read unavailable",
      503,
      "unavailable",
      "none"
    )
  })
  await h.run()
  assert.equal(h.store.record.writeRetryAllowed, false)
  assert.equal(h.store.record.state, "pending")
  const due = h.store.record.nextAttemptAt
  assert(due)
  h.setTime(due.getTime() - epoch.getTime())
  h.setGet(async () => observation())
  await h.run()
  assert.deepEqual(h.calls, [
    "modify:message-original",
    "get:message-original",
    "get:message-original",
  ])
  assert.equal(h.store.record.writeRetryAllowed, false)
  assert.equal(h.store.record.state, "stopped")
  assert.equal(h.store.record.lastOutcome?.code, "write_retry_forbidden")
})

test("INBOX absence can be observed after a nonretryable unknown write without claiming causal success", async () => {
  const h = harness()
  h.setModify(async () => {
    throw new ArchiveProviderError(
      "uncertain unauthorized response",
      401,
      "authError"
    )
  })
  await h.run()
  assert.equal(h.store.record.state, "observed")
  assert.equal(h.store.record.lastWriteOutcome, "unknown")
  assert.equal(h.store.record.writeRetryAllowed, false)
  assert.equal(h.store.record.lastOutcome?.causality, "not_established")
})

for (const phase of ["before", "after"] as const) {
  test(`a ${phase}-dispatch interruption escapes provider handling with its start still in flight`, async () => {
    const store = new MemoryStore()
    let writes = 0
    const stop = new Error("simulated interruption")
    await assert.rejects(
      processArchiveRecovery({
        store,
        now: () => time(),
        random: () => 0,
        mail: {
          async modify() {
            writes++
            return { accepted: true }
          },
          async get() {
            assert.fail("must not continue after interruption")
          },
        },
        ...(phase === "before"
          ? {
              beforeDispatch: async () => {
                throw stop
              },
            }
          : {
              afterDispatch: async () => {
                throw stop
              },
            }),
      }),
      (error) => error === stop
    )
    assert.equal(writes, phase === "before" ? 0 : 1)
    assert.equal(store.record.writeAttempts, 1)
    assert.equal(store.record.inFlightOperation, "modify")
    assert.equal(store.record.inFlightAttempt, 1)
    assert.equal(store.record.lastWriteOutcome, null)
    assert.deepEqual(store.events, [{ type: "started", operation: "modify" }])
  })
}

test("intent terminalizes at its exact deadline even when provider backoff is due later", async () => {
  const h = harness(
    recovery({
      nextOperation: "get",
      nextAttemptAt: time(120_000),
      writeAttempts: 1,
      lastWriteOutcome: "unknown",
    })
  )
  h.setTime(59_999)
  await h.run()
  assert.equal(h.store.record.state, "pending")
  assert.deepEqual(h.calls, [])
  h.setTime(60_000)
  await h.run()
  assert.deepEqual(h.calls, [])
  assert.equal(h.store.record.state, "stopped")
  assert.equal(h.store.record.lastOutcome?.code, "intent_deadline_exceeded")
})

test("original modify Retry-After survives an intervening failed GET before any retry", async () => {
  const h = harness()
  let writes = 0
  let reads = 0
  h.setModify(async () => {
    if (++writes === 1)
      throw new ArchiveProviderError(
        "rate-limited unknown effect",
        429,
        "rateLimitExceeded",
        "unknown",
        30_000
      )
    return { accepted: true }
  })
  h.setGet(async () => {
    if (++reads === 1)
      throw new ArchiveProviderError(
        "read unavailable",
        503,
        "unavailable",
        "none"
      )
    return observation({ inInbox: writes < 2 })
  })
  await h.run()
  assert.equal(writes, 1)
  for (let check = 0; check < 10; check++) {
    const due = h.store.record.nextAttemptAt
    assert(due, "recovery should remain pending before the write minimum")
    const offset = due.getTime() - epoch.getTime()
    if (offset >= 30_000) break
    h.setTime(offset)
    await h.run()
    assert.equal(
      writes,
      1,
      "a failed GET must not erase the original provider minimum"
    )
  }
  const due = h.store.record.nextAttemptAt
  assert(due)
  assert(
    due >= time(30_000),
    "the retry remains scheduled no earlier than provider Retry-After"
  )
})

test("cancellation while the retry validation GET is outstanding prevents the next modify", async () => {
  const h = harness(
    recovery({
      nextOperation: "modify",
      writeAttempts: 1,
      readAttempts: 1,
      lastWriteOutcome: "unknown",
    })
  )
  let readEntered!: () => void
  let releaseRead!: () => void
  const entered = new Promise<void>((resolve) => {
    readEntered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    releaseRead = resolve
  })
  h.setGet(async () => {
    readEntered()
    await gate
    return observation()
  })
  const processing = h.run()
  await entered
  h.store.intentCurrent = false
  releaseRead()
  await processing
  assert.deepEqual(h.calls, ["get:message-original"])
  assert.equal(h.store.record.writeAttempts, 1)
  assert.equal(h.store.record.state, "stopped")
  assert.equal(h.store.record.lastOutcome?.code, "intent_superseded")
})

test("an already superseded run does not start any provider attempt", async () => {
  const h = harness()
  h.store.intentCurrent = false
  await h.run()
  assert.deepEqual(h.calls, [])
  assert.equal(h.store.record.writeAttempts, 0)
  assert.equal(h.store.record.readAttempts, 0)
  assert.equal(h.store.record.state, "stopped")
})

for (const invalidation of ["cancel", "deadline"] as const) {
  test(`intent ${invalidation} between persisted start and dispatch fails closed`, async () => {
    const store = new MemoryStore()
    let now = time()
    let calls = 0
    await processArchiveRecovery({
      store,
      now: () => now,
      random: () => 0,
      mail: {
        async modify() {
          calls++
          return { accepted: true }
        },
        async get() {
          calls++
          return observation({ inInbox: false })
        },
      },
      beforeDispatch: async () => {
        if (invalidation === "cancel") store.intentCurrent = false
        else now = time(60_000)
      },
    })
    assert.equal(calls, 0)
    assert.equal(
      store.record.writeAttempts,
      1,
      "a persisted dispatch-start still consumes its budget"
    )
    assert.equal(store.record.state, "stopped")
  })
}

const terminalScenarios: Array<{
  name: string
  get: ArchiveRecoveryMailPort["get"]
  state: "observed" | "stopped"
  code: string
}> = [
  {
    name: "permanent GET failure",
    async get() {
      throw new ArchiveProviderError(
        "unauthorized read",
        401,
        "authError",
        "none"
      )
    },
    state: "stopped",
    code: "read_failed_permanently",
  },
  {
    name: "changed opaque revision",
    async get() {
      return observation({ revision: "opaque:rev-B" })
    },
    state: "stopped",
    code: "intent_superseded",
  },
  {
    name: "desired state observed",
    async get() {
      return observation({ inInbox: false })
    },
    state: "observed",
    code: "desired_state_observed",
  },
]

for (const scenario of terminalScenarios) {
  test(`committed terminal ${scenario.name} resumes finalization without any provider replay`, async () => {
    const h = harness(
      recovery({
        nextOperation: "get",
        writeAttempts: 1,
        lastWriteOutcome: "unknown",
      })
    )
    h.setGet(scenario.get)
    const interruption = new Error("interrupted after terminal result commit")
    await assert.rejects(
      h.run({
        afterResult: async (operation) => {
          assert.equal(operation, "get")
          throw interruption
        },
      }),
      (error) => error === interruption
    )
    assert.deepEqual(h.calls, ["get:message-original"])
    assert.equal(h.store.record.state, "pending")
    assert.equal(h.store.record.inFlightOperation, null)
    assert.equal(h.store.record.readAttempts, 1)
    const terminal = h.store.record.lastOutcome?.terminalDecision
    assert(terminal && typeof terminal === "object" && !Array.isArray(terminal))
    assert.equal(terminal.state, scenario.state)
    assert(
      terminal.evidence &&
        typeof terminal.evidence === "object" &&
        !Array.isArray(terminal.evidence)
    )
    assert.equal(terminal.evidence.code, scenario.code)

    // A fresh store/controller sees only persisted state. Both budgets and the
    // deadline are now exhausted; committed outcome finalization still needs no I/O.
    const resumed = new MemoryStore({
      ...structuredClone(h.store.record),
      writeAttempts: defaultArchiveRecoveryPolicy.maxWrites,
      readAttempts: defaultArchiveRecoveryPolicy.maxReads,
    })
    await processArchiveRecovery({
      store: resumed,
      now: () => time(60_001),
      random: () => 0,
      mail: {
        async modify() {
          assert.fail("terminal outcome must not replay a modify")
        },
        async get() {
          assert.fail("terminal outcome must not re-observe a changed world")
        },
      },
    })
    assert.equal(resumed.record.state, scenario.state)
    assert.equal(resumed.record.lastOutcome?.code, scenario.code)
    assert.equal(resumed.record.lastWriteOutcome, "unknown")
    assert.deepEqual(resumed.events, [
      { type: "finish", evidence: terminal.evidence },
    ])
    if (scenario.state === "observed") {
      assert.equal(resumed.record.lastOutcome?.causality, "not_established")
    }
  })
}

test("cancellation while an absent-state GET is outstanding prevents observed completion", async () => {
  const h = harness(
    recovery({
      nextOperation: "get",
      writeAttempts: 1,
      lastWriteOutcome: "unknown",
    })
  )
  let readEntered!: () => void
  let releaseRead!: () => void
  const entered = new Promise<void>((resolve) => {
    readEntered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    releaseRead = resolve
  })
  h.setGet(async () => {
    readEntered()
    await gate
    return observation({ inInbox: false })
  })
  const processing = h.run()
  await entered
  h.store.intentCurrent = false
  releaseRead()
  await processing
  assert.deepEqual(h.calls, ["get:message-original"])
  assert.equal(h.store.record.state, "stopped")
  assert.equal(h.store.record.lastOutcome?.code, "intent_superseded")
  assert.equal(h.store.record.lastWriteOutcome, "unknown")
})

test("a committed observed result cannot revive an intent cancelled before finalization resumes", async () => {
  const h = harness(
    recovery({
      nextOperation: "get",
      writeAttempts: 1,
      lastWriteOutcome: "unknown",
    })
  )
  const interruption = new Error("stop before finalization")
  await assert.rejects(
    h.run({
      afterResult: async () => {
        throw interruption
      },
    }),
    (error) => error === interruption
  )
  assert.equal(h.store.record.state, "pending")
  h.store.intentCurrent = false
  await h.run()
  assert.deepEqual(h.calls, ["get:message-original"])
  assert.equal(h.store.record.state, "stopped")
  assert.equal(h.store.record.lastOutcome?.code, "intent_superseded")
})

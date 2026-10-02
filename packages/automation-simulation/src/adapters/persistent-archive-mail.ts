import { mkdir, readFile, writeFile, open } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { constants } from "node:fs"
import {
  ArchiveProviderError,
  type ArchiveRecoveryMailPort,
} from "@workspace/automations/email-triage"
import type { EmailTriageFakeScenario } from "../scenarios/email-triage-scenario"

export type FakeArchiveWrite =
  | "success"
  | "transient-before"
  | "unknown-before"
  | "unknown-after"
  | "permanent"
  | "permission"
  | "rate-limit"
  | "mismatch"
export type FakeArchiveRead =
  "success" | "transient" | "permanent" | "wrong-message"
export type PersistentArchiveFixture = {
  format: 2
  runId: string
  messageId: string
  inInbox: boolean
  revision: number
  writes: number
  reads: number
  writeScript: FakeArchiveWrite[]
  readScript: FakeArchiveRead[]
  fallbackWrite: FakeArchiveWrite
  fallbackRead: FakeArchiveRead
  retryAfterMs: number
}
export class PersistentArchiveMail implements ArchiveRecoveryMailPort {
  readonly path: string
  constructor(
    readonly runId: string,
    readonly root = process.env.ATLAS_FAKE_MAILBOX_DIR ??
      fileURLToPath(
        new URL("../../../../.local/archive-mailboxes", import.meta.url)
      ),
    private readonly hooks: { afterReadSnapshot?: () => Promise<void> } = {}
  ) {
    if (!/^[a-f0-9-]{36}$/.test(runId))
      throw new Error("Invalid fake mailbox Run identity")
    this.path = join(root, `${runId}.json`)
  }
  async initialize(messageId: string, scenario: EmailTriageFakeScenario = {}) {
    await mkdir(this.root, { recursive: true })
    const state: PersistentArchiveFixture = {
      format: 2,
      runId: this.runId,
      messageId,
      inInbox: !scenario.initiallyArchived,
      revision: 1,
      writes: 0,
      reads: 0,
      writeScript: scenario.archiveWriteScript ?? [],
      readScript:
        scenario.archiveReadScript ??
        Array(scenario.verificationTransientFailures ?? 0).fill("transient"),
      fallbackWrite:
        scenario.actionBehavior === "failure"
          ? "permanent"
          : scenario.actionBehavior === "unknown"
            ? scenario.archiveEffect === "apply"
              ? "unknown-after"
              : "unknown-before"
            : scenario.archiveEffect === "omit"
              ? "mismatch"
              : "success",
      fallbackRead:
        scenario.verificationBehavior === "transient-error"
          ? "transient"
          : ["failed", "unverified"].includes(
                scenario.verificationBehavior ?? ""
              )
            ? "permanent"
            : "success",
      retryAfterMs: scenario.archiveRetryAfterMs ?? 0,
    }
    // Never overwrite/reinitialize a restart's existing external world.
    await writeFile(this.path, JSON.stringify(state), {
      flag: "wx",
      flush: true,
    })
    await writeFile(`${this.path}.events`, "", { flag: "wx", flush: true })
    return state
  }
  async snapshot(): Promise<PersistentArchiveFixture> {
    const state = JSON.parse(
      await readFile(this.path, "utf8")
    ) as PersistentArchiveFixture
    if (
      state.format !== 2 ||
      state.runId !== this.runId ||
      !state.messageId ||
      typeof state.inInbox !== "boolean" ||
      !Number.isSafeInteger(state.revision)
    )
      throw new Error("Missing or corrupt persistent fake mailbox")
    const journal = await readFile(`${this.path}.events`, "utf8")
    if (journal && !journal.endsWith("\n"))
      throw new Error("Incomplete fake mailbox event")
    for (const line of journal.split("\n").filter(Boolean)) {
      const event = JSON.parse(line) as { type: string; apply?: boolean }
      if (event.type === "read") state.reads++
      else if (event.type === "modify" && typeof event.apply === "boolean") {
        state.writes++
        if (event.apply && state.inInbox) {
          state.inInbox = false
          state.revision++
        }
      } else if (event.type === "readd") {
        state.inInbox = true
        state.revision++
      } else throw new Error("Corrupt fake mailbox event")
    }
    return state
  }
  private async append(
    event: { type: "read" | "readd" } | { type: "modify"; apply: boolean }
  ) {
    // One short append is the external fixture operation's linearization point.
    // In particular a GET counter event can never rewrite mailbox state.
    // No O_CREAT: missing state must fail closed, including after restart.
    const handle = await open(
      `${this.path}.events`,
      constants.O_WRONLY | constants.O_APPEND
    )
    try {
      const data = Buffer.from(JSON.stringify(event) + "\n")
      const result = await handle.write(data)
      if (result.bytesWritten !== data.length)
        throw new Error("Incomplete fake mailbox append")
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
  async modify(messageId: string) {
    const state = await this.snapshot()
    if (state.messageId !== messageId)
      throw new ArchiveProviderError(
        "Wrong fake message",
        404,
        "notFound",
        "none"
      )
    const behavior = state.writeScript[state.writes] ?? state.fallbackWrite
    await this.append({
      type: "modify",
      apply: ["success", "unknown-after"].includes(behavior),
    })
    if (behavior === "transient-before")
      throw new ArchiveProviderError(
        "Programmed before-effect service failure",
        503,
        "backendError",
        "none",
        state.retryAfterMs
      )
    if (behavior === "rate-limit")
      throw new ArchiveProviderError(
        "Programmed rate limit",
        403,
        "userRateLimitExceeded",
        "none",
        state.retryAfterMs
      )
    if (behavior === "permission")
      throw new ArchiveProviderError(
        "Programmed permission rejection",
        403,
        "domainPolicy",
        "none"
      )
    if (behavior === "permanent")
      throw new ArchiveProviderError(
        "Programmed validation rejection",
        400,
        "badRequest",
        "none"
      )
    if (behavior.startsWith("unknown"))
      throw new ArchiveProviderError(
        "Programmed lost response",
        null,
        "timeout",
        "unknown",
        state.retryAfterMs
      )
    return { messageId, acknowledged: true }
  }
  async get(messageId: string) {
    const state = await this.snapshot()
    if (state.messageId !== messageId)
      throw new ArchiveProviderError(
        "Wrong fake message",
        404,
        "notFound",
        "none"
      )
    const behavior = state.readScript[state.reads] ?? state.fallbackRead
    await this.hooks.afterReadSnapshot?.()
    await this.append({ type: "read" })
    if (behavior === "transient")
      throw new ArchiveProviderError(
        "Programmed GET failure",
        503,
        "backendError",
        "none",
        state.retryAfterMs
      )
    if (behavior === "permanent")
      throw new ArchiveProviderError(
        "Programmed unavailable read evidence",
        403,
        "domainPolicy",
        "none"
      )
    const observed = await this.snapshot()
    return {
      messageId:
        behavior === "wrong-message" ? `${messageId}-wrong` : messageId,
      inInbox: observed.inInbox,
      revision: String(observed.revision),
    }
  }
  // Verification fixtures may emulate a later human mailbox edit. Never exposed
  // as a live-provider or HTTP control endpoint.
  async readdInbox() {
    await this.snapshot()
    await this.append({ type: "readd" })
  }
}

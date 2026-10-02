import {
  ExternalActionError,
  ExternalActionUnknownError,
  RetryableNodeError,
  type ActionResult,
  type VerificationResult,
} from "@workspace/automation-runtime"
import type {
  EmailTriageMailPort,
  NormalizedEmail,
} from "@workspace/automations/email-triage"

export type FakeActionBehavior = "success" | "failure" | "unknown"
export type FakeVerificationBehavior =
  "actual" | "verified" | "unverified" | "failed" | "transient-error"

type MessageState = {
  email: NormalizedEmail
  archived: boolean
  spam: boolean
}

export class FakeMailAdapter implements EmailTriageMailPort {
  private archiveCalls = 0
  private archiveVerifyCalls = 0
  private spamVerifyCalls = 0
  private readonly messages = new Map<string, MessageState>()

  constructor(
    private readonly behavior: {
      archive?: FakeActionBehavior
      archiveEffect?: "apply" | "omit"
      spam?: FakeActionBehavior
      verifyArchive?: FakeVerificationBehavior
      verifySpam?: FakeVerificationBehavior
      verifyArchiveTransientFailures?: number
      verifySpamTransientFailures?: number
    } = {}
  ) {}

  register(email: NormalizedEmail, initial = { archived: false }) {
    this.messages.set(email.messageId, {
      email,
      archived: initial.archived,
      spam: false,
    })
  }

  state(messageId: string) {
    const value = this.messages.get(messageId)
    return value ? structuredClone(value) : undefined
  }

  snapshot() {
    return [...this.messages.values()].map(({ email, archived, spam }) => ({
      messageId: email.messageId,
      inInbox: !archived && !spam,
      archived,
      spam,
    }))
  }

  get observations() {
    return {
      archiveAttempts: this.archiveCalls,
      archiveVerificationReads: this.archiveVerifyCalls,
    }
  }

  private message(messageId: string) {
    const message = this.messages.get(messageId)
    if (!message) {
      throw new ExternalActionError(`Unknown fake mail message ${messageId}`)
    }
    return message
  }

  async archive(messageId: string): Promise<ActionResult> {
    this.archiveCalls += 1
    const behavior = this.behavior.archive ?? "success"
    if (behavior === "failure") {
      throw new ExternalActionError("Programmed fake archive failure")
    }
    const message = this.message(messageId)
    // A lost response can follow a real effect. The caller must not infer failure.
    if (
      this.behavior.archiveEffect === "apply" ||
      (behavior === "success" && this.behavior.archiveEffect !== "omit")
    ) {
      message.archived = true
    }
    if (behavior === "unknown") {
      throw new ExternalActionUnknownError(
        "Programmed fake archive unknown outcome"
      )
    }

    return {
      response: { archived: true, messageId },
      externalRef: `fake-mail:${messageId}`,
    }
  }

  async reportSpam(messageId: string): Promise<ActionResult> {
    const behavior = this.behavior.spam ?? "success"
    if (behavior === "failure") {
      throw new ExternalActionError("Programmed fake spam failure")
    }
    if (behavior === "unknown") {
      throw new ExternalActionUnknownError(
        "Programmed fake spam unknown outcome"
      )
    }

    const message = this.message(messageId)
    message.spam = true
    return {
      response: { spam: true, messageId },
      externalRef: `fake-mail:${messageId}`,
    }
  }

  async verifyArchived(messageId: string): Promise<VerificationResult> {
    this.archiveVerifyCalls += 1
    if (
      this.archiveVerifyCalls <=
      (this.behavior.verifyArchiveTransientFailures ?? 0)
    ) {
      throw new RetryableNodeError(
        "Programmed transient archive verification failure"
      )
    }
    const behavior = this.behavior.verifyArchive ?? "actual"
    const message = this.message(messageId)
    return this.verificationResult(behavior, message.archived, {
      messageId,
      archived: message.archived,
    })
  }

  async verifySpam(messageId: string): Promise<VerificationResult> {
    this.spamVerifyCalls += 1
    if (
      this.spamVerifyCalls <= (this.behavior.verifySpamTransientFailures ?? 0)
    ) {
      throw new RetryableNodeError(
        "Programmed transient spam verification failure"
      )
    }
    const behavior = this.behavior.verifySpam ?? "actual"
    const message = this.message(messageId)
    return this.verificationResult(behavior, message.spam, {
      messageId,
      spam: message.spam,
    })
  }

  private verificationResult(
    behavior: FakeVerificationBehavior,
    actual: boolean,
    evidence: Record<string, string | boolean>
  ): VerificationResult {
    if (behavior === "transient-error") {
      throw new RetryableNodeError("Programmed transient verification failure")
    }
    if (behavior === "verified") return { status: "verified", evidence }
    if (behavior === "unverified") return { status: "unverified", evidence }
    if (behavior === "failed") return { status: "failed", evidence }
    return {
      status: actual ? "verified" : "failed",
      evidence,
    }
  }
}

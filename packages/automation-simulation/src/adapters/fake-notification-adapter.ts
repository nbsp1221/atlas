import {
  ExternalActionError,
  ExternalActionUnknownError,
  RetryableNodeError,
  type ActionResult,
  type VerificationResult,
} from "@workspace/automation-runtime"
import type { EmailTriageNotificationPort } from "@workspace/automations/email-triage"
import type { ResourceRef } from "@workspace/domain/integrations"
import type {
  FakeActionBehavior,
  FakeVerificationBehavior,
} from "./fake-mail-adapter"

export class FakeNotificationAdapter implements EmailTriageNotificationPort {
  private sequence = 0
  private verifyCalls = 0
  private readonly sent = new Map<
    string,
    { subject: string; target: ResourceRef }
  >()

  constructor(
    private readonly behavior: {
      send?: FakeActionBehavior
      verify?: FakeVerificationBehavior
      verifyTransientFailures?: number
    } = {}
  ) {}

  get sentCount() {
    return this.sent.size
  }

  async send(input: {
    target: ResourceRef
    messageId: string
    sender: string
    subject: string
    text: string
  }): Promise<ActionResult> {
    const behavior = this.behavior.send ?? "success"
    if (behavior === "failure") {
      throw new ExternalActionError("Programmed fake notification failure")
    }
    if (behavior === "unknown") {
      throw new ExternalActionUnknownError(
        "Programmed fake notification unknown outcome"
      )
    }

    this.sequence += 1
    const externalRef = `fake-notification:${this.sequence}`
    this.sent.set(externalRef, {
      subject: input.subject,
      target: input.target,
    })
    return {
      response: {
        deliveredToFakeServer: true,
        messageId: input.messageId,
        target: input.target,
      },
      externalRef,
    }
  }

  async verify(input: {
    target: ResourceRef
    externalRef: string
  }): Promise<VerificationResult> {
    this.verifyCalls += 1
    if (this.verifyCalls <= (this.behavior.verifyTransientFailures ?? 0)) {
      throw new RetryableNodeError(
        "Programmed transient notification verification failure"
      )
    }
    const behavior = this.behavior.verify ?? "actual"
    const sent = this.sent.get(input.externalRef)
    const targetMatches =
      sent?.target.integrationKey === input.target.integrationKey &&
      sent?.target.resourceType === input.target.resourceType &&
      sent?.target.externalId === input.target.externalId
    const evidence = {
      externalRef: input.externalRef,
      present: Boolean(sent),
      targetMatches,
      target: input.target,
    }

    if (behavior === "transient-error") {
      throw new RetryableNodeError("Programmed transient verification failure")
    }
    if (behavior === "verified") return { status: "verified", evidence }
    if (behavior === "unverified") return { status: "unverified", evidence }
    if (behavior === "failed") return { status: "failed", evidence }
    return {
      status: sent && targetMatches ? "verified" : "failed",
      evidence,
    }
  }
}

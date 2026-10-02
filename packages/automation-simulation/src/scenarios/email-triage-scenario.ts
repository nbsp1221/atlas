import type {
  EmailClassification,
  EmailRoute,
  NormalizedEmail,
} from "@workspace/automations/email-triage"
import type { JsonValue } from "@workspace/domain/persistence"
import { createDefaultFakeInteractionChannels } from "../adapters/fake-interaction-channel-adapter"
import type {
  FakeActionBehavior,
  FakeVerificationBehavior,
} from "../adapters/fake-mail-adapter"
import { FakeMailAdapter } from "../adapters/fake-mail-adapter"
import {
  FakeModelAdapter,
  type FakeModelStep,
} from "../adapters/fake-model-adapter"
import { FakeNotificationAdapter } from "../adapters/fake-notification-adapter"

export type EmailTriageFakeScenario = {
  archiveWriteScript?: import("../adapters/persistent-archive-mail").FakeArchiveWrite[]
  archiveReadScript?: import("../adapters/persistent-archive-mail").FakeArchiveRead[]
  archiveRetryAfterMs?: number
  // Fixture knobs only: this is not a user-approved mail classification policy.
  initiallyArchived?: boolean
  archiveEffect?: "apply" | "omit"
  modelDelayMs?: number
  disableExternalActions?: boolean
  route?: EmailRoute
  confidence?: number
  reasonSummary?: string
  modelTransientFailures?: number
  modelPermanentFailure?: boolean
  malformedModelOutput?: boolean
  modelOutputOverride?: JsonValue
  actionBehavior?: FakeActionBehavior
  verificationBehavior?: FakeVerificationBehavior
  verificationTransientFailures?: number
}

export function createEmailTriageFakeWorld(
  email: NormalizedEmail,
  scenario: EmailTriageFakeScenario = {}
) {
  const route = scenario.route ?? "notify"
  const classification: EmailClassification = {
    route,
    confidence: scenario.confidence ?? 0.95,
    reasonSummary:
      scenario.reasonSummary ?? `Programmed fake classification: ${route}`,
  }

  const modelSteps: FakeModelStep[] = []
  for (let i = 0; i < (scenario.modelTransientFailures ?? 0); i += 1) {
    modelSteps.push({ type: "transient-failure" })
  }

  if (scenario.modelPermanentFailure) {
    modelSteps.push({ type: "permanent-failure" })
  } else if (scenario.modelOutputOverride !== undefined) {
    modelSteps.push({
      type: "success",
      output: scenario.modelOutputOverride,
    })
  } else if (scenario.malformedModelOutput) {
    modelSteps.push({
      type: "success",
      output: { malformed: true },
    })
  } else {
    modelSteps.push({
      type: "success",
      output: classification,
      usageDetails: { reasoning: 5 },
      costUsd: 0.000123,
    })
  }

  const mail = new FakeMailAdapter({
    archive: route === "archive" ? scenario.actionBehavior : undefined,
    archiveEffect: scenario.archiveEffect,
    spam: route === "spam" ? scenario.actionBehavior : undefined,
    verifyArchive:
      route === "archive" ? scenario.verificationBehavior : undefined,
    verifySpam: route === "spam" ? scenario.verificationBehavior : undefined,
    verifyArchiveTransientFailures:
      route === "archive" ? scenario.verificationTransientFailures : undefined,
    verifySpamTransientFailures:
      route === "spam" ? scenario.verificationTransientFailures : undefined,
  })
  mail.register(email, { archived: scenario.initiallyArchived ?? false })

  const notification = new FakeNotificationAdapter({
    send: route === "notify" ? scenario.actionBehavior : undefined,
    verify: route === "notify" ? scenario.verificationBehavior : undefined,
    verifyTransientFailures:
      route === "notify" ? scenario.verificationTransientFailures : undefined,
  })

  return {
    model: new FakeModelAdapter(modelSteps, scenario.modelDelayMs),
    mail,
    notification,
    interactionChannels: createDefaultFakeInteractionChannels(),
  }
}

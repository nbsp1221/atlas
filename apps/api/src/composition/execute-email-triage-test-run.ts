import {
  recoverDueArchives,
  type ArchiveWorkerOptions,
} from "./archive-recovery"
import { PersistentArchiveMail } from "@workspace/automation-simulation"
import { createArchiveRecoveryRepository } from "@workspace/db"
import {
  assertRecoverableArchiveBranch,
  defaultArchiveRecoveryPolicy,
  validateArchiveRecoveryPolicy,
} from "@workspace/automations/email-triage"
import type { ArchiveRecoveryPolicy } from "@workspace/domain/persistence"
import type { ResourceRef } from "@workspace/domain/integrations"
import { fakeGmailMessageIdentity } from "./gmail-message-identity"
import {
  ExecutionEngine,
  type ExecutionResult,
} from "@workspace/automation-runtime"
import {
  assertEmailTriageDefinitionSemantics,
  createEmailTriageHandlers,
  type NormalizedEmail,
} from "@workspace/automations/email-triage"
import {
  createEmailTriageFakeWorld,
  type EmailTriageFakeScenario,
} from "@workspace/automation-simulation"
import {
  createExecutionRepository,
  createReadRepository,
  type Database,
} from "@workspace/db"
import {
  BindingPreflightError,
  preflightAutomationBindings,
} from "./binding-preflight"
import { installedIntegrations } from "./integration-registry"
import { automationGraphDefinitionSchema } from "@workspace/domain/persistence"

export type ExecuteEmailTriageTestRunInput = {
  email: NormalizedEmail
  version?: number
  scenario?: EmailTriageFakeScenario
  execution?:
    | { kind: "manual" }
    | {
        kind: "event"
        mailbox: ResourceRef
        historyId?: string
        notificationId?: string
      }
}

export type ExecuteEmailTriageTestRunResult =
  | {
      kind: "executed"
      result: ExecutionResult
      version: number
      simulation: {
        environment: "fake"
        mailboxBefore: ReturnType<
          ReturnType<typeof createEmailTriageFakeWorld>["mail"]["snapshot"]
        >
        mailboxAfter: ReturnType<
          ReturnType<typeof createEmailTriageFakeWorld>["mail"]["snapshot"]
        >
        archiveAttempts: number
        archiveVerificationReads: number
        modelRequests: ReturnType<
          typeof createEmailTriageFakeWorld
        >["model"]["requests"]
        notificationCount: number
      } | null
    }
  | {
      kind: "not_found"
      resource: "automation" | "version"
    }
  | {
      kind: "binding_error"
      code: string
      message: string
    }

export async function executeEmailTriageTestRun(
  db: Database,
  input: ExecuteEmailTriageTestRunInput,
  recoveryOptions: ArchiveWorkerOptions & {
    policy?: ArchiveRecoveryPolicy
    deferRecovery?: boolean
  } = {}
): Promise<ExecuteEmailTriageTestRunResult> {
  let eventIdentity
  try {
    if (input.execution?.kind === "event") {
      eventIdentity = fakeGmailMessageIdentity(
        input.execution.mailbox,
        input.email.messageId
      )
    }
  } catch (error) {
    return {
      kind: "binding_error",
      code: "invalid_event_identity",
      message:
        error instanceof Error ? error.message : "Invalid event identity",
    }
  }
  const readRepository = createReadRepository(db)
  // A known event observes immutable original evidence even if today's
  // selected version or grant is unavailable. This fake-only boundary has
  // already validated identity; a future live ingress must authorize the
  // actual mailbox before any lookup. This is not execution admission.
  if (eventIdentity) {
    const existing = await readRepository.findRunByIdempotencyKey({
      automationKey: "email-triage",
      mode: "test",
      idempotencyKey: eventIdentity.idempotencyKey,
    })
    if (existing) {
      const run = existing.run
      return {
        kind: "executed",
        version: existing.version.versionNumber,
        simulation: null,
        result: {
          runId: run.id,
          automationVersionId: run.automationVersionId,
          admission: "duplicate",
          ...(run.status === "succeeded"
            ? { status: run.status, output: run.outputSnapshot }
            : run.status === "failed"
              ? { status: run.status, error: run.error }
              : { status: run.status }),
        },
      }
    }
  }
  const versionBundle = await readRepository.findAutomationVersion(
    "email-triage",
    input.version
  )

  if (!versionBundle) {
    return { kind: "not_found", resource: "automation" }
  }
  if (!versionBundle.version) {
    return { kind: "not_found", resource: "version" }
  }

  // Validate the selected stored version, not only the source definition
  // imported at bootstrap. Reject drift before creating a Run or any adapters.
  let graph
  try {
    graph = assertEmailTriageDefinitionSemantics(
      automationGraphDefinitionSchema.parse(
        versionBundle.version.graphDefinition
      )
    )
    assertRecoverableArchiveBranch(graph)
  } catch (error) {
    return {
      kind: "binding_error",
      code: "invalid_automation_definition",
      message:
        error instanceof Error
          ? error.message
          : "Invalid Email Triage definition",
    }
  }

  const mailboxConnectionKey = graph.nodes.find(
    (node) => node.key === "gmail_event"
  )!.config.connectionKey as string
  const world = createEmailTriageFakeWorld(input.email, input.scenario)

  let preflight
  try {
    preflight = await preflightAutomationBindings({
      graph,
      mode: "test",
      repository: readRepository,
      registry: installedIntegrations,
      interactionChannels: world.interactionChannels,
    })
  } catch (error) {
    if (error instanceof BindingPreflightError) {
      return {
        kind: "binding_error",
        code: error.code,
        message: error.message,
      }
    }
    throw error
  }

  const mailboxBefore = world.mail.snapshot()
  const engine = new ExecutionEngine({
    now: recoveryOptions.now,
    store: createExecutionRepository(db),
    modelInvoker: world.model,
    handlers: createEmailTriageHandlers({
      mail: world.mail,
      notification: world.notification,
      interactionChannels: world.interactionChannels,
      archiveRecovery: {
        async enqueue(intent) {
          const fixture = new PersistentArchiveMail(
            intent.runId,
            recoveryOptions.fixtureRoot
          )
          const initial = await fixture.initialize(
            intent.messageId,
            input.scenario
          )
          await createArchiveRecoveryRepository(db).enqueue({
            ...intent,
            connectionId: preflight.connectionIdsByKey[mailboxConnectionKey],
            initialRevision: String(initial.revision),
            policy: validateArchiveRecoveryPolicy(
              recoveryOptions.policy ?? defaultArchiveRecoveryPolicy
            ),
            now: recoveryOptions.now?.() ?? new Date(),
          })
        },
      },
    }),
    policy: {
      // Test runs exercise the full ActionExecution/verification lifecycle
      // against programmable fake adapters only.
      allowExternalActions: !input.scenario?.disableExternalActions,
      maxModelRetries: 2,
    },
  })

  let result = await engine.execute({
    automationId: versionBundle.automation.id,
    automationVersionId: versionBundle.version.id,
    mode: "test",
    graph,
    input: input.email,
    idempotencyKey: eventIdentity?.idempotencyKey,
    triggerIntegrationKey: eventIdentity ? "gmail" : undefined,
    triggerConnectionKey: eventIdentity ? mailboxConnectionKey : undefined,
    triggerSnapshot: {
      source: eventIdentity ? "simulated_event" : "manual_test",
      ...(eventIdentity && input.execution?.kind === "event"
        ? {
            mailbox: eventIdentity.mailbox,
            messageId: input.email.messageId,
            historyId: input.execution.historyId ?? null,
            notificationId: input.execution.notificationId ?? null,
          }
        : {}),
      adapterEnvironment: "fake",
      mailboxBefore,
    },
    connectionIdsByKey: preflight.connectionIdsByKey,
  })

  let archiveState
  if (result.admission === "created") {
    if (!recoveryOptions.deferRecovery)
      await recoverDueArchives(db, recoveryOptions, result.runId)
    const persisted = await readRepository.findRun(result.runId)
    if (persisted) {
      const run = persisted.run
      result = {
        runId: result.runId,
        automationVersionId: result.automationVersionId,
        admission: "created",
        ...(run.status === "succeeded"
          ? { status: run.status, output: run.outputSnapshot }
          : run.status === "failed"
            ? { status: run.status, error: run.error }
            : { status: run.status }),
      }
      if (
        persisted.actions.some(
          (action) => action.actionKey === "archive-message"
        )
      )
        archiveState = await new PersistentArchiveMail(
          result.runId,
          recoveryOptions.fixtureRoot
        ).snapshot()
    }
  }
  const original =
    result.admission === "duplicate"
      ? await readRepository.findRun(result.runId)
      : null
  if (result.admission === "duplicate" && !original)
    throw new Error("Admitted run disappeared")
  return {
    kind: "executed",
    result,
    version:
      original?.version.versionNumber ?? versionBundle.version.versionNumber,
    simulation:
      result.admission === "duplicate"
        ? null
        : {
            environment: "fake",
            mailboxBefore,
            mailboxAfter: archiveState
              ? [
                  {
                    messageId: archiveState.messageId,
                    inInbox: archiveState.inInbox,
                    archived: !archiveState.inInbox,
                    spam: false,
                  },
                ]
              : world.mail.snapshot(),
            ...(archiveState
              ? {
                  archiveAttempts: archiveState.writes,
                  archiveVerificationReads: archiveState.reads,
                }
              : world.mail.observations),
            modelRequests: world.model.requests,
            notificationCount: world.notification.sentCount,
          },
  }
}

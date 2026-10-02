import type {
  ActionResult,
  VerificationResult,
} from "@workspace/automation-runtime"
import type { ResourceRef } from "@workspace/domain/integrations"

export interface EmailTriageMailPort {
  archive(messageId: string): Promise<ActionResult>
  reportSpam(messageId: string): Promise<ActionResult>
  verifyArchived(messageId: string): Promise<VerificationResult>
  verifySpam(messageId: string): Promise<VerificationResult>
}

export type ResolvedInteractionChannel = {
  key: string
  integrationKey: string
  connectionKey: string
  actionKey: string
  endpoint: ResourceRef
}

export interface EmailTriageInteractionChannelPort {
  resolve(key: string): Promise<ResolvedInteractionChannel>
}

export interface EmailTriageNotificationPort {
  send(input: {
    target: ResourceRef
    messageId: string
    sender: string
    subject: string
    text: string
  }): Promise<ActionResult>

  verify(input: {
    target: ResourceRef
    externalRef: string
  }): Promise<VerificationResult>
}

export type EmailTriagePorts = {
  mail: EmailTriageMailPort
  notification: EmailTriageNotificationPort
  interactionChannels: EmailTriageInteractionChannelPort
  archiveRecovery?: {
    enqueue(input: {
      runId: string
      nodeExecutionId: string
      messageId: string
    }): Promise<void>
  }
}

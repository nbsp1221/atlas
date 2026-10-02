import {
  ExecutionSuspendedError,
  type NodeHandler,
} from "@workspace/automation-runtime"
import { assertBindingValues, emailTriageBindings } from "../bindings"
import type { EmailTriageMailPort, EmailTriagePorts } from "../ports"
import { emailFromRunInput, externalActionBinding } from "../helpers"

export function createArchiveEmailHandler(
  mail: EmailTriageMailPort,
  recovery?: EmailTriagePorts["archiveRecovery"]
): NodeHandler {
  return {
    async execute(context) {
      const email = emailFromRunInput(context.runInput)
      const binding = externalActionBinding(context.node.config)
      assertBindingValues(
        binding,
        emailTriageBindings.archiveEmail,
        "archive_email binding"
      )
      if (recovery) {
        await recovery.enqueue({
          runId: context.runId,
          nodeExecutionId: context.nodeExecutionId,
          messageId: email.messageId,
        })
        throw new ExecutionSuspendedError()
      }
      const result = await context.performAction({
        integrationKey: binding.integrationKey,
        connectionKey: binding.connectionKey,
        actionKey: binding.actionKey,
        request: { messageId: email.messageId },
        perform: () => mail.archive(email.messageId),
      })

      return {
        output: {
          actionExecutionId: result.actionExecutionId,
          externalRef: result.externalRef ?? null,
          response: result.response,
        },
      }
    },
  }
}

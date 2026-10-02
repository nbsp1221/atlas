import type { NodeHandler } from "@workspace/automation-runtime"
import { assertBindingValues, emailTriageBindings } from "../bindings"
import type { EmailTriageMailPort } from "../ports"
import { emailFromRunInput, externalActionBinding } from "../helpers"

export function createReportSpamHandler(
  mail: EmailTriageMailPort
): NodeHandler {
  return {
    async execute(context) {
      const email = emailFromRunInput(context.runInput)
      const binding = externalActionBinding(context.node.config)
      assertBindingValues(
        binding,
        emailTriageBindings.reportSpam,
        "report_spam binding"
      )
      const result = await context.performAction({
        integrationKey: binding.integrationKey,
        connectionKey: binding.connectionKey,
        actionKey: binding.actionKey,
        request: { messageId: email.messageId },
        perform: () => mail.reportSpam(email.messageId),
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

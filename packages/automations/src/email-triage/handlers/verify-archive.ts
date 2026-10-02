import type { NodeHandler } from "@workspace/automation-runtime"
import { assertBindingValues, emailTriageBindings } from "../bindings"
import type { EmailTriageMailPort } from "../ports"
import {
  emailFromRunInput,
  externalVerificationBinding,
  objectValue,
  stringValue,
} from "../helpers"

export function createVerifyArchiveHandler(
  mail: EmailTriageMailPort
): NodeHandler {
  return {
    async execute(context) {
      const binding = externalVerificationBinding(context.node.config)
      assertBindingValues(
        binding,
        emailTriageBindings.verifyArchive,
        "verify_archive binding"
      )
      const email = emailFromRunInput(context.runInput)
      const action = objectValue(context.outputOf("archive_email"))
      const actionExecutionId = stringValue(action, "actionExecutionId")
      const result = await context.verifyAction({
        actionExecutionId,
        verify: () => mail.verifyArchived(email.messageId),
      })
      return { output: result }
    },
  }
}

import type { NodeHandler } from "@workspace/automation-runtime"
import { assertBindingValues, emailTriageBindings } from "../bindings"
import type { EmailTriageNotificationPort } from "../ports"
import {
  interactionChannelBinding,
  objectValue,
  resourceRefValue,
  stringValue,
} from "../helpers"

export function createVerifyDeliveryHandler(
  notification: EmailTriageNotificationPort
): NodeHandler {
  return {
    async execute(context) {
      const binding = interactionChannelBinding(context.node.config)
      assertBindingValues(
        { ...binding, verificationKey: context.node.config.verificationKey },
        emailTriageBindings.verifyDelivery,
        "verify_delivery binding"
      )
      const action = objectValue(context.outputOf("notify_user"))
      const actionExecutionId = stringValue(action, "actionExecutionId")
      const externalRef = stringValue(action, "externalRef")
      const target = resourceRefValue(action.target)
      const result = await context.verifyAction({
        actionExecutionId,
        verify: () => notification.verify({ target, externalRef }),
      })
      return { output: result }
    },
  }
}

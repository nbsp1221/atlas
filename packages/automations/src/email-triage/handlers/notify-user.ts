import type { NodeHandler } from "@workspace/automation-runtime"
import { assertBindingValues, emailTriageBindings } from "../bindings"
import type {
  EmailTriageInteractionChannelPort,
  EmailTriageNotificationPort,
} from "../ports"
import { emailFromRunInput, interactionChannelBinding } from "../helpers"

export function createNotifyUserHandler(
  notification: EmailTriageNotificationPort,
  interactionChannels: EmailTriageInteractionChannelPort
): NodeHandler {
  return {
    async execute(context) {
      const email = emailFromRunInput(context.runInput)
      const binding = interactionChannelBinding(context.node.config)
      assertBindingValues(
        binding,
        emailTriageBindings.notifyUser,
        "notify_user binding"
      )
      const channel = await interactionChannels.resolve(
        binding.interactionChannelKey
      )
      const sender = email.sender.name
        ? `${email.sender.name} <${email.sender.address}>`
        : email.sender.address

      const result = await context.performAction({
        integrationKey: channel.integrationKey,
        connectionKey: channel.connectionKey,
        actionKey: channel.actionKey,
        resource: channel.endpoint,
        request: {
          messageId: email.messageId,
          sender,
          subject: email.subject,
        },
        perform: () =>
          notification.send({
            target: channel.endpoint,
            messageId: email.messageId,
            sender,
            subject: email.subject,
            text: email.text,
          }),
      })

      return {
        output: {
          actionExecutionId: result.actionExecutionId,
          externalRef: result.externalRef ?? null,
          target: channel.endpoint,
          interactionChannelKey: channel.key,
          response: result.response,
        },
      }
    },
  }
}

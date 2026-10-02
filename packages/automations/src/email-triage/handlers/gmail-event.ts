import type { NodeHandler } from "@workspace/automation-runtime"
import { assertBindingValues, emailTriageBindings } from "../bindings"
import { emailFromRunInput, externalTriggerBinding } from "../helpers"

export const gmailEventHandler: NodeHandler = {
  async execute(context) {
    const binding = externalTriggerBinding(context.node.config)
    assertBindingValues(
      binding,
      emailTriageBindings.gmailEvent,
      "gmail_event binding"
    )
    return { output: emailFromRunInput(context.runInput) }
  },
}

import { automationGraphDefinitionSchema } from "@workspace/domain/persistence"
import {
  assertEmailTriageDefinitionSemantics,
  bindingConfig,
  emailTriageBindings,
} from "./bindings"

const parsedDefinition = automationGraphDefinitionSchema.parse({
  schemaVersion: 2,
  nodes: [
    {
      key: "gmail_event",
      kind: "trigger",
      label: "Gmail event",
      config: {
        ...bindingConfig(emailTriageBindings.gmailEvent),
        detail: "Incoming normalized mail event",
      },
    },
    {
      key: "classify_email",
      kind: "decision",
      label: "Classify mail",
      config: {
        modelProvider: "testkit",
        model: "email-triage-classifier-v1",
        parameters: {
          temperature: 0,
        },
        prompt:
          "Classify the incoming email into exactly one predefined route: archive, notify, spam, or no_action.",
        detail: "Chooses one predefined route",
      },
    },
    {
      key: "archive_email",
      kind: "action",
      label: "Archive",
      config: {
        ...bindingConfig(emailTriageBindings.archiveEmail),
        detail: "Remove the inbox state through the mail port",
      },
    },
    {
      key: "notify_user",
      kind: "action",
      label: "Notify",
      config: {
        ...bindingConfig(emailTriageBindings.notifyUser),
        detail: "Send through the configured personal notification channel",
      },
    },
    {
      key: "report_spam",
      kind: "action",
      label: "Spam",
      config: {
        ...bindingConfig(emailTriageBindings.reportSpam),
        detail: "Report the message as spam through the mail port",
      },
    },
    {
      key: "no_action",
      kind: "terminal",
      label: "No action",
      config: {
        detail: "Explicit terminal path",
      },
    },
    {
      key: "verify_archive",
      kind: "verify",
      label: "Confirm archive",
      config: {
        ...bindingConfig(emailTriageBindings.verifyArchive),
        detail: "Verify archive state through the mail port",
      },
    },
    {
      key: "verify_delivery",
      kind: "verify",
      label: "Confirm delivery",
      config: {
        ...bindingConfig(emailTriageBindings.verifyDelivery),
        detail: "Verify notification outcome when possible",
      },
    },
    {
      key: "verify_spam",
      kind: "verify",
      label: "Confirm spam",
      config: {
        ...bindingConfig(emailTriageBindings.verifySpam),
        detail: "Verify spam state through the mail port",
      },
    },
  ],
  edges: [
    { key: "trigger", source: "gmail_event", target: "classify_email" },
    {
      key: "archive",
      source: "classify_email",
      target: "archive_email",
      label: "archive",
    },
    {
      key: "notify",
      source: "classify_email",
      target: "notify_user",
      label: "notify",
    },
    {
      key: "spam",
      source: "classify_email",
      target: "report_spam",
      label: "spam",
    },
    {
      key: "no_action",
      source: "classify_email",
      target: "no_action",
      label: "no_action",
    },
    {
      key: "archive_verify",
      source: "archive_email",
      target: "verify_archive",
    },
    {
      key: "notify_verify",
      source: "notify_user",
      target: "verify_delivery",
    },
    {
      key: "spam_verify",
      source: "report_spam",
      target: "verify_spam",
    },
  ],
})

export const emailTriageDefinition =
  assertEmailTriageDefinitionSemantics(parsedDefinition)

export const emailTriageAutomation = {
  key: "email-triage",
  name: "Email Triage",
  description: "Classifies incoming mail into predefined routes.",
  definition: emailTriageDefinition,
} as const

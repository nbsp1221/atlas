import type { NodeHandlerRegistry } from "@workspace/automation-runtime"
import type { EmailTriagePorts } from "../ports"
import { createArchiveEmailHandler } from "./archive-email"
import { classifyEmailHandler } from "./classify-email"
import { gmailEventHandler } from "./gmail-event"
import { noActionHandler } from "./no-action"
import { createNotifyUserHandler } from "./notify-user"
import { createReportSpamHandler } from "./report-spam"
import { createVerifyArchiveHandler } from "./verify-archive"
import { createVerifyDeliveryHandler } from "./verify-delivery"
import { createVerifySpamHandler } from "./verify-spam"

export function createEmailTriageHandlers(
  ports: EmailTriagePorts
): NodeHandlerRegistry {
  return new Map([
    ["gmail_event", gmailEventHandler],
    ["classify_email", classifyEmailHandler],
    [
      "archive_email",
      createArchiveEmailHandler(ports.mail, ports.archiveRecovery),
    ],
    [
      "notify_user",
      createNotifyUserHandler(ports.notification, ports.interactionChannels),
    ],
    ["report_spam", createReportSpamHandler(ports.mail)],
    ["no_action", noActionHandler],
    ["verify_archive", createVerifyArchiveHandler(ports.mail)],
    ["verify_delivery", createVerifyDeliveryHandler(ports.notification)],
    ["verify_spam", createVerifySpamHandler(ports.mail)],
  ])
}

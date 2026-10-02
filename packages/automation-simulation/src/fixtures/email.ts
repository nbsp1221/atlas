import type { NormalizedEmail } from "@workspace/automations/email-triage"

export function fakeEmail(
  overrides: Partial<NormalizedEmail> = {}
): NormalizedEmail {
  return {
    messageId: "fake-message-1",
    sender: {
      name: "Example Support",
      address: "support@example.com",
    },
    subject: "Your support inquiry has a reply",
    text: "We have reviewed your request and are replying with the details.",
    receivedAt: "2026-09-30T00:00:00.000Z",
    ...overrides,
  }
}

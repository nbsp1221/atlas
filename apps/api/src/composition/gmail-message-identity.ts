import type { ResourceRef } from "@workspace/domain/integrations"

// Identity validation is deliberately lossless. Never lowercase, trim, or join
// components with a delimiter that could collapse distinct mailbox/message IDs.
function identifier(value: string, name: string, maxLength = 255) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value !== value.trim() ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0)
      return code <= 32 || code === 127
    })
  ) {
    throw new Error(`Invalid ${name}`)
  }
  return value
}

function identity(
  environment: "fake" | "live",
  mailboxId: string,
  messageId: string
) {
  const mailbox: ResourceRef = {
    integrationKey: "gmail",
    resourceType: "mailbox",
    externalId: identifier(mailboxId, "mailbox identity"),
  }
  return {
    mailbox,
    // Run.automationId supplies workflow scope. Version and authorization-grant
    // identity are intentionally absent: a reconnect must not repeat an effect.
    idempotencyKey: JSON.stringify([
      "gmail-message-v1",
      environment,
      mailbox.externalId,
      identifier(messageId, "message identity"),
    ]),
  }
}

export function fakeGmailMessageIdentity(
  mailbox: ResourceRef,
  messageId: string
) {
  if (
    mailbox.integrationKey !== "gmail" ||
    mailbox.resourceType !== "mailbox" ||
    mailbox.parent !== undefined
  ) {
    throw new Error("Invalid fake mailbox resource")
  }
  return identity("fake", mailbox.externalId, messageId)
}

// Future authenticated Gmail ingress must resolve the *actual target mailbox*
// to a verified Google subject before calling this helper. These strings are
// stored OAuth identity evidence, not proof of authentication. Do not pass an
// untrusted request body, an email alias, 'me', a delegated service-account
// subject, or a Connection ID here. No live ingress exists in this product yet.
export function gmailMessageIdentityFromConnection(
  connection: {
    providerKey: string
    externalPrincipalType: string | null
    externalPrincipalId: string | null
  },
  messageId: string
) {
  if (
    connection.providerKey !== "google" ||
    connection.externalPrincipalType !== "google-sub" ||
    connection.externalPrincipalId === null ||
    connection.externalPrincipalId === "me" ||
    !/^[\x21-\x7e]+$/.test(connection.externalPrincipalId) ||
    connection.externalPrincipalId.includes("@")
  ) {
    throw new Error("A verified canonical Google mailbox subject is required")
  }
  return identity("live", connection.externalPrincipalId, messageId)
}

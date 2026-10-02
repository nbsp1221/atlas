import assert from "node:assert/strict"
import test from "node:test"
import {
  fakeGmailMessageIdentity,
  gmailMessageIdentityFromConnection,
} from "../src/composition/gmail-message-identity"

const mailbox = (externalId: string) => ({
  integrationKey: "gmail",
  resourceType: "mailbox",
  externalId,
})
test("Gmail identity tuple is lossless, mailbox scoped and environment separated", () => {
  const key = (m: string, id: string) =>
    fakeGmailMessageIdentity(mailbox(m), id).idempotencyKey
  assert.notEqual(key("a:b", "c"), key("a", "b:c"))
  assert.notEqual(key('a\"b', "c"), key("a", 'b\"c'))
  assert.notEqual(key("A", "m"), key("a", "m"))
  assert.notEqual(key("mailbox", "A"), key("mailbox", "a"))
  assert.notEqual(key("郵便", "消息"), key("郵", "便消息"))
  assert.equal(key("fixture", "m"), key("fixture", "m"))
  const connection = {
    providerKey: "google",
    externalPrincipalType: "google-sub",
    externalPrincipalId: "subject-1",
  }
  const live = gmailMessageIdentityFromConnection(connection, "m")
  assert.notEqual(key("subject-1", "m"), live.idempotencyKey)
  assert.equal(
    live.idempotencyKey,
    gmailMessageIdentityFromConnection({ ...connection }, "m").idempotencyKey
  )
  assert.deepEqual(live.mailbox, mailbox("subject-1"))
})
test("identity fails closed instead of trimming, guessing an account, or using email aliases", () => {
  for (const invalid of ["", " ", " x", "x ", "x\n", "x\t", "x".repeat(256)]) {
    assert.throws(() => fakeGmailMessageIdentity(mailbox(invalid), "m"))
    assert.throws(() => fakeGmailMessageIdentity(mailbox("fixture"), invalid))
  }
  assert.throws(() =>
    fakeGmailMessageIdentity(
      { ...mailbox("fixture"), integrationKey: "drive" },
      "m"
    )
  )
  assert.throws(() =>
    fakeGmailMessageIdentity(
      {
        ...mailbox("fixture"),
        parent: { resourceType: "tenant", externalId: "x" },
      },
      "m"
    )
  )
  for (const connection of [
    {
      providerKey: "google",
      externalPrincipalType: null,
      externalPrincipalId: null,
    },
    {
      providerKey: "google",
      externalPrincipalType: "email",
      externalPrincipalId: "someone@example.com",
    },
    {
      providerKey: "google",
      externalPrincipalType: "google-sub",
      externalPrincipalId: "me",
    },
    {
      providerKey: "google",
      externalPrincipalType: "google-sub",
      externalPrincipalId: "someone@example.com",
    },
    {
      providerKey: "other",
      externalPrincipalType: "google-sub",
      externalPrincipalId: "subject",
    },
  ])
    assert.throws(() => gmailMessageIdentityFromConnection(connection, "m"))
})

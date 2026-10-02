import assert from "node:assert/strict"
import test from "node:test"
import { ModelProviderError } from "@workspace/automation-runtime"
import {
  FakeMailAdapter,
  FakeModelAdapter,
  FakeNotificationAdapter,
  fakeEmail,
} from "../src"

test("fake model is programmable across transient failure and success", async () => {
  const model = new FakeModelAdapter([
    { type: "transient-failure" },
    { type: "success", output: { route: "notify" } },
  ])

  await assert.rejects(
    () =>
      model.invoke({
        provider: "fake",
        model: "fake",
        parameters: {},
        input: {},
      }),
    (error) => error instanceof ModelProviderError && error.transient
  )

  const result = await model.invoke({
    provider: "fake",
    model: "fake",
    parameters: {},
    input: {},
  })
  assert.deepEqual(result.output, { route: "notify" })
})

test("fake mail and notification ports expose observable state", async () => {
  const email = fakeEmail()
  const mail = new FakeMailAdapter()
  mail.register(email)

  await mail.archive(email.messageId)
  assert.equal(mail.state(email.messageId)?.archived, true)
  assert.equal((await mail.verifyArchived(email.messageId)).status, "verified")

  const notification = new FakeNotificationAdapter()
  const target = {
    integrationKey: "telegram",
    resourceType: "chat",
    externalId: "fake-personal-chat",
  }
  const sent = await notification.send({
    target,
    messageId: email.messageId,
    sender: email.sender.address,
    subject: email.subject,
    text: email.text,
  })
  assert(sent.externalRef)
  assert.equal(
    (
      await notification.verify({
        target,
        externalRef: sent.externalRef!,
      })
    ).status,
    "verified"
  )
})

test("archive evidence observes effect, lost response, and mismatched readback independently", async () => {
  for (const [behavior, effect, archived] of [
    ["success", undefined, true],
    ["success", "omit", false],
    ["unknown", undefined, false],
    ["unknown", "apply", true],
    ["failure", undefined, false],
  ] as const) {
    const mail = new FakeMailAdapter({
      archive: behavior,
      archiveEffect: effect,
    })
    const email = fakeEmail()
    mail.register(email)
    const before = mail.snapshot()
    if (behavior === "success") await mail.archive(email.messageId)
    else await assert.rejects(() => mail.archive(email.messageId))
    assert.equal(before[0].inInbox, true)
    assert.equal(mail.snapshot()[0].archived, archived)
    assert.equal(
      (await mail.verifyArchived(email.messageId)).status,
      archived ? "verified" : "failed"
    )
    assert.deepEqual(mail.observations, {
      archiveAttempts: 1,
      archiveVerificationReads: 1,
    })
    const observed = mail.state(email.messageId)!
    observed.archived = !archived
    assert.equal(
      mail.state(email.messageId)?.archived,
      archived,
      "observations must not mutate the fake world"
    )
  }
})

test("repeated archives are a state-idempotent fake effect but still two attempts", async () => {
  const mail = new FakeMailAdapter()
  const email = fakeEmail()
  mail.register(email, { archived: true })
  await mail.archive(email.messageId)
  await mail.archive(email.messageId)
  assert.equal(mail.snapshot()[0].inInbox, false)
  assert.equal(mail.observations.archiveAttempts, 2)
})

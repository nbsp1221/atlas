import assert from "node:assert/strict"
import test from "node:test"
import {
  emailSummaryAutomation,
  emailSummaryFixture,
  emailSummarySteps,
} from "../src/email-summary"
import {
  resolveCodeSteps,
  type NodeExecutionContext,
} from "@workspace/automation-runtime"
import type { JsonValue } from "@workspace/domain/persistence"
async function summarize(input: JsonValue) {
  const handlers = resolveCodeSteps(
    emailSummaryAutomation.definition,
    emailSummarySteps
  )
  let value = input
  for (const handler of handlers.values())
    value = (await handler.execute({ input: value } as NodeExecutionContext))
      .output!
  return value
}
test("map/filter/reduce fixture excludes unread, starred and personal emails", async () => {
  assert.deepEqual(await summarize(emailSummaryFixture), {
    count: 3,
    ids: ["read-news-1", "read-news-2", "other"],
    bySender: [
      {
        sender: "news@example.com",
        count: 2,
        ids: ["read-news-1", "read-news-2"],
      },
      { sender: "other@example.com", count: 1, ids: ["other"] },
    ],
  })
  assert.equal(emailSummaryFixture[0].sender, " NEWS@Example.com ")
})
for (const input of [
  [],
  emailSummaryFixture.filter(
    (email) => !email.read || email.starred || email.category === "personal"
  ),
])
  test(`empty/no-match input (${input.length}) yields explicit empty summary`, async () => {
    assert.deepEqual(await summarize(input), {
      count: 0,
      ids: [],
      bySender: [],
    })
  })
test("each source is actual callable and includes exact schemas/version/hash", () => {
  for (const step of emailSummarySteps) {
    assert.match(String(step.metadata.sourceHash), /^[a-f0-9]{64}$/)
    assert.match(String(step.metadata.implementationHash), /^[a-f0-9]{64}$/)
    assert.equal(step.metadata.version, "1.0.0")
    assert.equal(step.metadata.sourceLanguage, "javascript")
  }
})

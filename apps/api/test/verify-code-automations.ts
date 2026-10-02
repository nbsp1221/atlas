import assert from "node:assert/strict"
import { createReadRepository, type Database } from "@workspace/db"
import { emailSummaryFixture } from "@workspace/automations"
import { executeCodeAutomation } from "../src/composition/registered-code-automations"
import { runDetailReadModel, toAutomationGraph } from "../src/read-models"
export async function verifyCodeAutomations(db: Database) {
  const repository = createReadRepository(db)
  const version = await repository.findAutomationVersion("email-summary")
  assert(version?.version)
  const inputs = [
    emailSummaryFixture,
    [],
    emailSummaryFixture.filter(
      (email) => !email.read || email.starred || email.category === "personal"
    ),
  ]
  for (const [index, input] of inputs.entries()) {
    const result = await executeCodeAutomation(
      db,
      "email-summary",
      version.version.versionNumber,
      input
    )
    assert.equal(result.status, "succeeded")
    const bundle = await repository.findRun(result.runId)
    assert(bundle)
    assert.equal(bundle.nodes.length, 3)
    assert.deepEqual(
      bundle.nodes.map((node) => node.nodeKind),
      ["transform", "transform", "transform"]
    )
    assert.deepEqual(
      bundle.nodes.map((node) => node.sequence),
      [1, 2, 3]
    )
    assert.deepEqual(
      bundle.nodes[1].inputSnapshot,
      bundle.nodes[0].outputSnapshot
    )
    assert.deepEqual(
      bundle.nodes[2].inputSnapshot,
      bundle.nodes[1].outputSnapshot
    )
    assert.equal(bundle.actions.length, 0)
    assert.equal(bundle.models.length, 0)
    assert.deepEqual(bundle.run.outputSnapshot, bundle.nodes[2].outputSnapshot)
    const detail = runDetailReadModel(bundle)
    assert(detail.nodeExecutions.every((node) => node.implementation !== null))
    assert.equal(
      (detail.output as { count: number }).count,
      index === 0 ? 3 : 0
    )
    const failedNodes = bundle.nodes.map((node, i) => ({
      ...node,
      status: i === 0 ? ("failed" as const) : node.status,
    }))
    assert.equal(
      toAutomationGraph("email-summary", 1, bundle.version.graphDefinition, {
        nodes: failedNodes,
        models: [],
        actions: [],
      }).nodes[0].health,
      "attention"
    )
  }
  const failure = await executeCodeAutomation(
    db,
    "email-summary",
    version.version.versionNumber,
    [{ ...emailSummaryFixture[0], sender: "   " }]
  )
  assert.equal(failure.status, "failed")
  const failed = await repository.findRun(failure.runId)
  assert(failed)
  assert.equal(failed.nodes.length, 1)
  assert.equal(failed.nodes[0].error?.code, "invalid_step_output")
  assert.equal(failed.run.status, "failed")
  process.stdout.write(
    "✓ code-step fixture, empty/no-match, persisted sequential I/O, exact source identity, no effects, and failed-step stop verified\n"
  )
}

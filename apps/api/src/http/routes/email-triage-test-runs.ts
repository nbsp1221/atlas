import { fakeGmailMessageIdentity } from "../../composition/gmail-message-identity"
import { randomUUID } from "node:crypto"
import { Hono } from "hono"
import { z } from "zod"
import {
  emailRouteValues,
  normalizedEmailSchema,
} from "@workspace/automations/email-triage"
import type { Database } from "@workspace/db"
import { executeEmailTriageTestRun } from "../../composition/execute-email-triage-test-run"

const scenarioSchema = z.object({
  archiveWriteScript: z
    .array(
      z.enum([
        "success",
        "transient-before",
        "unknown-before",
        "unknown-after",
        "permanent",
        "permission",
        "rate-limit",
        "mismatch",
      ])
    )
    .max(10)
    .optional(),
  archiveReadScript: z
    .array(z.enum(["success", "transient", "permanent", "wrong-message"]))
    .max(20)
    .optional(),
  archiveRetryAfterMs: z.number().int().min(0).max(300_000).optional(),
  initiallyArchived: z.boolean().optional(),
  archiveEffect: z.enum(["apply", "omit"]).optional(),
  modelDelayMs: z.number().int().min(0).max(100).optional(),
  disableExternalActions: z.boolean().optional(),
  route: z.enum(emailRouteValues).optional(),
  confidence: z.number().min(0).max(1).optional(),
  reasonSummary: z.string().max(500).optional(),
  modelTransientFailures: z.number().int().min(0).max(3).optional(),
  modelPermanentFailure: z.boolean().optional(),
  malformedModelOutput: z.boolean().optional(),
  modelOutputOverride: z.json().optional(),
  actionBehavior: z.enum(["success", "failure", "unknown"]).optional(),
  verificationBehavior: z
    .enum(["actual", "verified", "unverified", "failed", "transient-error"])
    .optional(),
  verificationTransientFailures: z.number().int().min(0).max(1).optional(),
})

const executionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("manual") }),
  z.strictObject({
    kind: z.literal("event"),
    mailbox: z.strictObject({
      integrationKey: z.literal("gmail"),
      resourceType: z.literal("mailbox"),
      externalId: z.string(),
    }),
    historyId: z.string().min(1).max(255).optional(),
    notificationId: z.string().min(1).max(255).optional(),
  }),
])

const requestSchema = z.strictObject({
  version: z.number().int().positive().optional(),
  email: normalizedEmailSchema.omit({ messageId: true }).extend({
    messageId: z
      .string()
      .refine((value) => value.trim().length > 0)
      .optional(),
  }),
  scenario: scenarioSchema.optional(),
  execution: executionSchema.optional(),
})

export function emailTriageTestRunRoutes(db: Database) {
  const routes = new Hono()

  routes.post("/api/automations/email-triage/test-runs", async (context) => {
    let body: unknown
    try {
      body = await context.req.json()
    } catch {
      return context.json({ error: "invalid_json" }, 400)
    }

    const parsed = requestSchema.safeParse(body)
    if (!parsed.success) {
      return context.json(
        {
          error: "invalid_request",
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
        400
      )
    }

    // Event identities must be explicit and lossless before the normalized
    // email parser can trim legacy manual-fixture strings.
    if (parsed.data.execution?.kind === "event") {
      try {
        fakeGmailMessageIdentity(
          parsed.data.execution.mailbox,
          parsed.data.email.messageId ?? ""
        )
      } catch (error) {
        return context.json(
          {
            error: "invalid_event_identity",
            message:
              error instanceof Error ? error.message : "Invalid event identity",
          },
          400
        )
      }
    }

    const email = normalizedEmailSchema.parse({
      ...parsed.data.email,
      messageId: parsed.data.email.messageId ?? randomUUID(),
    })

    const execution = await executeEmailTriageTestRun(db, {
      email,
      version: parsed.data.version,
      scenario: parsed.data.scenario,
      execution: parsed.data.execution,
    })

    if (execution.kind === "not_found") {
      return context.json({ error: `${execution.resource}_not_found` }, 404)
    }

    if (execution.kind === "binding_error") {
      return context.json(
        { error: execution.code, message: execution.message },
        409
      )
    }

    return context.json(
      {
        runId: execution.result.runId,
        admission: execution.result.admission,
        status: execution.result.status,
        version: execution.version,
        simulation: execution.simulation,
        ...(execution.result.status === "failed"
          ? { error: execution.result.error }
          : {}),
      },
      execution.result.admission === "duplicate" ? 200 : 201
    )
  })

  return routes
}

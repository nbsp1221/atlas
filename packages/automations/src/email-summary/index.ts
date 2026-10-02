import { z } from "zod"
import { defineCodeStep } from "@workspace/automation-runtime"
import {
  automationGraphDefinitionSchema,
  type JsonObject,
} from "@workspace/domain/persistence"

const email = z.strictObject({
  id: z.string().min(1),
  sender: z.string().min(1),
  subject: z.string(),
  read: z.boolean(),
  starred: z.boolean(),
  category: z.enum(["newsletter", "personal"]),
})
export const emailSummaryInputSchema = z.array(email).max(1000)
const normalizedSchema = z
  .array(email.extend({ sender: z.string().min(1) }))
  .max(1000)
const summarySchema = z.strictObject({
  count: z.number().int().nonnegative(),
  ids: z.array(z.string()),
  bySender: z.array(
    z.strictObject({
      sender: z.string(),
      count: z.number().int().positive(),
      ids: z.array(z.string()),
    })
  ),
})
type Email = z.infer<typeof email>
type Summary = z.infer<typeof summarySchema>
const validatorIdentity = `zod@${z.core.version.major}.${z.core.version.minor}.${z.core.version.patch}; JSON-schema-only strict schemas; no refinements/transforms`

export const emailSummarySteps = [
  defineCodeStep({
    id: "email.normalize",
    version: "1.0.0",
    inputSchema: emailSummaryInputSchema,
    outputSchema: normalizedSchema,
    inputJsonSchema: z.toJSONSchema(emailSummaryInputSchema) as JsonObject,
    outputJsonSchema: z.toJSONSchema(normalizedSchema) as JsonObject,
    validatorIdentity,
    execute: function normalizeEmails(emails: Email[]): Email[] {
      return emails.map((email) => ({
        ...email,
        sender: email.sender.trim().toLowerCase(),
        subject: email.subject.trim(),
      }))
    },
  }),
  defineCodeStep({
    id: "email.archive-candidates",
    version: "1.0.0",
    inputSchema: normalizedSchema,
    outputSchema: normalizedSchema,
    inputJsonSchema: z.toJSONSchema(normalizedSchema) as JsonObject,
    outputJsonSchema: z.toJSONSchema(normalizedSchema) as JsonObject,
    validatorIdentity,
    execute: function archiveCandidates(emails: Email[]): Email[] {
      return emails.filter(
        (email) =>
          email.read && !email.starred && email.category === "newsletter"
      )
    },
  }),
  defineCodeStep({
    id: "email.summarize",
    version: "1.0.0",
    inputSchema: normalizedSchema,
    outputSchema: summarySchema,
    inputJsonSchema: z.toJSONSchema(normalizedSchema) as JsonObject,
    outputJsonSchema: z.toJSONSchema(summarySchema) as JsonObject,
    validatorIdentity,
    execute: function summarizeCandidates(emails: Email[]): Summary {
      return emails.reduce<Summary>(
        (summary, email) => {
          summary.count += 1
          summary.ids.push(email.id)
          let sender = summary.bySender.find(
            (group) => group.sender === email.sender
          )
          if (!sender) {
            sender = { sender: email.sender, count: 0, ids: [] }
            summary.bySender.push(sender)
          }
          sender.count += 1
          sender.ids.push(email.id)
          return summary
        },
        { count: 0, ids: [], bySender: [] }
      )
    },
  }),
]
export const emailSummaryFixture = [
  {
    id: "read-news-1",
    sender: " NEWS@Example.com ",
    subject: " Weekly news ",
    read: true,
    starred: false,
    category: "newsletter",
  },
  {
    id: "read-news-2",
    sender: "news@example.com",
    subject: "More news",
    read: true,
    starred: false,
    category: "newsletter",
  },
  {
    id: "unread",
    sender: "news@example.com",
    subject: "Unread",
    read: false,
    starred: false,
    category: "newsletter",
  },
  {
    id: "starred",
    sender: "news@example.com",
    subject: "Keep",
    read: true,
    starred: true,
    category: "newsletter",
  },
  {
    id: "personal",
    sender: "friend@example.com",
    subject: "Hello",
    read: true,
    starred: false,
    category: "personal",
  },
  {
    id: "other",
    sender: "other@example.com",
    subject: "Other",
    read: true,
    starred: false,
    category: "newsletter",
  },
] satisfies Email[]
export const emailSummaryAutomation = {
  key: "email-summary",
  name: "Email Code Steps",
  description:
    "Trusted TypeScript map → filter → reduce on fake email JSON. No mailbox actions or model calls.",
  definition: automationGraphDefinitionSchema.parse({
    schemaVersion: 1,
    entryNodeKey: "normalize",
    nodes: emailSummarySteps.map((step, index) => ({
      key: ["normalize", "filter", "summarize"][index],
      kind: "transform",
      label: [
        "Normalize emails · map",
        "Archive candidates · filter",
        "Summary · reduce",
      ][index],
      config: { implementation: step.metadata },
    })),
    edges: [
      { key: "normalized", source: "normalize", target: "filter" },
      { key: "candidates", source: "filter", target: "summarize" },
    ],
  }),
}

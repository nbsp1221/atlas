import { z } from "zod"

export const emailRouteValues = [
  "archive",
  "notify",
  "spam",
  "no_action",
] as const

export const normalizedEmailSchema = z.object({
  messageId: z.string().trim().min(1),
  sender: z.object({
    name: z.string().trim().min(1).optional(),
    address: z.string().trim().min(1),
  }),
  subject: z.string(),
  text: z.string(),
  receivedAt: z.string().optional(),
})

export const emailClassificationSchema = z.object({
  route: z.enum(emailRouteValues),
  confidence: z.number().min(0).max(1).optional(),
  reasonSummary: z.string().max(500).optional(),
})

export type EmailRoute = (typeof emailRouteValues)[number]
export type NormalizedEmail = z.infer<typeof normalizedEmailSchema>
export type EmailClassification = z.infer<typeof emailClassificationSchema>

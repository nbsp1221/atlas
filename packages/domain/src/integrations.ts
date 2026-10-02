import { z } from "zod"

export const resourceRefSchema = z.object({
  integrationKey: z.string().trim().min(1),
  resourceType: z.string().trim().min(1),
  externalId: z.string().trim().min(1),
  parent: z
    .object({
      resourceType: z.string().trim().min(1),
      externalId: z.string().trim().min(1),
    })
    .optional(),
})

export type ResourceRef = z.infer<typeof resourceRefSchema>

export const externalTriggerBindingSchema = z.object({
  integrationKey: z.string().trim().min(1),
  connectionKey: z.string().trim().min(1),
  triggerKey: z.string().trim().min(1),
})

export const externalActionBindingSchema = z.object({
  integrationKey: z.string().trim().min(1),
  connectionKey: z.string().trim().min(1),
  actionKey: z.string().trim().min(1),
})

export const externalVerificationBindingSchema = z.object({
  integrationKey: z.string().trim().min(1),
  connectionKey: z.string().trim().min(1),
  verificationKey: z.string().trim().min(1),
})

export const interactionChannelBindingSchema = z.object({
  interactionChannelKey: z.string().trim().min(1),
})

export type ExternalTriggerBinding = z.infer<
  typeof externalTriggerBindingSchema
>
export type ExternalActionBinding = z.infer<typeof externalActionBindingSchema>
export type ExternalVerificationBinding = z.infer<
  typeof externalVerificationBindingSchema
>
export type InteractionChannelBinding = z.infer<
  typeof interactionChannelBindingSchema
>

export type IntegrationDescriptor = {
  requiredGrants?: string[]
  key: string
  providerKey: string
}

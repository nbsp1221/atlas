import { InvalidNodeOutputError } from "@workspace/automation-runtime"
import {
  externalActionBindingSchema,
  externalTriggerBindingSchema,
  externalVerificationBindingSchema,
  interactionChannelBindingSchema,
  resourceRefSchema,
} from "@workspace/domain/integrations"
import type { JsonObject, JsonValue } from "@workspace/domain/persistence"
import { normalizedEmailSchema, type NormalizedEmail } from "./contracts"

export function emailFromRunInput(input: JsonValue): NormalizedEmail {
  const parsed = normalizedEmailSchema.safeParse(input)
  if (!parsed.success) {
    throw new InvalidNodeOutputError(
      "Email Triage requires a valid normalized email input"
    )
  }
  return parsed.data
}

export function objectValue(value: JsonValue | null): JsonObject {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new InvalidNodeOutputError("Expected object node output")
  }
  return value
}

export function stringValue(object: JsonObject, key: string): string {
  const value = object[key]
  if (typeof value !== "string") {
    throw new InvalidNodeOutputError(`Expected string field ${key}`)
  }
  return value
}

function parseConfig<T>(
  parser: {
    safeParse(value: unknown): { success: true; data: T } | { success: false }
  },
  config: JsonObject,
  label: string
): T {
  const parsed = parser.safeParse(config)
  if (!parsed.success) {
    throw new InvalidNodeOutputError(`Invalid ${label} node binding`)
  }
  return parsed.data
}

export const externalTriggerBinding = (config: JsonObject) =>
  parseConfig(externalTriggerBindingSchema, config, "external trigger")

export const externalActionBinding = (config: JsonObject) =>
  parseConfig(externalActionBindingSchema, config, "external action")

export const externalVerificationBinding = (config: JsonObject) =>
  parseConfig(
    externalVerificationBindingSchema,
    config,
    "external verification"
  )

export const interactionChannelBinding = (config: JsonObject) =>
  parseConfig(interactionChannelBindingSchema, config, "interaction channel")

export function resourceRefValue(value: JsonValue) {
  const parsed = resourceRefSchema.safeParse(value)
  if (!parsed.success) {
    throw new InvalidNodeOutputError("Expected ResourceRef")
  }
  return parsed.data
}

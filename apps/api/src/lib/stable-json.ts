import { createHash } from "node:crypto"
import type { JsonValue } from "@workspace/domain/persistence"

function normalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(normalize)

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalize(nested)])
    )
  }

  return value
}

export function stableJson(value: JsonValue) {
  return JSON.stringify(normalize(value))
}

export function sha256Json(value: JsonValue) {
  return createHash("sha256").update(stableJson(value)).digest("hex")
}

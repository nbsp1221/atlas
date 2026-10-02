export const ATLAS_OWNER_ID = "atlas-owner"
export const SESSION_SECONDS = 12 * 60 * 60
export const FRESH_SECONDS = 15 * 60
export const AUTH_BODY_LIMIT_BYTES = 16 * 1024

export const GOOGLE_CALLBACK_PATH = "/api/settings/connections/google/callback"

export type AdminAuthConfig = {
  origin: string
  secret: string
}

export function readAdminAuthConfig(
  env: Record<string, string | undefined>
): AdminAuthConfig | null {
  const secret = env.ATLAS_AUTH_SECRET
  const value = env.ATLAS_PUBLIC_URL

  // This validates presence/length, not randomness. Installation must
  // supply an independently generated secret through an approved flow.
  if (
    !secret ||
    secret.length < 32 ||
    secret !== secret.trim() ||
    /[\r\n\0]/.test(secret) ||
    !value
  ) {
    return null
  }

  try {
    const url = new URL(value)

    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    ) {
      return null
    }

    return {
      origin: url.origin,
      secret,
    }
  } catch {
    return null
  }
}

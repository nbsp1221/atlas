export class ProviderError extends Error {
  constructor(
    readonly code:
      | "provider_auth_rejected"
      | "provider_unavailable"
      | "provider_invalid_response"
      | "provider_rate_limited"
  ) {
    super(code)
  }
}
export type ProviderFetch = typeof fetch
export async function providerJson(
  url: string,
  init: RequestInit,
  transport: ProviderFetch = fetch
): Promise<Record<string, unknown>> {
  try {
    const response = await transport(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    })
    if (!response.ok) {
      if (response.status === 401 || response.status === 403)
        throw new ProviderError("provider_auth_rejected")
      if (response.status === 429)
        throw new ProviderError("provider_rate_limited")
      throw new ProviderError("provider_unavailable")
    }
    const data: unknown = await response.json()
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new ProviderError("provider_invalid_response")
    return data as Record<string, unknown>
  } catch (error) {
    if (error instanceof ProviderError) throw error
    throw new ProviderError("provider_unavailable")
  }
}
export type ProbeResult = {
  principalType: string | null
  principalId: string | null
  scopes: string[]
}

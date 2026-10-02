import {
  providerJson,
  ProviderError,
  type ProbeResult,
  type ProviderFetch,
} from "../http"
export async function checkAnthropic(
  key: string,
  transport?: ProviderFetch
): Promise<ProbeResult> {
  const data = await providerJson(
    "https://api.anthropic.com/v1/models?limit=1",
    { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } },
    transport
  )
  if (!Array.isArray(data.data))
    throw new ProviderError("provider_invalid_response")
  return { principalType: null, principalId: null, scopes: ["models.list"] }
}

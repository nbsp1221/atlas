import {
  providerJson,
  ProviderError,
  type ProbeResult,
  type ProviderFetch,
} from "../http"
export async function checkOpenAI(
  key: string,
  transport?: ProviderFetch
): Promise<ProbeResult> {
  const data = await providerJson(
    "https://api.openai.com/v1/models",
    { headers: { Authorization: `Bearer ${key}` } },
    transport
  )
  if (!Array.isArray(data.data))
    throw new ProviderError("provider_invalid_response")
  return { principalType: null, principalId: null, scopes: ["models.list"] }
}

import {
  providerJson,
  ProviderError,
  type ProbeResult,
  type ProviderFetch,
} from "../http"
export async function checkTelegram(
  key: string,
  transport?: ProviderFetch
): Promise<ProbeResult> {
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(key))
    throw new ProviderError("provider_auth_rejected")
  // Telegram requires the token in the path. Never log this request or caught errors.
  const data = await providerJson(
    `https://api.telegram.org/bot${key}/getMe`,
    { method: "POST" },
    transport
  )
  const user = data.result as Record<string, unknown> | undefined
  if (
    data.ok !== true ||
    !user ||
    typeof user.id !== "number" ||
    user.is_bot !== true
  )
    throw new ProviderError("provider_auth_rejected")
  return {
    principalType: "telegram-bot",
    principalId: String(user.id),
    scopes: ["bot"],
  }
}

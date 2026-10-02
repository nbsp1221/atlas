import type { IntegrationDescriptor } from "@workspace/domain/integrations"

export const installedIntegrations = new Map<string, IntegrationDescriptor>([
  [
    "model-openai",
    {
      key: "model-openai",
      providerKey: "openai",
      requiredGrants: ["models.list"],
    },
  ],
  [
    "model-anthropic",
    {
      key: "model-anthropic",
      providerKey: "anthropic",
      requiredGrants: ["models.list"],
    },
  ],
  [
    "gmail",
    {
      key: "gmail",
      providerKey: "google",
      requiredGrants: ["https://www.googleapis.com/auth/gmail.modify"],
    },
  ],
  [
    "telegram",
    {
      key: "telegram",
      providerKey: "telegram",
      requiredGrants: ["bot"],
    },
  ],
])

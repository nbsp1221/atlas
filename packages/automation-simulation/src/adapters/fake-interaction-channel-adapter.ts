import type {
  EmailTriageInteractionChannelPort,
  ResolvedInteractionChannel,
} from "@workspace/automations/email-triage"

export class FakeInteractionChannelAdapter implements EmailTriageInteractionChannelPort {
  constructor(
    private readonly bindings: Record<string, ResolvedInteractionChannel>
  ) {}

  async resolve(key: string): Promise<ResolvedInteractionChannel> {
    const binding = this.bindings[key]
    if (!binding) {
      throw new Error(`Unknown fake interaction channel: ${key}`)
    }
    return binding
  }
}

export function createDefaultFakeInteractionChannels() {
  return new FakeInteractionChannelAdapter({
    "personal-notifications": {
      key: "personal-notifications",
      integrationKey: "telegram",
      connectionKey: "telegram-atlas-bot",
      actionKey: "send-message",
      endpoint: {
        integrationKey: "telegram",
        resourceType: "chat",
        externalId: "fake-personal-chat",
      },
    },
  })
}

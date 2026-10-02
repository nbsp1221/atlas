# Integrations

Real external-provider adapters belong here and are grouped by **Provider**, not
by individual product capability.

Target shape:

```text
packages/integrations/
├─ google/
│  ├─ package.json
│  └─ src/
│     ├─ provider.ts
│     ├─ auth/
│     ├─ client/
│     ├─ gmail/
│     ├─ calendar/
│     ├─ drive/
│     └─ docs/
├─ telegram/
├─ slack/
├─ github/
├─ notion/
└─ discord/
```

Provider packages may use official SDKs, Nango, Composio, or another backend as
implementation details. The rest of Atlas sees stable domain identities:

- **Provider** — authorization/identity platform, e.g. `google`.
- **Integration** — capability/API surface, e.g. `gmail`.
- **Connection** — persisted authorization grant/authority context.
- **ResourceRef** — external object locator.
- **InteractionChannel** — configured human ↔ Atlas messaging endpoint.

The Google package deliberately contains Gmail/Calendar/Drive/Docs together so
one authorization/client lifecycle can serve several Integrations without
pretending that Gmail itself is the Connection Provider.

Production integration packages must not depend on a specific Automation.
Provider SDK concerns must not move into `automation-runtime` or
`automations`.

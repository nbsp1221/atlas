# Architecture

This repository starts from the official shadcn Vite monorepo scaffold and uses
a ports-and-adapters boundary for automation execution.

## Workspace boundaries

```text
                            @workspace/domain
                                   ▲
                                   │
                     @workspace/automation-runtime
                                   ▲
                                   │
                         @workspace/automations
                         /          |          \
                        /           |           \
             @workspace/db   integrations/*   @workspace/automation-simulation
                        \           |           /
                         \          |          /
                              apps/api

apps/web ─────────▶ @workspace/domain
   │
   └──────────────▶ @workspace/ui
```

The arrows describe dependency direction, not runtime calls.

### `packages/domain`

Shared product vocabulary, persistence value types, and API read-model schemas.

- Types and Zod schemas only.
- No React, React Flow, Hono, Drizzle, provider SDKs, or runtime engine code.

### `packages/automation-runtime`

Provider-independent graph execution kernel.

- Owns `ExecutionEngine`, execution policy, generic runtime contracts, and
  generic ports such as `ExecutionStore` and `ModelInvoker`.
- Must not contain `email`, `gmail`, `telegram`, or provider SDK logic.
- Must not import `db`, `apps/api`, `ui`, or real integrations.

### `packages/automations`

Product automation business logic, grouped by automation.

```text
src/email-triage/
├── definition.ts
├── contracts.ts
├── ports.ts
└── handlers/
```

- Email Triage owns `classify_email`, archive/notify/spam behavior, and
  verification handlers.
- It depends on runtime contracts, never Gmail/Telegram/model SDKs.
- A different automation gets a different cohesive directory.

### `packages/automation-simulation`

Product test-run simulation and programmable external world.

- Fake model, mail, notification, and InteractionChannel adapters.
- Powers the explicit test-run workflow as well as automated verification.
- Reproduces success, transient failure, permanent failure, unknown outcome,
  verification failure, and retry behavior deterministically.
- It is not a real Provider integration or credential backend.
- Production business logic cannot branch on whether these adapters are simulated.

### `packages/integrations`

Real provider adapters only, grouped by Provider.

- Google is one provider package containing Gmail/Calendar/Drive/Docs
  Integrations because they can share authorization/client lifecycle.
- Telegram, Slack, GitHub, Notion, and Discord become independent provider
  packages when implemented.
- Native SDKs, Nango, or Composio stay behind this boundary.
- Replacing fake adapters with real adapters must not require changes to the
  runtime engine or Email Triage business semantics.

### `packages/db`

PostgreSQL persistence boundary.

- Drizzle schema/migrations.
- Read repository.
- `ExecutionStore` implementation using intent-specific methods.
- No generic arbitrary-update API is exposed to the runtime.

### `packages/ui`

Shared shadcn visual primitives.

- Keep upstream-generated primitives close to upstream.
- No product domain, database, or runtime imports.

### `apps/api`

HTTP/process boundary and composition root.

- Chooses concrete adapters and composes the runtime.
- Read-only product API plus the explicit provider-independent simulation/test-run endpoint.
- Must not contain Email Triage business handlers.
- Must not import React/UI.

### `apps/web`

Product UI.

- Reads Hono API through same-origin `/api`.
- May use `@workspace/domain` and `@workspace/ui`.
- Never imports DB or runtime packages.

## Integration domain boundaries

```text
Provider
  = authorization / identity platform
  = google, telegram, slack, github, notion, discord

Integration
  = capability / API surface
  = gmail, google-calendar, google-drive, ...

Connection
  = persisted authorization grant / authority context

ResourceRef
  = external object locator

InteractionChannel
  = configured human ↔ Atlas communication endpoint
```

The core rule is **Integration is capability; Connection is authority**.

A Google Connection may satisfy multiple Google Integrations. Gmail messages,
calendars, repositories, chats, and similar objects are Resources rather than
Connections.

Email Triage v2 therefore binds Gmail nodes with
`integrationKey=gmail + connectionKey=google-primary`, while user
notification resolves the logical `personal-notifications` InteractionChannel
to its concrete Integration, Connection, and endpoint at composition time.

Execution evidence preserves the resolved identity:

- `Run.trigger_integration_key + trigger_connection_id`
- `ActionExecution.integration_key + action_key + connection_id`
- resource target in the sanitized action request snapshot when relevant

Provider/Integration compatibility is validated by the API composition layer,
not by the provider-independent execution kernel. Automation-specific semantic
validation additionally prevents immutable graph bindings from claiming an
operation different from the handler that will actually execute it.

## Hard boundary checks

These imports are architectural violations:

```text
automation-runtime -> db
automation-runtime -> integrations
automation-runtime -> automations
automation-runtime -> automation-simulation
automations        -> provider SDK / db / automation-simulation
web                -> db / runtime / automations
ui                 -> domain / db / runtime / automations
```

These rules are enforced by `pnpm check:boundaries`, which scans source
imports and workspace dependency declarations. A practical smell test remains:
provider SDKs and provider-specific business concepts must never enter
`packages/automation-runtime`.

## Current execution path

The provider-independent fake environment now exercises the complete write
lifecycle:

```text
Normalized email
  -> atomic Run admission (duplicate returns existing Run without execution)
  -> trigger NodeExecution
  -> classifier NodeExecution
  -> ModelInvocation
  -> graph-controlled route
  -> action NodeExecution
  -> ActionExecution
  -> verifier NodeExecution
  -> verified/unverified/failed outcome
  -> Run terminal state
  -> read API
  -> UI
```

Model-provider retries create multiple `ModelInvocation` rows inside one
physical node execution. Whole-node retries create linked `NodeExecution`
rows. External unknown outcomes remain distinct from ordinary failures.

Real Gmail/model/Telegram adapters are intentionally deferred. They should be
new adapter implementations, not a redesign of this core.

Message-event admission reuses Run.idempotencyKey. Logical mailbox identity is independent of authorization-grant Connection identity; fake/live namespaces are separate. Manual test requests intentionally omit the event key. See [the admission decision](docs/message-admission-decision.md) for atomicity, unresolved external outcomes, and migration scope.


Archive-only recovery now adds a generic kernel suspension signal, with the policy and bounded continuation owned by Email Triage. The original Run/Node/Action identities stay fixed. New archive_recoveries scheduling and append-only archive_attempt_events evidence tables do not form a generic workflow platform. Only the fake test composition installs the worker, and fixture mailbox persistence stays in automation-simulation. See [archive recovery](docs/archive-recovery-decision.md).

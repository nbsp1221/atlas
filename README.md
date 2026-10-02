# Atlas

A personal automation workspace with a React UI, PostgreSQL-backed execution
history, single-owner administrator authentication and reusable Connections.
Automation test runs use fake external effects; provider transports and read-only
Connection probes exist, but live Gmail/model/Telegram automation is not enabled.

## Workspace

- `apps/web` — React/Vite product UI
- `apps/api` — Hono HTTP/process boundary and composition root
- `packages/ui` — shared UI adapted from shadcn/ui
- `packages/domain` — shared product/read-model contracts
- `packages/automation-runtime` — provider-independent execution kernel
- `packages/automations` — cohesive automation business logic
- `packages/automation-simulation` — product test-run simulation and programmable fake external world
- `packages/integrations` — provider transports, OAuth and read-only Connection probes
- `packages/db` — Drizzle/PostgreSQL and execution-store boundary

See [ARCHITECTURE.md](./ARCHITECTURE.md) for dependency rules.

## Requirements

- Node.js 22.22.1 or later in the 22.x line, or Node.js 24+
- pnpm 10.33.4 (pinned in `packageManager`)
- Docker with Compose for local PostgreSQL 17 and isolated verification
- OpenSSL and Playwright Chromium for the full verification gate

## Quickstart: disposable verification

```bash
corepack pnpm install --frozen-lockfile
pnpm --filter web exec playwright install chromium
pnpm verify:local
```

If `pnpm` is not on PATH, use `corepack pnpm` in its place. Verification creates
its own database server, synthetic owner, encryption keys and localhost TLS
certificate. It cleans up those resources and requires no real accounts, secrets
or provider calls. It includes typechecks, lint, builds, unit tests, browser tests,
constraint/upgrade checks and recovery scenarios. Install Chromium's OS libraries
if the Playwright installer reports missing system dependencies.

## Run your own installation

There is no default administrator or public signup. A working authenticated app
needs a PostgreSQL database, a canonical HTTPS origin, a matching trusted TLS
certificate/private key, an independently generated auth secret and an explicitly
provisioned owner. Plain HTTP Vite development alone cannot provide authenticated
administrator access; protected APIs fail closed when auth is unconfigured.

1. Copy `.env.example` to ignored `.env`. Fill in your own settings and protect
   that file. Keep TLS files and optional credential keyrings outside version
   control. Do not put server secrets in `VITE_*` variables
2. Load the same configuration for every command below. The API and database
   commands read process environment; they do not automatically load root `.env`:

   ```bash
   # POSIX shell; source only a .env file you control, with shell-safe values
   set -a
   . ./.env
   set +a
   ```

3. For a new local database, `pnpm db:up` starts the development Compose service.
   Its example password is for local use only. For an existing installation,
   first verify a backup and confirm `DATABASE_URL` points to the intended database
4. Apply migrations and seed the registered automation definitions for a new
   installation:

   ```bash
   pnpm --filter @workspace/db db:migrate
   pnpm --filter api bootstrap
   ```

5. Set `ATLAS_WEB_DIST` to an absolute, dedicated build directory, then build the
   web app. Do not overwrite a directory currently served by an existing preview:

   ```bash
   pnpm --filter web exec tsc -b
   pnpm --filter web exec vite build --outDir "$ATLAS_WEB_DIST"
   ```

6. Provision your owner with `pnpm --filter api provision-owner --apply`, supplying
   JSON on protected stdin with `email`, `name` and a 12–128 character `password`.
   Do this locally using a secure input method, not a command-line password or
   committed fixture. Repeating provisioning fails rather than replacing an owner
7. Start `pnpm --filter api start` and open `ATLAS_PUBLIC_URL`. The API serves the
   compiled UI and APIs together over native HTTPS. Use `pnpm --filter api dev`
   for API source watching with the same exported configuration

`ATLAS_PUBLIC_URL` must be an HTTPS origin without a path, query or fragment, and
its hostname/port must reach the native TLS listener. Forwarded proxy headers are
not trusted. `ATLAS_LISTEN_HOST` defaults to loopback; choose exposure deliberately.
A self-signed test certificate from the verification gate is not a real deployment
certificate. See [administrator setup](docs/admin-auth-completion.md) and
[storage/backup guidance](docs/sandbox-storage-recovery.md).

Connections are optional. Empty credential storage can start without a keyring;
credential writes remain unavailable until `ATLAS_CREDENTIAL_KEYS_FILE` and its
active key version are configured. The file is a JSON object mapping versions to
base64-encoded 32-byte keys. Keep all versions needed by existing ciphertext and
backups, separately protected from the database. Provider credentials entered in
Settings remain encrypted in PostgreSQL; `.env` does not replace that store.
See [key maintenance](docs/connections-implementation.md#key-recovery-and-rotation).

For UI-only Vite development/preview, a private additional hostname can be set in
ignored `apps/web/.env.local` as `ATLAS_DEV_ALLOWED_HOST`. It accepts one exact
hostname, never a wildcard; Vite's default localhost/IP allowance remains intact.
This setting is server-side and does not configure the canonical auth origin.

## Database verification

Against a fresh, disposable database only:

```bash
DATABASE_URL="postgres://postgres:postgres@localhost:5432/<test-db>" pnpm --filter @workspace/db db:verify
```

## Provider-independent runtime verification

Against a fresh migrated and bootstrapped database:

```bash
DATABASE_URL="postgres://postgres:postgres@localhost:5432/<test-db>" pnpm --filter api runtime:verify
```

The suite executes normal routes, model retries, whole-node retries, malformed
model output, undefined routes, external action failures/unknown outcomes, and
verification outcomes using only fake adapters.

## Verification

Fast individual checks:

```bash
pnpm check:boundaries
pnpm typecheck
pnpm lint
pnpm --filter api exec tsc -p tsconfig.build.json --outDir ../../audit/admin-auth/build/api
pnpm --filter web exec vite build --outDir ../../audit/admin-auth/build/web
pnpm test:verification
```

`pnpm test:verification` runs database-free boundary and verification-isolation
checks. Root `pnpm test` includes Playwright; standalone web tests
(`pnpm --filter web test`) require the gate-created E2E database and exact
verification environment. They deliberately fail without that environment.
Use `pnpm verify` for end-to-end tests rather than a running development server.

Full isolated verification gate, including disposable PostgreSQL schema verification,
runtime verification, Playwright, and legacy migration upgrade verification:

```bash
pnpm verify
```

The gate creates unique per-run databases, launches a fresh native-HTTPS same-origin app on port 44174, provisions a synthetic owner/keyring and verifies real browser authentication. Test certificates, credentials, browser state and fake-mailbox files live only in an owned temporary directory and are removed after verification. Occupied ports fail closed; `VERIFY_API_PORT` and `VERIFY_WEB_PORT` select other distinct, non-canonical ports. Existing servers are never reused and candidate builds stay outside the preview's served `apps/web/dist`.

For verification on a host whose default PostgreSQL belongs to another project, run:

```bash
pnpm verify:local
```

This runner owns a temporary PostgreSQL 17 container on a random loopback port, forwards its exact container/database binding to every verification helper, then stops only that container. It uses installed Chrome when available; alternatively set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to an installed compatible browser. It does not modify the installation's Compose file or host database. The regular `pnpm verify` remains available for an already isolated Compose development environment. OpenSSL and a compatible browser are verification prerequisites; native deployment can use operator-supplied certificates.

See [administrator authentication and rollout](docs/admin-auth-completion.md) for the implemented API boundary, native TLS configuration, operator-only provisioning and remaining deployment steps.

## Trusted email code-step proof

After the normal migrations and bootstrap, open `/automations/email-summary` and choose **Run fake email fixture**. Three `transform` nodes execute real trusted TypeScript map/filter/reduce through the same engine and database-backed execution store. The inspector shows sequential input/output/error evidence and historical implementation/source/schema identity.

For machine-readable inspection, GET `/api/code-automations/email-summary/versions/1`. POST `/api/code-automations/email-summary/test-runs` with JSON `{ "version": 1, "input": [] }` produces an empty summary through all three nodes. Replace the input with the inspection response's fake fixture to exercise candidate selection. This endpoint accepts only explicitly registered automations and an explicit version; it does not accept source code or module paths.

See [the researched decision record](docs/code-steps-decision.md) for contracts, version scope and deferred work. No live mailbox mutation or model calls occur. The execution log means persisted lifecycle and I/O evidence, not console capture.

**Storage warning:** disposable sandbox replacement may preserve repository files
without preserving PostgreSQL volumes or run history. Verify independent backups
before relying on this setup for durable history. See [storage and recovery](docs/sandbox-storage-recovery.md).

## Repeated message events

The fake Email Triage endpoint supports explicit event admission in addition to repeatable manual tests. Event-mode duplicates return the existing run without another model/action execution. See [identity, retry boundaries and the API contract](docs/message-admission-decision.md). Migration 0002 adds a test-event partial unique index; existing manual test history is unchanged. Run `node scripts/verify-message-admission.mjs` for isolated, two-process HTTP/database verification.

## License

Atlas is licensed under the [European Union Public Licence v. 1.2](LICENSE).
Copied UI material retains its notices in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

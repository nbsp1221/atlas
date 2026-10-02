# Atlas administrator authentication

## Implemented path

`packages/db/src/auth-schema.ts` and migration 0006 define the owner, credential account, sessions and library verification store. The `auth_user` constraint permits only `atlas-owner`; credential accounts cannot store social tokens. Existing external-service credentials remain in their separate encrypted store.

`apps/api/src/auth` implements allowlisted email login, session inspection, logout and password changes. Every product API goes through owner middleware before route handlers; Settings writes and binding changes additionally require fresh authentication. Request bodies, methods, Origin, Fetch Metadata and transport are checked before library dispatch. Google may return by cross-site top-level GET, but still needs the initiating authenticated session and valid one-use state/PKCE.

Passwords and session revocation commit atomically. Auth mutations lock the owner row so old-password login cannot race past the password-change revocation. A failed replacement-session insert restores the original password hash and sessions and publishes no cookie. Unexpected library errors are sanitized before fallback console logging. No session cache or session renewal is enabled.

`apps/api/src/transport.ts` supports native TLS and serves compiled web assets from the same listener. Forwarded host/protocol headers are not trusted. API startup requires explicit `DATABASE_URL`, awaits credential-storage validation, and refuses configured authentication without TLS key/certificate files. The existing source-based workspace runtime is retained: `pnpm --filter api start` uses tsx, now a runtime dependency, because workspace package exports are TypeScript source.

The existing global login gate uses accessible Field controls, clears passwords, cancels cached private queries on logout and supports password rotation. API-key registration does not call a provider; verification/replacement and Google flows explain their external scope in the existing UI.

## Rollout after operator approval

1. Decide the installation's canonical HTTPS URL, native TLS certificate/key paths, listener host/port and reviewed web-build directory. Populate protected environment configuration using the variable names in `.env.example`; do not commit secret values.
2. Back up the canonical database and separately protect required encryption-key versions. Restore into an owned disposable database and verify records and decryption before approving canonical migration.
3. Apply the unapplied migrations with `pnpm --filter @workspace/db db:migrate`. Confirm the target database first; do not rerun bootstrap or provisioning against an existing installation blindly.
4. With explicit deployment configuration, invoke `pnpm --filter api provision-owner --apply` using protected stdin JSON containing `email`, `name` and `password`. Never place the password in command arguments, chat, source or logs. Duplicate provisioning fails without overwriting the owner.
5. Approve restarting the installation with `pnpm --filter api start`, and confirm HTTPS login, protected metadata and logout. Supply real provider credentials through Settings only after this transport/authentication path is established.

Actual external model/mail execution remains a later adapter task. Saving a Connection or immutable binding version does not turn fake test runs into live execution.

## Verification

Run `pnpm verify:local` for the isolated full gate, or `pnpm verify` when the
Compose PostgreSQL service is dedicated to this checkout. The gate covers
schema constraints, real Better Auth sessions, password-change rollback and
races, protected product routes, hostile requests, native-HTTPS browser login,
Connections, migration upgrades and fake automation recovery. All credentials
and provider transports in these checks are synthetic. Passing the gate does
not establish real provider connectivity or authorize deployment.

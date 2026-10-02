# Gmail message admission

Reviewed 2026-10-01.

Update: [archive action recovery](archive-recovery-decision.md) now adds a separate bounded worker only for newly enrolled archive actions. Duplicate admission itself remains observation-only; the historical no-recovery behavior below describes the admission change and still applies to old actions with no recovery record.
This change closes duplicate event execution in the existing database-backed runtime and explicit fake-event product path. It does not implement a Gmail watcher, OAuth, a durable work queue, or a general workflow platform.

## Research and selection

- [Gmail Message](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages) defines an immutable message ID. Thread ID groups messages; history ID describes the last modifying history record. Therefore our processing identity uses message ID, not thread/history ID.
- [Gmail push notifications](https://developers.google.com/workspace/gmail/api/guides/push) describe mailbox changes, with a history cursor. The Pub/Sub notification ID is unrelated to a Gmail message ID. Notifications may be repeated, delayed or dropped; archive can itself produce another mailbox change. A future ingress must expand notifications through history/message retrieval before submitting normalized message events. Notification/history IDs are evidence, not admission keys.
- [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect#an-id-tokens-payload) identifies Google subjects as stable across account email changes. Email addresses must not be account primary keys. Future live Gmail ingress must obtain and validate the actual target mailbox subject through the authenticated provider boundary, persist it as Connection.externalPrincipalType=google-sub plus externalPrincipalId, and reject missing/ambiguous identity. A string shape check in this code is NOT OAuth verification. A service-account subject is not the delegated target mailbox subject. No existing placeholder connection is assigned an invented Google account.
- [PostgreSQL INSERT](https://www.postgresql.org/docs/current/sql-insert.html) and [READ COMMITTED](https://www.postgresql.org/docs/current/transaction-iso.html#XACT-READ-COMMITTED) support unique-index conflict admission. INSERT ON CONFLICT DO NOTHING waits on a conflicting inserter but can have a snapshot that excludes its row. A separate following SELECT sees the committed winner at the normal READ COMMITTED boundary. We do not use a same-statement CTE fallback, check-then-insert, process-local lock, or conflict UPDATE.
- [AWS Builders' Library](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/) explains why identical payloads can express either a retry or a new intent, and why an existing resource should be identified on a repeated request. That distinction motivates an explicit event/manual contract. It does not make our DB transaction atomic with Gmail; unknown external outcomes remain unresolved.

## Domain and ERD impact

Reuse the existing nine entities. Run.idempotencyKey already had a live-mode unique index on (automation_id, idempotency_key), but the engine always inserted a Run and the manual fake endpoint never supplied a key.

Migration 0002 adds only runs_test_event_idempotency_uq on the same two columns for test-mode, non-null keys. There are no new tables/columns or relationships, no data rewrite/backfill, and no changed automation graph or code-step version. Live and test rows have separate index domains. Manual test runs retain null keys. Historical runs are never reassigned, merged, reset, or overwritten by admission.

The migration fails closed if an installation already has conflicting non-null test keys. Investigate those records; never delete them or rewrite history to force migration. Before applying to a non-disposable database, inspect duplicate keys, back up that database and review the migration. Existing null-key test history is unaffected. The upgrade gate checks both successful installation without row changes and a separate database with committed duplicate non-null test keys: actual migration fails with PostgreSQL 23505, rolls back, leaves both historical rows unchanged and does not leave the index installed.

## Identity

The workflow scope is Run.automationId. The losslessly encoded JSON tuple is:

    ["gmail-message-v1", environment, canonicalMailboxIdentity, GmailMessage.id]

Live uses a verified canonical Google mailbox subject. Fake-event mode uses an explicitly supplied fixture mailbox ResourceRef, with integrationKey=gmail, resourceType=mailbox and externalId equal to the fixture identity. This is simulated identity evidence, not a claim to have authenticated a Google account. The namespace is always fake for the HTTP test endpoint. There is no request option to switch it to live.

Connection is authority, not mailbox identity. Replacing or duplicating a grant cannot change the event key for the same logical mailbox. Connection IDs remain execution/trigger evidence. Graph version, history ID, notification ID and email contents do not change event identity. Identifier components are checked without case conversion or trimming; JSON encoding avoids delimiter collisions.

The helper gmailMessageIdentityFromConnection prepares the live identity contract for a future authenticated provider ingress. There is no live API route. It must not receive identity fields directly from an unauthenticated request, email aliases or the context-dependent value "me". Unknown identity fails closed.

## Atomic execution admission

ExecutionStore.claimRun inserts a queued Run using the unique index before execution. Only the returned created=true caller starts the run, nodes, model requests or external actions. A conflicting caller reads the existing row and returns admission=duplicate, its original run ID, current observed status and original version. It performs no lifecycle mutation or side effect. Status is a point-in-time observation; the existing GET run endpoint can show later progress.

After strict request and source-identity validation, a read-only lookup can return an existing event before current version/graph/binding preflight. This preserves original status/version even when the currently selected version is absent or invalid, or the current grant is unavailable. A miss does not authorize execution: new work still passes all preflight checks and the atomic claim arbitrates competing first deliveries. Future authenticated live ingress must authorize the actual mailbox before this lookup.

The same behavior applies to queued, running, succeeded, failed and cancelled runs. A failed run with an ActionExecution unknown/pending result is not resumed. A process crash after admission may leave queued/running evidence and zero or uncertain external effects; subsequent events do not seize it. Recovery needs a future explicit reconciliation design. There is no lease expiry, automatic whole-run retry or delete-and-recreate bypass.

Existing bounded model retries and linked node retries remain within the admitted run. Existing ActionExecution claim logic prevents another attempt for a claimed failed/unknown action. External provider operations are not covered by the database transaction: this is one admitted execution per retained key, not an exactly-once external delivery guarantee.

Deduplication lasts while the Run key remains in the database. Backup/retention policy must preserve that evidence. The existing disposable microVM storage limitation still applies.

## Product contract and reruns

POST /api/automations/email-triage/test-runs still creates an independent manual simulation when execution is omitted or is {kind:"manual"}. This keeps repeated intentional tests usable and backward compatible. Both are fake-only. Explicit event simulation uses:

    {
      "email": { "...normalized email fields...": "...", "messageId": "fixture-message-1" },
      "scenario": { "route": "archive" },
      "execution": {
        "kind": "event",
        "mailbox": {
          "integrationKey": "gmail",
          "resourceType": "mailbox",
          "externalId": "fixture-mailbox-A"
        },
        "historyId": "optional-history-cursor",
        "notificationId": "optional-delivery-id"
      }
    }

An event must supply its message ID; no random ID fallback is allowed. Malformed/unknown execution modes and ambiguous identity are rejected before a Run or side effect. The first admitted response is HTTP 201 with admission=created. Duplicates are HTTP 200 with admission=duplicate and simulation=null: a new fake world must not be presented as the original run's observed mailbox state. The original run evidence is available through GET /api/runs/:id.

A manual fake test may intentionally exercise the same fixture again, but it neither replaces an event claim nor permits a live retry. There is no live rerun endpoint. Replay remains the existing separate side-effect-suppressed concept; this change does not implement or relax it.

## Verification

Run `pnpm verify:local` for the complete isolated gate, including `scripts/verify-message-admission.mjs`. It uses the existing owned verification database guard and starts two independent HTTP worker processes against one fresh migrated and bootstrapped database. It never adopts/reset an existing database.

The regression suite checks sequential and 20-way simultaneous duplicates, original history preservation, independent messages/mailboxes/automations, changed history/delivery/version, unavailable/invalid current versions and missing grants, grant replacement, terminal and in-progress claims, failed and unknown-after-effect outcomes, manual rerun independence, malformed identity, collision-resistant key fields, and live/test namespaces without calling any real provider. Runtime unit tests reject every store mutation/model/handler invocation on a duplicate. The complete gate also covers existing code-step and neutral-token UI behavior.

Generated results are local ignored verification evidence. All model answers and mailbox effects used here are artificial fixtures; this proves execution admission, not Gmail adapter correctness or classification quality.

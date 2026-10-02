# Archive-only action recovery

Reviewed 2026-10-01 before implementation.

## Research and scope

[Gmail modify](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/modify) removes labels from a fixed message ID. [Gmail get](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get) retrieves that same message. Neither documents a transaction with our database or a conditional label update guarded by history ID. [Gmail error guidance](https://developers.google.com/workspace/gmail/api/guides/handle-errors) distinguishes 403 reasons: rate limits can be retried while authorization/domain policy errors require intervention, and recommends increasing retry delays beginning at one second. [AWS idempotent retries](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/) distinguishes a retry of the same intent from a new request and discusses late-arriving requests. These sources guide a conservative implementation; they do not establish exactly-once external effects.

Only the existing Email Triage archive branch is eligible. Notification and spam retain their current behavior. No live provider, OAuth, credentials, watcher, generic workflow engine, or new graph is introduced.

## ERD and implementation plan

Run -> NodeExecution -> ActionExecution relationships and Run admission identity stay unchanged. Add:

- ActionExecution 1 -> 0..1 ArchiveRecovery: mutable scheduling state, fixed message target, immutable policy/deadline/initial opaque revision, counters, next operation/time and last outcome
- ActionExecution 1 -> many ArchiveAttemptEvent: append-only dispatch-start, observed result, and interrupted dispatch evidence

ActionExecution continues to represent one logical action; NodeExecution continues to represent a graph step. Neither is reset to represent a provider retry. Finished attempt events are never rewritten. Historical rows and version references are not backfilled or adopted. The additive migration creates only these two tables and constraints/indexes.

The provider-independent engine gains only a suspension signal, caught without failing a still-running node/run. Email Triage owns recovery policy and its terminal archive/verify continuation through a narrow port. The composition explicitly installs this capability with fake adapters. Resume checks the stored version's archive -> verify_archive terminal shape before doing work and never calls the classifier, notification or spam handler.

One dedicated single-connection PostgreSQL client holds a session advisory lock while a bounded fake adapter operation runs. The backend PID is rechecked before storage/dispatch operations; a reconnect loses authority and fails closed. No expiring lease or fake external fencing guarantee is added. Dispatch-start is committed before the external call and records that interruption must reconcile. Process exit releases the session lock; the next worker appends interrupted evidence and GETs the same message. Losing a database session is not proof that a real external request stopped; live-provider enablement requires a separately reviewed adapter/cancellation contract.

## Policy and limits

Initial configurable engineering defaults: at most three modify dispatches, six GET dispatches, a 60-second intent deadline, one-second initial delay, exponential cap 8 seconds plus bounded jitter, and provider Retry-After as a minimum. A separate persisted write-not-before timestamp preserves that minimum across failed readbacks. Due times are capped at the intent deadline only to wake and stop, never to dispatch early. These are fake-world proof defaults, not a user-approved Gmail business policy. Budgets count starts, including interrupted calls.

An unknown modify outcome always transitions to GET. A failed GET retains uncertainty and can only schedule another bounded GET. INBOX absence records desired_state_observed and does not upgrade an unknown write to a causally proved success. INBOX presence permits a retry only within the original budget/deadline and with the original opaque revision unchanged. Run cancellation is rechecked after a delayed read and immediately before dispatch; terminalization preserves a cancelled Run. A changed revision conservatively stops old intent; even an unrelated Gmail history change could be a false positive. A revision does not identify a human's intention, and a GET/modify race cannot be eliminated by this API. Already completed recovery does not run again when INBOX is later re-added.

The fixture mailbox is durable only within the selected filesystem, per admitted Run, under the simulation package. Exclusive initialization plus a short append-only operation journal preserve the same artificial world across process restarts. GET adds only a read event, so it cannot overwrite a concurrent re-add or revision. It is not a production domain table or an actual Gmail mailbox. Missing/corrupt fixture state fails closed; recovery never invents a fresh mailbox. MicroVM replacement/storage risks remain in sandbox-storage-recovery.md.

## Verification plan

Controlled clock and scripted adapters exercise first success, before-effect transient failure, after-effect timeout with absent state, failed read then independent-process restart, present-state retry, permanent failure, budget/deadline exhaustion, observed re-add/change, pending duplicate admission, concurrent owners, and crashes around dispatch. Real PostgreSQL and a persistent fixture prove process restart continuity. Read models/UI expose next step and attempt history with existing tokens. Verification mismatch never becomes Verified. Full existing gates remain required. Canonical database migration/restart waits for independent review, logical backup, and restore verification.

## Current contract changes

Archive is now suspended at the existing admitted action node. Immediate success/after-effect reconciliation can still finish before the POST response; retryable failures return running with persisted next-step evidence. The API worker checks due archive records on startup and every 250ms, serially; stop waits for its active pass and clears its timer. Duplicate delivery continues to return the original Run without kicking recovery, creating a fixture, or modifying any execution record.

ActionExecution remains the summary of the latest known dispatch outcome, while append-only events retain every prior dispatch and result. Unknown + verified means a write's result is unknown but the desired state was observed. The UI explicitly calls this a verified state observation, not proof of causality. A write acknowledgement followed by an INBOX-present read now fails the Run with verification_mismatch.

This adds no public cancellation, manual retry, or live replay endpoint. A persisted cancellation already present in Run is honored; external re-adds are detectable only when observed through the adapter revision/state. The remaining read/write race is explicit. Process crashes before this action's recovery row was committed are outside action-level recovery: the admitted Run is not reconstructed or classified again. Existing historical failed/unknown actions without a recovery row are not adopted automatically.

Fake connections intentionally retain the established simulation preflight contract: provider identity must match; disabled placeholder grants do not imply live authorization and need no credentials. The worker rejects non-test Runs. Live authority refresh, mailbox authorization and provider cancellation are future adapter work and are not claimed here.

The fake fixture persists process-restart state with exclusive creation of an immutable initial snapshot and flushed, single-write O_APPEND events. Read counters and mailbox changes are reduced from ordered events, with no stale whole-state replacement. This is not a power-loss/volume-loss durability guarantee or a production mailbox store. Corrupt/missing state stops recovery rather than recreating the world. A real deployment needs the storage safeguards in sandbox-storage-recovery.md.


## Independent-review fixes

A provider result that decides completion now commits a terminal decision alongside its immutable result event in the same database transaction. If the process dies before branch finalization, the next worker finishes that saved decision before any new provider I/O, including after the deadline. It cannot reinterpret a permanent error or superseded observation as retryable. The final transaction rechecks and locks the original Run, action node and provider binding; superseded/cancelled context stops instead of claiming observation completion.

The fixture's former read-counter whole-file rewrite was replaced with the narrow append-only simulation journal. An IPC-controlled test pauses GET after reading its snapshot, re-adds INBOX from another process, then resumes GET. The read append preserves both the newer mailbox revision and INBOX state. This addresses a fixture storage race; it does not claim to eliminate Gmail's separate GET-to-modify race.

# Email archive/retain fake-world verification

Current update: [archive recovery](archive-recovery-decision.md) supersedes the original unknown/read-retry/mismatch limitations below for newly enrolled archive actions. Pending retry cases now use controlled clocks and independent processes in the archive-recovery matrix; the original browser matrix retains synchronous paths with updated expectations.

## Scope and existing product contract

Email Triage already accepts one normalized email through `POST /api/automations/email-triage/test-runs`. It resolves the stored AutomationVersion, performs binding preflight, executes the provider-independent engine with the existing handlers, and persists Run, NodeExecution, ModelInvocation and ActionExecution records. This verification reuses that path; it does not join the separate three-step email-summary proof into a new automation.

The classifications in these tests are **artificial fixture answers**, explicitly programmed into FakeModelAdapter. They demonstrate execution and branching correctness given a fake answer, not real model accuracy or a user-approved classification policy. In particular, low confidence is currently recorded evidence, not a retention threshold.

## Small changes

- FakeMailAdapter exposes immutable message state snapshots, archive attempt counts and verification-read counts. It can start already archived, simulate acknowledgement without a state change, or apply an effect before an unknown/lost response.
- FakeModelAdapter retains immutable request observations and can delay a response to test asynchronous run isolation.
- The existing simulation API returns `simulation` observations (before/after mailbox state, attempts, reads, model requests and notification count). Initial fake mailbox state is also saved in Run.triggerSnapshot. After-state observations are returned by the POST and saved in audit JSON; they are not a new persistent mailbox service. Normal archive readback remains persisted as ActionExecution.verificationEvidence.
- A simulation-only `disableExternalActions` option exercises the engine's existing suppression policy. The composition still installs fake adapters exclusively, with no way to supply a live adapter or credential.
- Run read models now read nested normalized sender/address and text while preserving legacy flat fields. Previously the readable sender/body was blank even though the raw input was persisted correctly.
- The existing inspector exposes each node's persisted model invocations and action execution/verification evidence, including failed attempts. Existing neutral visual tokens are reused.

No runtime engine, production email handler, automation graph/version, DB schema, integration identity, provider adapter, dependency or classification policy was changed.

## Research basis

Reviewed 2026-10-01 before extending fault fixtures:

- [Gmail users.messages.modify](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/modify): the official API modifies message labels and returns a Message on success. The fake world continues to represent archive as message state rather than delivery or deletion. This is a conceptual fixture, not a validated Gmail adapter.
- [AWS Step Functions error handling](https://docs.aws.amazon.com/step-functions/latest/dg/concepts-error-handling.html): retries match error classes and have bounded attempts; workflow completion, retries, and error handling are explicit concerns. This supports testing the existing distinction between model-provider retries, node retries, and unknown action outcomes rather than adding an unbounded retry path. No Step Functions library or architecture was adopted.

## Reproduce safely

From the repository root run `pnpm verify:local` for an owned temporary PostgreSQL
container, or `pnpm verify` when Compose PostgreSQL is dedicated to this checkout.
The full gate creates random exclusively owned databases, migrates and bootstraps
synthetic fixtures, starts fresh native-HTTPS servers and runs Playwright with one
worker. It cleans up only its own resources and never reuses the running preview.

## Evidence and assertions

`apps/web/tests/z-email-triage.spec.ts` writes run-specific evidence under the
ignored `audit/admin-auth/verification/<run-id>/` directory: scenario matrices,
contract-limit assertions, isolation checks and product screenshots. Generated
results are local evidence, not required source inputs.

All scenario Runs preserve the exact selected version and definition hash. Assertions verify input propagation into ModelInvocation, model sequence/node association, node lifecycle completion, Gmail archive identity and target, verification-to-node linkage, and absence of notification/spam branches. A verification retry creates another NodeExecution linked to its failed predecessor while archive remains one attempt. Provider retries stay in one classifier node. Concurrent requests keep their branch, input, model and action records separate.

The fixture matrix is exercised over real local HTTP against the real database-backed product API, not an HTTP stub or mock-call-only assertion. Fake external-world observations and persisted read models are checked independently. No network calls to Gmail, model providers or Telegram are part of these tests.

## Explicit limits and unmet outcomes

- Empty/no-eligible mailbox is not an Email Triage product input. The endpoint requires one normalized email. Empty batch input is rejected with HTTP 400 and creates no Run. The separate email-summary filter does not establish an integrated mailbox selection flow.
- The original manual-test contract repeats a fixture as two Runs and two archive attempts. The later explicit event-mode admission fix is documented in [message admission](message-admission-decision.md); repeated event-mode calls now return the existing Run. The fake archive state assignment is idempotent, while manual simulations intentionally remain independent. Each request creates a new fake world; the second repeated fixture is explicitly initialized archived, so this is not evidence of persistent mailbox state across requests.
- An unknown response remains ActionExecution.executionStatus=unknown and verificationStatus=pending even if the fake mailbox changed. The product stops without a duplicate attempt, but does not automatically reconcile by readback. A fake-adapter unit probe can observe either outcome independently; it does not upgrade the product result to verified.
- An archive response followed by actual readback mismatch gives execution succeeded and verification failed. The Run itself succeeds because existing lifecycle completion is independent of outcome verification. The UI must show that distinction.
- A fake no_action answer with low confidence retains the message. A fake archive answer with low confidence still archives: no uncertainty policy has been approved or implemented.
- Current Email Triage uses one logical classifier model, with retry attempts recorded separately. Overlapping asynchronous Runs are tested. This does not establish production accuracy, arbitrary parallel multi-model voting policy, provider authentication, polling, scheduling, crash recovery or durable microVM storage.

These gaps are reported as observed limitations, not silently counted as a complete production auto-archive workflow.

# Trusted code steps: minimal email proof

Decision date: 2026-09-30. Research preceded implementation.

## Research and choices

- [Mastra step contract](https://mastra.ai/reference/workflows/step): reuse the small id / input schema / output schema / execute pattern, not a new workflow framework.
- [n8n Code node modes](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.code): operate on the entire JSON array once per step. Native JavaScript map/filter/reduce is enough; no per-item task scheduler.
- [LangGraph node functions and edges](https://docs.langchain.com/oss/javascript/langgraph/graph-api): separate execution identity from graph node identity and routing. Existing Atlas nodes/edges, engine and store stay in place.
- [Trigger schemaTask](https://trigger.dev/docs/tasks/schemaTask): validate before calling code; invalid initial request is rejected before Run creation, and step validation failures do not retry.
- [Trigger versions](https://trigger.dev/docs/versioning), [Temporal worker versioning](https://docs.temporal.io/worker-versioning), and [Inngest versioning](https://www.inngest.com/docs/learn/versioning): a step ID alone does not pin executable code. Resolve an exact registered identity or refuse execution. This proof does not implement those systems' durable orchestration or deployment routing.
- [Zod parsing](https://zod.dev/basics): keep the already installed Zod. No new validation library, Standard Schema abstraction, SDK, editor, compiler or workflow engine dependency was added.

## Contract and semantics

`defineCodeStep` adapts a trusted, typed, self-contained TypeScript callable to the existing NodeHandler. The reusable runtime adapter accepts a minimal structural parser; this example supplies strict Zod schemas, without refinements/transforms. The full array is normalized with map, filtered to read, unstarred newsletters, and reduced with an explicit empty accumulator to count, IDs and sender groups. Input fixture includes unread, starred, personal, duplicate-sender and other-sender emails.

`transform` is an honest new NodeKind: no model decision or external action is implied. Optional `entryNodeKey` starts this graph directly. There are exactly three NodeExecutions, with no synthetic trigger or terminal execution. Legacy graphs retain their single-trigger entry behavior. Explicit entry and trigger nodes cannot be combined.

Input and output are checked at runtime; parsed values are what the callable/downstream receives. Output success is recorded only after validation. Errors retain phase, code and structured issues. A function exception ends the run and does not schedule downstream work. JSON null, false, zero, empty string and empty array are real outputs and propagate; omitting the output property in legacy handlers remains pass-through. Undefined, non-finite numbers, bigint, cycles, functions, class instances, sparse arrays, accessors and lossy JSON object properties are rejected.

## Exact identity, bounded honestly

Every graph node stores its registered implementation ID, explicit version, actual callable source obtained from the function that executes, raw UTF-8 callable source SHA-256, strict JSON schema metadata, installed Zod version, adapter-source SHA-256, and canonical manifest SHA-256. The callable source is JavaScript compiled from the trusted TypeScript, labelled as such; it is not a hand-maintained snippet. Implementations are deliberately self-contained: only parameters, local variables and standard JavaScript built-ins, with no captured variables or imported runtime helpers. Adding helpers requires extending the artifact identity before registering that implementation.

The immutable AutomationVersion graph and its definition hash pin that manifest. Preflight verifies the stored graph hash, exact registered implementation metadata, and registered graph topology before creating a Run. No latest-version fallback exists. A source/adapter/schema/version mismatch requires a new registered graph version; an unavailable old version fails closed. Old run details show metadata from their own stored graph, never from the current callable. Source snapshots remain inspectable even when the old executable is no longer installed.

The verified development execution uses source-based tsx and reads the adjacent `code-step.ts` adapter file. Standalone production packaging/startup is not verified; a future bundle must supply its own reproducible artifact manifest rather than assuming this source path exists.

This is a bounded code-step identity, not a complete build/container/engine/Node runtime lock or a guarantee of cross-runtime replay. Zod dependency identity is the installed exact version, not a transitive supply-chain proof. Same-name functions that capture changing external state are outside this registration contract. No arbitrary client code is evaluated and no TypeScript compiler runs on API input.

## Data and interface

Existing Run, NodeExecution and AutomationVersion records are sufficient. No database migration or extra persistence model was introduced. The UI's execution log is the existing persisted start/finish/status/input/output/error evidence, not captured console output; it says so explicitly. Graph and run source/schema details use React text rendering, never HTML insertion. Email Triage remains supported.

- GET `/api/code-automations/email-summary/versions/1`: inspect exact registered version, graph, source/schema metadata and fixed fake fixture
- POST `/api/code-automations/email-summary/test-runs`: strict JSON body `{ "version": 1, "input": [...] }`; version is mandatory, automation must be explicitly registered
- GET `/api/runs/{runId}`: complete sequential per-step I/O, phase errors and historical implementation identity
- `/automations/email-summary`: three-node graph and Run fake email fixture button

Invalid JSON/request or initial input: 400; unknown automation/version: 404; unavailable/mismatched implementation or graph: 409. An accepted execution returns 201 with the real run ID and succeeded/failed status, including output/error. The current proof is synchronous, local, test-mode-only, with zero mail actions and model calls. There is no embedded AI/chat, arbitrary module path, uploaded code, live email connection, new credential, external communication, publishing, or generic n8n clone. External coding agents could later call this machine-readable API; authoring, deployment, untrusted-code sandboxing, console capture, scheduling, durability and retention are deferred. Administrator authentication is described in [administrator setup](admin-auth-completion.md).

## Verification

Focused runtime/automation/API tests plus the existing isolated full verification gate cover fixture results, empty/no-match runs, actual DB records, exact identities, invalid requests/graphs/implementations, validation/function failures, null/false/zero/empty propagation, XSS-safe UI, and Email Triage compatibility. Run `pnpm verify:local` to reproduce the full gate, including `packages/automation-runtime/test/code-step.test.ts`, `packages/automations/test/email-summary.test.ts` and `apps/api/test/code-automations.test.ts`. This design record describes coverage, not the result of a particular run.

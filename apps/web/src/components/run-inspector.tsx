import type { RunActionExecution, RunArchiveAttempt } from "@workspace/domain"
import { JsonEvidence, CodeIdentity } from "./step-evidence"
import { useRun } from "@/api/queries"
import { formatSeoulTime } from "@/lib/time"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@workspace/ui/components/sheet"
import { Skeleton } from "@workspace/ui/components/skeleton"

function Block({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-3">
      <h3 className="font-mono text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      {children}
    </section>
  )
}

function recoveryLabel(action: RunActionExecution) {
  const recovery = action.archiveRecovery
  if (recovery?.state === "pending") return "Archive recovery pending"
  if (recovery?.state === "stopped") return "Archive recovery stopped"
  if (recovery?.state === "observed") {
    return action.verificationStatus === "verified"
      ? "Verified state observation"
      : `Desired state observed · verification ${action.verificationStatus}`
  }
  return null
}

function operationLabel(operation: "modify" | "get" | "stop") {
  return operation === "modify"
    ? "Write (remove INBOX)"
    : operation === "get"
      ? "Read message state"
      : "Stop recovery"
}

function readableCode(code: unknown) {
  if (typeof code !== "string") return "No outcome recorded"
  if (code === "desired_state_observed")
    return "Desired state observed (INBOX absent)"
  return code
    .replaceAll("_", " ")
    .replace(/^./, (letter) => letter.toUpperCase())
}

function attemptLabel(attempt: RunArchiveAttempt) {
  const phase = {
    started: "dispatch started",
    result: "result recorded",
    interrupted: "dispatch interrupted",
  }[attempt.phase]
  return `${operationLabel(attempt.operation)}${attempt.operation === "stop" ? "" : ` · attempt ${attempt.attempt}`} · ${phase}`
}

function RecoveryTime({ value }: { value: string }) {
  const label = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value))
  return (
    <time dateTime={value} title={value}>
      {label} KST
    </time>
  )
}

function ArchiveRecoveryEvidence({ action }: { action: RunActionExecution }) {
  const recovery = action.archiveRecovery
  if (!recovery) return null
  const attempts = action.archiveAttempts ?? []

  return (
    <section className="mt-3 space-y-3" data-testid="archive-recovery">
      <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-2 rounded border bg-muted/20 p-3 text-xs sm:grid-cols-[108px_minmax(0,1fr)]">
        <dt className="text-muted-foreground">Recovery</dt>
        <dd>{recoveryLabel(action)}</dd>
        <dt className="text-muted-foreground">Message</dt>
        <dd className="font-mono break-all">{recovery.messageId}</dd>
        <dt className="text-muted-foreground">Next operation</dt>
        <dd>
          {recovery.state === "pending"
            ? operationLabel(recovery.nextOperation)
            : "None · recovery finished"}
        </dd>
        <dt className="text-muted-foreground">Next due</dt>
        <dd>
          {recovery.nextAttemptAt ? (
            <RecoveryTime value={recovery.nextAttemptAt} />
          ) : (
            "Not scheduled"
          )}
        </dd>
        <dt className="text-muted-foreground">Deadline</dt>
        <dd>
          <RecoveryTime value={recovery.deadlineAt} />
        </dd>
        <dt className="text-muted-foreground">Write attempts</dt>
        <dd>
          {recovery.writeAttempts} / {recovery.policy.maxWrites}
        </dd>
        <dt className="text-muted-foreground">Read attempts</dt>
        <dd>
          {recovery.readAttempts} / {recovery.policy.maxReads}
        </dd>
        <dt className="text-muted-foreground">Last write</dt>
        <dd>{recovery.lastWriteOutcome ?? "Not dispatched"}</dd>
        <dt className="text-muted-foreground">Last outcome</dt>
        <dd>{readableCode(recovery.lastOutcome?.code)}</dd>
        {recovery.inFlightOperation ? (
          <>
            <dt className="text-muted-foreground">In flight</dt>
            <dd>
              {operationLabel(recovery.inFlightOperation)} · attempt{" "}
              {recovery.inFlightAttempt}
            </dd>
          </>
        ) : null}
      </dl>
      {recovery.state === "observed" ? (
        <p className="text-xs text-muted-foreground">
          Readback observed INBOX absent. This verifies the observed state; it
          does not establish that this write caused it.
          {recovery.lastWriteOutcome === "unknown"
            ? " The write outcome remains unknown."
            : ""}
        </p>
      ) : null}
      <details data-testid="archive-attempt-history">
        <summary className="cursor-pointer text-xs">
          Archive attempt history ({attempts.length})
        </summary>
        <p className="mt-2 text-xs text-muted-foreground">
          Immutable events in recorded order. Attempt counts include interrupted
          dispatches.
        </p>
        <ol className="mt-3 space-y-3">
          {attempts.map((attempt) => (
            <li
              key={attempt.id}
              className="rounded border p-3"
              data-testid="archive-attempt-event"
            >
              <details>
                <summary className="cursor-pointer text-xs">
                  {attempt.sequence}. {attemptLabel(attempt)}
                </summary>
                <div className="mt-2 space-y-2">
                  <p className="text-xs break-all">
                    Recorded {attempt.createdAt}
                    <br />
                    Event {attempt.id}
                  </p>
                  <JsonEvidence
                    title="Immutable attempt evidence"
                    value={attempt.evidence}
                  />
                </div>
              </details>
            </li>
          ))}
        </ol>
      </details>
    </section>
  )
}

export function RunInspector({
  runId,
  open,
  onOpenChange,
}: {
  runId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const query = useRun(runId)
  const run = query.data

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-[min(94vw,440px)] gap-0 overflow-y-auto border-border bg-background sm:max-w-[440px]"
      >
        {!run && open ? (
          <div className="space-y-4 p-5">
            <Skeleton className="h-8 w-56" />
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-52 w-full" />
          </div>
        ) : null}

        {run ? (
          <>
            <SheetHeader className="border-b px-5 py-5">
              <SheetTitle className="pr-8 text-lg">{run.subject}</SheetTitle>
              <SheetDescription className="text-sm">
                {run.automationName} · {run.mode.toUpperCase()} · {run.sender} ·{" "}
                {formatSeoulTime(run.occurredAt, true)}
              </SheetDescription>
            </SheetHeader>

            <div className="space-y-8 px-5 py-6">
              <Block title="Execution log">
                <p className="text-sm">
                  v{run.automationVersion} · {run.status} · {run.latencyMs}ms
                </p>
                <p className="font-mono text-xs break-all">
                  Definition SHA-256: {run.definitionHash}
                </p>
                <JsonEvidence title="Run input" value={run.input} />
                <JsonEvidence title="Run output" value={run.output} />
                <JsonEvidence title="Run error" value={run.error} />
                <ol className="space-y-4">
                  {run.nodeExecutions.map((node) => (
                    <li
                      key={node.id}
                      className="rounded border p-3"
                      data-testid="step-execution"
                    >
                      <details>
                        <summary className="cursor-pointer text-sm">
                          {node.sequence}. {node.nodeKey} · {node.nodeKind} ·{" "}
                          {node.status}
                        </summary>
                        <div className="mt-3 space-y-3">
                          <p className="text-xs break-all">
                            Started {node.startedAt}
                            <br />
                            Finished {node.finishedAt ?? "pending"}
                            <br />
                            Execution {node.id}
                          </p>
                          <JsonEvidence title="Step input" value={node.input} />
                          <JsonEvidence
                            title="Step output"
                            value={node.output}
                          />
                          <JsonEvidence title="Step error" value={node.error} />
                          {run.modelInvocations
                            .filter(
                              (model) => model.nodeExecutionId === node.id
                            )
                            .map((model) => (
                              <details
                                key={model.id}
                                data-testid="model-invocation"
                              >
                                <summary className="cursor-pointer text-xs">
                                  Model {model.sequence} · {model.status}
                                </summary>
                                <p
                                  className="mt-2 text-xs break-all"
                                  data-testid="model-connection-evidence"
                                >
                                  Configured connection ID:{" "}
                                  {model.connectionId ??
                                    "Not recorded (fake or legacy invocation)"}
                                </p>
                                <JsonEvidence
                                  title="Model invocation evidence"
                                  value={model}
                                />
                              </details>
                            ))}
                          {run.actionExecutions
                            .filter(
                              (action) => action.nodeExecutionId === node.id
                            )
                            .map((action) => (
                              <details
                                key={action.id}
                                data-testid="action-execution"
                              >
                                <summary className="cursor-pointer text-xs">
                                  Action {action.sequence} ·{" "}
                                  {recoveryLabel(action)
                                    ? `${recoveryLabel(action)} · write ${action.executionStatus}`
                                    : `${action.executionStatus} · verification ${action.verificationStatus}`}
                                </summary>
                                <ArchiveRecoveryEvidence action={action} />
                                <JsonEvidence
                                  title="Action execution evidence"
                                  value={action}
                                />
                              </details>
                            ))}
                          {node.implementation && (
                            <CodeIdentity value={node.implementation} />
                          )}
                        </div>
                      </details>
                    </li>
                  ))}
                </ol>
                <p className="text-xs text-muted-foreground">
                  Persisted lifecycle and I/O log. Console capture is not
                  enabled. Execution completion and outcome verification are
                  separate.
                </p>
              </Block>
              {run.automationId === "email-triage" && (
                <>
                  <Block title="Input">
                    <div className="space-y-3 rounded-md border bg-muted/20 p-4">
                      <dl className="grid grid-cols-[72px_1fr] gap-y-2 text-xs">
                        <dt className="text-muted-foreground">From</dt>
                        <dd className="min-w-0 truncate font-mono">
                          {run.senderEmail}
                        </dd>
                        <dt className="text-muted-foreground">Subject</dt>
                        <dd>{run.subject}</dd>
                      </dl>
                      {run.body ? (
                        <p className="border-t pt-3 text-sm leading-6 whitespace-pre-wrap text-foreground/80">
                          {run.body}
                        </p>
                      ) : null}
                    </div>
                  </Block>

                  <Block title="Decision record">
                    <dl className="grid grid-cols-[108px_1fr] gap-y-3 rounded-md border bg-muted/20 p-4 text-sm">
                      <dt className="text-muted-foreground">Model</dt>
                      <dd className="font-mono text-xs">{run.model}</dd>
                      <dt className="text-muted-foreground">Prompt</dt>
                      <dd className="font-mono text-xs">{run.prompt}</dd>
                      <dt className="text-muted-foreground">Route</dt>
                      <dd className="font-mono text-xs">{run.route}</dd>
                      <dt className="text-muted-foreground">Reason</dt>
                      <dd className="text-xs">{run.reasonSummary}</dd>
                      <dt className="text-muted-foreground">Latency</dt>
                      <dd className="font-mono text-xs">{run.latencyMs}ms</dd>
                      {Object.entries(run.usageDetails).map(([key, value]) => (
                        <div className="contents" key={key}>
                          <dt className="text-muted-foreground">{key}</dt>
                          <dd className="font-mono text-xs">{value}</dd>
                        </div>
                      ))}
                      <dt className="text-muted-foreground">Cost</dt>
                      <dd className="font-mono text-xs">
                        {"$" + run.costUsd.toFixed(6)}
                      </dd>
                    </dl>
                  </Block>

                  <Block title="Outcome">
                    <dl className="grid grid-cols-[108px_1fr] gap-y-3 rounded-md border bg-muted/20 p-4 text-sm">
                      <dt className="text-muted-foreground">Action</dt>
                      <dd className="font-mono text-xs">{run.action}</dd>
                      <dt className="text-muted-foreground">Execution</dt>
                      <dd className="font-mono text-xs">{run.execution}</dd>
                      <dt className="text-muted-foreground">Verification</dt>
                      <dd className="font-mono text-xs">
                        {run.actionExecutions.some(
                          (action) =>
                            action.archiveRecovery?.state === "stopped"
                        )
                          ? "Archive recovery stopped"
                          : run.actionExecutions.some(
                                (action) =>
                                  action.archiveRecovery?.state === "pending"
                              )
                            ? "Archive recovery pending"
                            : run.verification === "verified" &&
                                run.actionExecutions.some(
                                  (action) =>
                                    action.archiveRecovery?.state === "observed"
                                )
                              ? "Verified state observation"
                              : run.verification}
                      </dd>
                      <dt className="text-muted-foreground">Evidence</dt>
                      <dd className="font-mono text-xs break-all">
                        {run.evidence}
                      </dd>
                    </dl>
                  </Block>
                </>
              )}
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

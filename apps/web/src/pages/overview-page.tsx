import * as React from "react"
import { Link } from "react-router-dom"
import {
  useAutomations,
  useConnections,
  useOverview,
  useRuns,
} from "@/api/queries"
import { Badge } from "@workspace/ui/components/badge"
import { Skeleton } from "@workspace/ui/components/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"
import { RunInspector } from "@/components/run-inspector"
import { formatSeoulTime } from "@/lib/time"

function Metric({
  label,
  value,
  hint,
}: {
  label: string
  value: string
  hint: string
}) {
  return (
    <div className="min-w-0 px-4 py-4 first:pl-0 sm:px-5">
      <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </div>
      <div className="mt-1.5 text-2xl tracking-tight">{value}</div>
      <div className="mt-1 font-mono text-xs text-muted-foreground">{hint}</div>
    </div>
  )
}

export function OverviewPage() {
  const overview = useOverview()
  const automations = useAutomations()
  const runs = useRuns()
  const connections = useConnections()
  const [selectedRunId, setSelectedRunId] = React.useState<string | null>(null)

  if (!overview.data || !automations.data || !runs.data || !connections.data) {
    return (
      <div className="mx-auto w-full max-w-[1180px] space-y-4 p-5 sm:p-8">
        <Skeleton className="h-10 w-44" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-72 w-full" />
      </div>
    )
  }

  const o = overview.data
  const automation = automations.data[0]
  const recent = runs.data.slice(0, 3)
  const attention = runs.data.find((run) =>
    ["unverified", "failed", "pending"].includes(run.verification)
  )
  const needsAttention = o.attentionCount > 0

  return (
    <>
      <div className="mx-auto w-full max-w-[1180px] px-5 py-6 sm:px-8 sm:py-9">
        <div className="mb-7 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-medium tracking-[-.035em]">
              Overview
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              System-wide health, evidence and operating cost.
            </p>
          </div>
          <Badge
            variant="outline"
            className={
              "shrink-0 font-mono " +
              (needsAttention
                ? "border-amber-900/70 text-amber-400"
                : "border-emerald-900/70 text-emerald-400")
            }
          >
            {needsAttention
              ? "NEEDS ATTENTION"
              : o.runs24h === 0
                ? "NO RUN DATA"
                : "HEALTHY"}
          </Badge>
        </div>

        <div className="mb-8 grid grid-cols-2 divide-x divide-y border-y sm:grid-cols-4 sm:divide-y-0">
          <Metric
            label="Runs"
            value={String(o.runs24h)}
            hint={"24h · " + o.failed24h + " failed"}
          />
          <Metric
            label="Verification rate"
            value={
              o.totalOutcomes === 0
                ? "—"
                : ((o.verifiedOutcomes / o.totalOutcomes) * 100).toFixed(1) +
                  "%"
            }
            hint={
              o.verifiedOutcomes + " / " + o.totalOutcomes + " side effects"
            }
          />
          <Metric
            label="Model cost"
            value={"$" + o.cost24hUsd.toFixed(4)}
            hint="24h · all automations"
          />
          <Metric
            label="Needs attention"
            value={String(o.attentionCount)}
            hint="unverified side effect"
          />
        </div>

        <div className="grid gap-8 lg:grid-cols-[minmax(0,1.6fr)_300px]">
          <div className="min-w-0 space-y-8">
            {attention && (
              <section>
                <div className="mb-2 flex items-baseline justify-between gap-4">
                  <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                    Needs attention
                  </h2>
                  <span className="text-xs text-muted-foreground">1 item</span>
                </div>
                <button
                  onClick={() => setSelectedRunId(attention.id)}
                  className="flex w-full items-center justify-between gap-4 border-y border-amber-900/60 bg-amber-950/10 px-3 py-3 text-left hover:bg-amber-950/20 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">
                      {attention.automationName} · {attention.id}
                    </div>
                    <div className="mt-1 text-xs leading-5 text-amber-200/60">
                      Action succeeded, but the side effect could not be
                      independently verified.
                    </div>
                  </div>
                  <span className="shrink-0 font-mono text-xs text-amber-400">
                    UNVERIFIED
                  </span>
                </button>
              </section>
            )}

            <section>
              <div className="mb-2 flex items-baseline justify-between gap-4">
                <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  Automations
                </h2>
                <span className="text-xs text-muted-foreground">
                  {
                    automations.data.filter((item) => item.status === "active")
                      .length
                  }{" "}
                  active
                </span>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs uppercase">
                      Automation
                    </TableHead>
                    <TableHead className="hidden text-xs uppercase sm:table-cell">
                      Version
                    </TableHead>
                    <TableHead className="hidden text-xs uppercase md:table-cell">
                      Model
                    </TableHead>
                    <TableHead className="text-xs uppercase">
                      Verification
                    </TableHead>
                    <TableHead className="hidden text-xs uppercase md:table-cell">
                      24h cost
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow>
                    <TableCell>
                      <Link
                        to={"/automations/" + automation.id}
                        className="block rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      >
                        <div className="flex items-center gap-2 text-sm font-medium">
                          {automation.name}
                          <Badge variant="outline" className="font-mono">
                            {automation.status.toUpperCase()}
                          </Badge>
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          Incoming mail routing
                        </div>
                      </Link>
                    </TableCell>
                    <TableCell className="hidden font-mono text-xs sm:table-cell">
                      v{automation.version}
                    </TableCell>
                    <TableCell className="hidden font-mono text-xs md:table-cell">
                      {automation.model}
                    </TableCell>
                    <TableCell className="text-xs text-amber-400">
                      {automation.verifiedRate === null
                        ? "—"
                        : automation.verifiedRate + "%"}
                    </TableCell>
                    <TableCell className="hidden font-mono text-xs md:table-cell">
                      {"$" + automation.cost24hUsd.toFixed(4)}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </section>

            <section>
              <div className="mb-2 flex items-baseline justify-between gap-4">
                <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  Recent runs
                </h2>
                <Link
                  to="/runs"
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  View all
                </Link>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-16 text-xs uppercase">
                      Time
                    </TableHead>
                    <TableHead className="text-xs uppercase">Input</TableHead>
                    <TableHead className="hidden text-xs uppercase sm:table-cell">
                      Route
                    </TableHead>
                    <TableHead className="hidden text-xs uppercase md:table-cell">
                      Model
                    </TableHead>
                    <TableHead className="hidden text-xs uppercase sm:table-cell">
                      Outcome
                    </TableHead>
                    <TableHead className="hidden text-xs uppercase lg:table-cell">
                      Latency
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recent.map((run) => (
                    <TableRow
                      key={run.id}
                      className="cursor-pointer"
                      tabIndex={0}
                      role="button"
                      onClick={() => setSelectedRunId(run.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault()
                          setSelectedRunId(run.id)
                        }
                      }}
                    >
                      <TableCell className="font-mono text-xs">
                        {formatSeoulTime(run.occurredAt)}
                      </TableCell>
                      <TableCell>
                        <div className="max-w-[32rem] truncate text-sm font-medium">
                          {run.subject}
                        </div>
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          {run.sender}
                        </div>
                        <div className="mt-1 flex items-center gap-2 text-xs sm:hidden">
                          <span className="font-mono text-foreground/75">
                            {run.route}
                          </span>
                          <span
                            className={
                              run.verification === "unverified"
                                ? "text-amber-400"
                                : "text-emerald-400"
                            }
                          >
                            {run.verification}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="hidden font-mono text-xs sm:table-cell">
                        {run.route}
                      </TableCell>
                      <TableCell className="hidden font-mono text-xs md:table-cell">
                        {run.model}
                      </TableCell>
                      <TableCell
                        className={
                          "hidden text-xs sm:table-cell " +
                          (run.verification === "unverified"
                            ? "text-amber-400"
                            : "text-emerald-400")
                        }
                      >
                        {run.verification}
                      </TableCell>
                      <TableCell className="hidden font-mono text-xs lg:table-cell">
                        {run.latencyMs}ms
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </section>
          </div>

          <aside className="border-t pt-7 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-7">
            <section className="border-b pb-6">
              <h2 className="mb-4 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                Current baseline
              </h2>
              <dl className="space-y-3 text-sm">
                <div className="flex justify-between gap-6">
                  <dt className="text-muted-foreground">{automation.name}</dt>
                  <dd>v{automation.version}</dd>
                </div>
                <div className="flex justify-between gap-6">
                  <dt className="text-muted-foreground">Classifier</dt>
                  <dd>
                    <Badge variant="outline" className="font-mono">
                      {automation.model}
                    </Badge>
                  </dd>
                </div>
                <div className="flex justify-between gap-6">
                  <dt className="text-muted-foreground">Prompt</dt>
                  <dd className="max-w-44 truncate font-mono text-xs">
                    {automation.graph.nodes.find(
                      (node) => node.kind === "decision"
                    )?.prompt ?? "—"}
                  </dd>
                </div>
                <div className="flex justify-between gap-6">
                  <dt className="text-muted-foreground">Version created</dt>
                  <dd className="font-mono text-xs">
                    {new Date(automation.versionCreatedAt).toLocaleDateString(
                      "en-CA"
                    )}
                  </dd>
                </div>
              </dl>
            </section>

            <section className="border-b py-6">
              <h2 className="mb-3 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                Evidence retention
              </h2>
              <p className="text-sm leading-6 text-muted-foreground">
                Execution inputs and outcomes are retained so future model
                changes can be replayed against the same evidence.
              </p>
            </section>

            <section className="pt-6">
              <h2 className="mb-4 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                Connections
              </h2>
              <dl className="space-y-3 text-sm">
                {connections.data.map((connection) => (
                  <div
                    key={connection.id}
                    className="flex justify-between gap-6"
                  >
                    <dt className="text-muted-foreground">{connection.label}</dt>
                    <dd
                      className={
                        connection.status === "connected"
                          ? "text-emerald-400"
                          : connection.status === "error"
                            ? "text-red-400"
                            : "text-muted-foreground"
                      }
                    >
                      {connection.status}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          </aside>
        </div>
      </div>
      <RunInspector
        runId={selectedRunId}
        open={Boolean(selectedRunId)}
        onOpenChange={(open) => !open && setSelectedRunId(null)}
      />
    </>
  )
}

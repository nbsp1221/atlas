import { AutomationConnections } from "@/components/automation-connections"
import { CodeIdentity } from "@/components/step-evidence"
import { CodeFixtureRun } from "@/components/code-fixture-run"
import * as React from "react"
import { useNavigate, useParams } from "react-router-dom"
import { useAutomation } from "@/api/queries"
import { AutomationGraph } from "@/components/automation-graph/automation-graph"
import { Badge } from "@workspace/ui/components/badge"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@workspace/ui/components/sheet"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@workspace/ui/components/tabs"
import { useIsMobile } from "@workspace/ui/hooks/use-mobile"
import type { AutomationNode } from "@workspace/domain"

function NodeDetails({
  node,
  definitionHash,
  routes,
}: {
  node: AutomationNode
  definitionHash: string
  routes: string[]
}) {
  return (
    <div className="space-y-7 px-5 py-5">
      {node.implementation && <CodeIdentity value={node.implementation} />}
      <section>
        <h2 className="mb-3 font-mono text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Runtime
        </h2>
        <dl className="text-sm">
          <div className="grid grid-cols-[96px_1fr] border-b py-2.5">
            <dt className="text-muted-foreground">Type</dt>
            <dd className="capitalize">{node.kind}</dd>
          </div>
          <div className="grid grid-cols-[96px_1fr] border-b py-2.5">
            <dt className="text-muted-foreground">Model</dt>
            <dd>{node.model ?? "—"}</dd>
          </div>
          <div className="grid grid-cols-[96px_1fr] border-b py-2.5">
            <dt className="text-muted-foreground">Prompt</dt>
            <dd className="font-mono text-xs">{node.prompt ?? "—"}</dd>
          </div>
          <div className="grid grid-cols-[96px_1fr] border-b py-2.5">
            <dt className="text-muted-foreground">Definition</dt>
            <dd className="truncate font-mono text-xs">
              sha: {definitionHash.slice(0, 7)}
            </dd>
          </div>
        </dl>
      </section>

      {node.kind === "decision" && (
        <section>
          <h2 className="mb-3 font-mono text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Routes
          </h2>
          <div className="flex flex-wrap gap-1.5">
            {routes.map((route) => (
              <Badge
                key={route}
                variant="outline"
                className="font-mono text-muted-foreground"
              >
                {route}
              </Badge>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-3 font-mono text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Observed / 24h
        </h2>
        <dl className="text-sm">
          <div className="grid grid-cols-[96px_1fr] border-b py-2.5">
            <dt className="text-muted-foreground">Executions</dt>
            <dd>{node.executions}</dd>
          </div>
          <div className="grid grid-cols-[96px_1fr] border-b py-2.5">
            <dt className="text-muted-foreground">Median</dt>
            <dd className="font-mono text-xs">
              {node.medianLatencyMs ? node.medianLatencyMs + " ms" : "—"}
            </dd>
          </div>
          <div className="grid grid-cols-[96px_1fr] border-b py-2.5">
            <dt className="text-muted-foreground">Cost</dt>
            <dd className="font-mono text-xs">
              {node.costUsd ? "$" + node.costUsd.toFixed(4) : "—"}
            </dd>
          </div>
          <div className="grid grid-cols-[96px_1fr] border-b py-2.5">
            <dt className="text-muted-foreground">Health</dt>
            <dd
              className={
                node.health === "attention"
                  ? "text-amber-400"
                  : node.health === "healthy"
                    ? "text-emerald-400"
                    : "text-muted-foreground"
              }
            >
              {node.health}
            </dd>
          </div>
        </dl>
      </section>
    </div>
  )
}

export function AutomationPage() {
  const params = useParams()
  const navigate = useNavigate()
  const id = params.id ?? "email-triage"
  const query = useAutomation(id)
  const isMobile = useIsMobile()
  const [selectedId, setSelectedId] = React.useState("classify_email")
  const [mobileInspectorOpen, setMobileInspectorOpen] = React.useState(false)

  if (!query.data) {
    return (
      <div className="space-y-4 p-5 sm:p-8">
        <Skeleton className="h-10 w-52" />
        <Skeleton className="h-[70vh] w-full" />
      </div>
    )
  }

  const automation = query.data
  const node =
    automation.graph.nodes.find((item) => item.id === selectedId) ??
    automation.graph.nodes.find((item) => item.kind === "decision") ??
    automation.graph.nodes[0]
  const needsAttention = automation.graph.nodes.some(
    (item) => item.health === "attention"
  )
  const hasRunData = automation.runs24h > 0
  const selectedRoutes = automation.graph.edges
    .filter((edge) => edge.source === node.id && edge.label)
    .map((edge) => edge.label!)

  const handleSelect = (nextNode: AutomationNode) => {
    setSelectedId(nextNode.id)
    if (isMobile) setMobileInspectorOpen(true)
  }

  return (
    <>
      <div className="flex h-[calc(100svh-3rem)] min-h-[620px] flex-col overflow-hidden">
        <div className="border-b px-5 py-4 sm:px-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-medium tracking-[-.03em]">
                  {automation.name}
                </h1>
                <Badge
                  variant="outline"
                  className={
                    automation.status !== "active"
                      ? "font-mono text-muted-foreground"
                      : needsAttention
                        ? "border-amber-900/70 font-mono text-amber-400"
                        : hasRunData
                          ? "border-emerald-900/70 font-mono text-emerald-400"
                          : "font-mono text-muted-foreground"
                  }
                >
                  {automation.status !== "active"
                    ? automation.status.toUpperCase()
                    : needsAttention
                      ? "NEEDS ATTENTION"
                      : hasRunData
                        ? "HEALTHY"
                        : "NO RUN DATA"}
                </Badge>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                v{automation.version} · {automation.runs24h} runs / 24h ·{" "}
                {"$" + automation.cost24hUsd.toFixed(4)} model cost
              </p>
            </div>
            {automation.id === "email-triage" && <AutomationConnections />}
            {automation.graph.nodes.some((item) => item.implementation) && (
              <CodeFixtureRun
                automationKey={automation.id}
                version={automation.version}
              />
            )}
          </div>

          <Tabs
            defaultValue="graph"
            onValueChange={(value) => value === "runs" && navigate("/runs")}
            className="mt-3 w-auto"
          >
            <TabsList variant="line" className="h-8">
              <TabsTrigger value="graph">Graph</TabsTrigger>
              <TabsTrigger value="runs">Runs</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        <div className="flex min-h-0 flex-1">
          <section className="relative min-w-0 flex-1">
            <AutomationGraph
              graph={automation.graph}
              selectedId={node.id}
              onSelect={handleSelect}
            />

            <div className="pointer-events-none absolute bottom-5 left-5 z-10 hidden items-center gap-4 text-xs text-muted-foreground sm:flex">
              <span className="flex items-center gap-1.5">
                <i className="size-1.5 rounded-full bg-emerald-400" /> healthy
                execution
              </span>
              <span className="flex items-center gap-1.5">
                <i className="size-1.5 rounded-full bg-amber-400" /> requires
                attention
              </span>
              <span className="flex items-center gap-1.5">
                <i className="size-1.5 rounded-full bg-muted-foreground" />{" "}
                neutral
              </span>
            </div>
          </section>

          <aside className="hidden w-[360px] shrink-0 overflow-y-auto border-l bg-sidebar/30 lg:block">
            <div className="flex h-12 items-center justify-between border-b px-5">
              <span className="text-sm font-medium">{node.label}</span>
              <span className="font-mono text-xs text-muted-foreground">
                {node.key}
              </span>
            </div>
            <NodeDetails
              node={node}
              definitionHash={automation.definitionHash}
              routes={selectedRoutes}
            />
          </aside>
        </div>
      </div>

      <Sheet open={mobileInspectorOpen} onOpenChange={setMobileInspectorOpen}>
        <SheetContent
          side="right"
          className="w-[min(94vw,420px)] gap-0 overflow-y-auto sm:max-w-[420px] lg:hidden"
        >
          <SheetHeader className="border-b px-5 py-5">
            <SheetTitle className="pr-8 text-lg">{node.label}</SheetTitle>
            <div className="font-mono text-xs text-muted-foreground">
              {node.key}
            </div>
          </SheetHeader>
          <NodeDetails
            node={node}
            definitionHash={automation.definitionHash}
            routes={selectedRoutes}
          />
        </SheetContent>
      </Sheet>
    </>
  )
}

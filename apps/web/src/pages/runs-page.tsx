import * as React from "react"
import { useRuns } from "@/api/queries"
import { RunInspector } from "@/components/run-inspector"
import { RunTable } from "@/components/run-table/run-table"
import { Skeleton } from "@workspace/ui/components/skeleton"

export function RunsPage() {
  const query = useRuns()
  const [selectedRunId, setSelectedRunId] = React.useState<string | null>(null)

  if (!query.data) {
    return (
      <div className="mx-auto w-full max-w-[1180px] space-y-4 p-5 sm:p-8">
        <Skeleton className="h-10 w-40" />
        <Skeleton className="h-72 w-full" />
      </div>
    )
  }

  return (
    <>
      <div className="mx-auto w-full max-w-[1180px] px-5 py-6 sm:px-8 sm:py-9">
        <div className="mb-7">
          <h1 className="text-2xl font-medium tracking-[-.035em]">Runs</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Immutable execution history for evaluation, comparison and
            debugging.
          </p>
        </div>
        <RunTable
          runs={query.data}
          onSelect={(run) => setSelectedRunId(run.id)}
        />
      </div>
      <RunInspector
        runId={selectedRunId}
        open={Boolean(selectedRunId)}
        onOpenChange={(open) => !open && setSelectedRunId(null)}
      />
    </>
  )
}

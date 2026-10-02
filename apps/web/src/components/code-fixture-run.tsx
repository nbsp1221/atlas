import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Button } from "@workspace/ui/components/button"
import { RunInspector } from "./run-inspector"
export function CodeFixtureRun({
  automationKey,
  version,
}: {
  automationKey: string
  version: number
}) {
  const cache = useQueryClient()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [runId, setRunId] = useState<string | null>(null)
  async function run() {
    if (pending) return
    setPending(true)
    setError(null)
    try {
      const inspected = await fetch(
        `/api/code-automations/${encodeURIComponent(automationKey)}/versions/${version}`
      )
      const metadata = await inspected.json()
      if (!inspected.ok) throw new Error(metadata.message ?? metadata.error)
      const response = await fetch(
        `/api/code-automations/${encodeURIComponent(automationKey)}/test-runs`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ version, input: metadata.fixture }),
        }
      )
      const result = await response.json()
      if (!response.ok) throw new Error(result.message ?? result.error)
      setRunId(result.runId)
      await cache.invalidateQueries()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Test run failed")
    } finally {
      setPending(false)
    }
  }
  return (
    <div className="space-y-2">
      <Button disabled={pending} onClick={() => void run()}>
        {pending ? "Running fixture…" : "Run fake email fixture"}
      </Button>
      {error && (
        <p role="alert" className="max-w-sm text-sm text-red-400">
          {error}
        </p>
      )}
      <RunInspector
        runId={runId}
        open={Boolean(runId)}
        onOpenChange={(open) => {
          if (!open) setRunId(null)
        }}
      />
    </div>
  )
}

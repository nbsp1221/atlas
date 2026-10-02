import { Handle, Position, type Node, type NodeProps } from "@xyflow/react"
import type { AutomationNode as DomainNode } from "@workspace/domain"

export type AutomationFlowNode = Node<DomainNode, "automation">

const healthClass = {
  healthy: "bg-emerald-400",
  attention: "bg-amber-400",
  neutral: "bg-muted-foreground",
}

export function AutomationNode({
  data,
  selected,
}: NodeProps<AutomationFlowNode>) {
  const rightMeta =
    data.executions === 0
      ? "no executions"
      : data.health === "attention"
        ? "needs attention"
        : data.medianLatencyMs !== undefined
          ? data.medianLatencyMs + "ms"
          : (data.detail ?? data.health)

  return (
    <div
      className={
        "relative w-52 rounded-lg border bg-card/95 px-4 py-3.5 shadow-lg transition-colors " +
        (selected ? "border-slate-500 bg-card" : "border-border")
      }
    >
      {data.kind !== "trigger" && (
        <Handle
          type="target"
          position={Position.Left}
          className="!size-1.5 !border-background !bg-muted-foreground"
        />
      )}
      <span
        className={
          "absolute top-3 right-3 size-1.5 rounded-full " +
          healthClass[data.health]
        }
      />
      <div className="font-mono text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {data.kind}
      </div>
      <div className="mt-2 text-sm font-medium">{data.label}</div>
      <div className="mt-3 flex items-center justify-between gap-4 font-mono text-xs text-muted-foreground">
        <span>{data.model ?? data.executions}</span>
        <span className="truncate">{rightMeta}</span>
      </div>
      {!["terminal", "verify"].includes(data.kind) && (
        <Handle
          type="source"
          position={Position.Right}
          className="!size-1.5 !border-background !bg-muted-foreground"
        />
      )}
    </div>
  )
}

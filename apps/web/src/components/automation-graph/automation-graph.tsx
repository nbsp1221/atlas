import * as React from "react"
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  type Edge,
  type NodeMouseHandler,
  type ReactFlowInstance,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import type {
  AutomationGraph as DomainGraph,
  AutomationNode as DomainNode,
} from "@workspace/domain"
import { dagreLayout } from "@/lib/graph-layout"
import { useIsMobile } from "@workspace/ui/hooks/use-mobile"
import {
  AutomationNode,
  type AutomationFlowNode,
} from "@/components/automation-graph/automation-node"

const nodeTypes = { automation: AutomationNode }
const NODE_WIDTH = 208
const NODE_HEIGHT = 96

export function AutomationGraph({
  graph,
  selectedId,
  onSelect,
}: {
  graph: DomainGraph
  selectedId?: string
  onSelect: (node: DomainNode) => void
}) {
  const isMobile = useIsMobile()
  const instanceRef = React.useRef<ReactFlowInstance<
    AutomationFlowNode,
    Edge
  > | null>(null)
  const positioned = React.useMemo(() => dagreLayout.layout(graph), [graph])
  const nodes = React.useMemo<AutomationFlowNode[]>(
    () =>
      positioned.nodes.map((node) => ({
        id: node.id,
        type: "automation",
        position: { x: node.x, y: node.y },
        data: node,
        selected: node.id === selectedId,
        draggable: false,
      })),
    [positioned.nodes, selectedId]
  )
  const edges = React.useMemo<Edge[]>(
    () =>
      positioned.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: edge.label,
        type: "smoothstep",
        animated: false,
        style: { stroke: "rgba(148,163,184,.34)", strokeWidth: 1 },
        labelStyle: {
          fill: "rgba(148,163,184,.75)",
          fontSize: 11,
          fontFamily: "monospace",
        },
        labelBgStyle: { fill: "#090b0e", fillOpacity: 0.94 },
      })),
    [positioned.edges]
  )

  const focusNode =
    positioned.nodes.find((node) => node.id === (selectedId ?? "classify")) ??
    positioned.nodes.find((node) => node.kind === "decision") ??
    positioned.nodes[0]

  React.useEffect(() => {
    const instance = instanceRef.current
    if (!instance || !focusNode) return

    if (isMobile) {
      void instance.setCenter(
        focusNode.x + NODE_WIDTH / 2,
        focusNode.y + NODE_HEIGHT / 2,
        { zoom: 0.9, duration: 180 }
      )
    } else {
      void instance.fitView({ padding: 0.16, duration: 180 })
    }
  }, [focusNode, isMobile])

  const onNodeClick: NodeMouseHandler<AutomationFlowNode> = (_event, node) =>
    onSelect(node.data)

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodeClick={onNodeClick}
      onInit={(instance) => {
        instanceRef.current = instance
        requestAnimationFrame(() => {
          if (window.innerWidth < 768 && focusNode) {
            void instance.setCenter(
              focusNode.x + NODE_WIDTH / 2,
              focusNode.y + NODE_HEIGHT / 2,
              { zoom: 0.9, duration: 0 }
            )
          } else {
            void instance.fitView({ padding: 0.16, duration: 0 })
          }
        })
      }}
      fitView={false}
      fitViewOptions={{ padding: 0.16 }}
      minZoom={0.42}
      maxZoom={1.6}
      proOptions={{ hideAttribution: true }}
      nodesConnectable={false}
      nodesDraggable={false}
      elementsSelectable
      className="bg-background"
    >
      <Background
        variant={BackgroundVariant.Dots}
        gap={20}
        size={1}
        color="rgba(100,116,139,.28)"
      />
      <Controls
        position="bottom-right"
        showInteractive={false}
        className="!border-border !bg-background !shadow-none [&_button]:!border-border [&_button]:!bg-background [&_button]:!text-muted-foreground"
      />
    </ReactFlow>
  )
}

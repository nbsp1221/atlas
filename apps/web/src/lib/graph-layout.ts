import dagre from "@dagrejs/dagre"
import type { AutomationGraph } from "@workspace/domain"

export type PositionedNode = AutomationGraph["nodes"][number] & {
  x: number
  y: number
}
export type PositionedGraph = {
  nodes: PositionedNode[]
  edges: AutomationGraph["edges"]
}

export interface GraphLayoutEngine {
  layout(graph: AutomationGraph): PositionedGraph
}

const NODE_WIDTH = 208
const NODE_HEIGHT = 96

export const dagreLayout: GraphLayoutEngine = {
  layout(graph) {
    const g = new dagre.graphlib.Graph()
    g.setDefaultEdgeLabel(() => ({}))
    g.setGraph({
      rankdir: "LR",
      ranksep: 84,
      nodesep: 32,
      marginx: 20,
      marginy: 20,
    })
    graph.nodes.forEach((node) =>
      g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT })
    )
    graph.edges.forEach((edge) => g.setEdge(edge.source, edge.target))
    dagre.layout(g)
    return {
      nodes: graph.nodes.map((node) => {
        const p = g.node(node.id)
        return { ...node, x: p.x - NODE_WIDTH / 2, y: p.y - NODE_HEIGHT / 2 }
      }),
      edges: graph.edges,
    }
  },
}

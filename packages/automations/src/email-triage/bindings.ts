import { InvalidNodeOutputError } from "@workspace/automation-runtime"
import type {
  AutomationGraphDefinition,
  NodeKind,
} from "@workspace/domain/persistence"

export const emailTriageBindings = {
  gmailEvent: {
    nodeKey: "gmail_event",
    kind: "trigger",
    integrationKey: "gmail",
    connectionKey: "google-primary",
    triggerKey: "message-received",
  },
  archiveEmail: {
    nodeKey: "archive_email",
    kind: "action",
    integrationKey: "gmail",
    connectionKey: "google-primary",
    actionKey: "archive-message",
  },
  reportSpam: {
    nodeKey: "report_spam",
    kind: "action",
    integrationKey: "gmail",
    connectionKey: "google-primary",
    actionKey: "report-spam",
  },
  verifyArchive: {
    nodeKey: "verify_archive",
    kind: "verify",
    integrationKey: "gmail",
    connectionKey: "google-primary",
    verificationKey: "message-archived",
  },
  verifySpam: {
    nodeKey: "verify_spam",
    kind: "verify",
    integrationKey: "gmail",
    connectionKey: "google-primary",
    verificationKey: "message-spam",
  },
  notifyUser: {
    nodeKey: "notify_user",
    kind: "action",
    interactionChannelKey: "personal-notifications",
  },
  verifyDelivery: {
    nodeKey: "verify_delivery",
    kind: "verify",
    interactionChannelKey: "personal-notifications",
    verificationKey: "delivery",
  },
} as const

type ExpectedBinding = {
  nodeKey: string
  kind: NodeKind
  [key: string]: string
}

function assertNodeBinding(
  graph: AutomationGraphDefinition,
  expected: ExpectedBinding
) {
  const node = graph.nodes.find(
    (candidate) => candidate.key === expected.nodeKey
  )
  if (!node) {
    throw new Error(
      `Email Triage definition is missing node ${expected.nodeKey}`
    )
  }
  if (node.kind !== expected.kind) {
    throw new Error(
      `Email Triage node ${expected.nodeKey} must be ${expected.kind}, got ${node.kind}`
    )
  }

  for (const [key, value] of Object.entries(expected)) {
    if (key === "nodeKey" || key === "kind") continue
    if (key === "connectionKey") {
      if (typeof node.config[key] !== "string" || !node.config[key].trim())
        throw new Error("Email Triage requires a mailbox connection")
      continue
    }
    if (node.config[key] !== value) {
      throw new Error(
        `Email Triage node ${expected.nodeKey} requires ${key}=${value}`
      )
    }
  }
}

export function assertEmailTriageDefinitionSemantics(
  graph: AutomationGraphDefinition
) {
  for (const expected of Object.values(emailTriageBindings)) {
    assertNodeBinding(graph, expected)
  }

  const mailboxKeys = graph.nodes
    .filter((node) => node.config.integrationKey === "gmail")
    .map((node) => node.config.connectionKey)
  if (new Set(mailboxKeys).size !== 1)
    throw new Error(
      "Email Triage Gmail bindings must use the same mailbox connection"
    )

  const expectedRoutes = new Map([
    ["archive", "archive_email"],
    ["notify", "notify_user"],
    ["spam", "report_spam"],
    ["no_action", "no_action"],
  ])

  const routeEdges = graph.edges.filter(
    (edge) => edge.source === "classify_email"
  )
  if (routeEdges.length !== expectedRoutes.size) {
    throw new Error(
      "Email Triage classifier routes do not match the canonical set"
    )
  }

  for (const [route, target] of expectedRoutes) {
    const edge = routeEdges.find((candidate) => candidate.key === route)
    if (!edge || edge.target !== target) {
      throw new Error(`Email Triage route ${route} must target ${target}`)
    }
  }

  return graph
}

export function bindingConfig(
  expected: ExpectedBinding
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(expected).filter(
      ([key]) => key !== "nodeKey" && key !== "kind"
    )
  )
}

export function assertBindingValues(
  actual: Record<string, unknown>,
  expected: ExpectedBinding,
  label: string
) {
  for (const [key, value] of Object.entries(bindingConfig(expected))) {
    if (key === "connectionKey") {
      if (typeof actual[key] !== "string" || !actual[key].trim())
        throw new InvalidNodeOutputError(
          `${label} requires a mailbox connection`
        )
      continue
    }
    if (actual[key] !== value) {
      throw new InvalidNodeOutputError(`${label} requires ${key}=${value}`)
    }
  }
}

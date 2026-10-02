import {
  InvalidNodeOutputError,
  type NodeHandler,
} from "@workspace/automation-runtime"
import type { JsonObject } from "@workspace/domain/persistence"
import { emailClassificationSchema } from "../contracts"
import { emailFromRunInput } from "../helpers"

function configString(config: JsonObject, key: string) {
  const value = config[key]
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidNodeOutputError(`classify_email requires config.${key}`)
  }
  return value
}

export const classifyEmailHandler: NodeHandler = {
  async execute(context) {
    const email = emailFromRunInput(context.runInput)
    const config = context.node.config
    const parameters =
      config.parameters &&
      !Array.isArray(config.parameters) &&
      typeof config.parameters === "object"
        ? config.parameters
        : {}

    const response = await context.invokeModel({
      ...(typeof config.modelConnectionKey === "string"
        ? { connectionKey: config.modelConnectionKey }
        : {}),
      provider: configString(config, "modelProvider"),
      model: configString(config, "model"),
      parameters,
      input: {
        email,
        instruction: configString(config, "prompt"),
      },
    })

    const classification = emailClassificationSchema.safeParse(response.output)
    if (!classification.success) {
      throw new InvalidNodeOutputError(
        "Classifier returned invalid structured output"
      )
    }

    const allowed = context.graph.edges.some(
      (edge) =>
        edge.source === context.node.key &&
        edge.key === classification.data.route
    )
    if (!allowed) {
      throw new InvalidNodeOutputError(
        `Classifier selected route not defined by graph: ${classification.data.route}`
      )
    }

    return {
      output: classification.data,
      selectedEdgeKey: classification.data.route,
    }
  },
}

import type { NodeHandler } from "@workspace/automation-runtime"

export const noActionHandler: NodeHandler = {
  async execute() {
    return {
      output: {
        result: "no_action",
      },
    }
  },
}

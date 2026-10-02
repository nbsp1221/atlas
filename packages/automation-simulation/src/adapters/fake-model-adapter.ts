import {
  ModelProviderError,
  type ModelInvoker,
  type ModelRequest,
  type ModelResponse,
} from "@workspace/automation-runtime"
import type { JsonValue } from "@workspace/domain/persistence"

export type FakeModelStep =
  | {
      type: "success"
      output: JsonValue
      usageDetails?: Record<string, number>
      costUsd?: number
    }
  | {
      type: "transient-failure"
      message?: string
    }
  | {
      type: "permanent-failure"
      message?: string
    }

export class FakeModelAdapter implements ModelInvoker {
  private invocationCount = 0
  private readonly observedRequests: ModelRequest[] = []

  constructor(
    private readonly steps: FakeModelStep[],
    private readonly delayMs = 0
  ) {
    if (steps.length === 0) {
      throw new Error("FakeModelAdapter requires at least one programmed step")
    }
  }

  get calls() {
    return this.invocationCount
  }

  get requests() {
    return structuredClone(this.observedRequests)
  }

  async invoke(request: ModelRequest): Promise<ModelResponse> {
    this.observedRequests.push(structuredClone(request))
    const index = this.invocationCount
    this.invocationCount += 1
    const step = this.steps[Math.min(index, this.steps.length - 1)]
    const requestId = `fake-model-${this.invocationCount}`
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs))
    }

    if (step.type === "transient-failure") {
      throw new ModelProviderError(
        step.message ?? "Programmed transient model failure",
        true,
        "fake_model_transient",
        requestId
      )
    }

    if (step.type === "permanent-failure") {
      throw new ModelProviderError(
        step.message ?? "Programmed permanent model failure",
        false,
        "fake_model_permanent",
        requestId
      )
    }

    return {
      output: step.output,
      providerRequestId: requestId,
      usageDetails: {
        input: 100,
        output: 20,
        ...step.usageDetails,
      },
      costDetails: {
        currency: "USD",
        source: "fake-model",
      },
      costUsd: step.costUsd ?? 0.0001,
    }
  }
}

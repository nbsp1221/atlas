import type { ModelRequest, ModelResponse } from "../contracts/execution"

export interface ModelInvoker {
  invoke(request: ModelRequest): Promise<ModelResponse>
}

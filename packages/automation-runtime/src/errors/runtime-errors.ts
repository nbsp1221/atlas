import type { JsonObject } from "@workspace/domain/persistence"

export class RuntimeError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: JsonObject
  ) {
    super(message)
    this.name = new.target.name
  }
}

export class ModelProviderError extends RuntimeError {
  constructor(
    message: string,
    readonly transient: boolean,
    code = transient ? "model_provider_transient" : "model_provider_failure",
    readonly providerRequestId?: string
  ) {
    super(message, code)
  }
}

export class ExternalActionError extends RuntimeError {
  constructor(message: string, code = "external_action_failure") {
    super(message, code)
  }
}

export class ExternalActionUnknownError extends RuntimeError {
  constructor(message: string) {
    super(message, "external_action_unknown")
  }
}

export class InvalidNodeOutputError extends RuntimeError {
  constructor(message: string) {
    super(message, "invalid_node_output")
  }
}

export class GraphExecutionError extends RuntimeError {
  constructor(message: string) {
    super(message, "graph_execution_error")
  }
}

export class RetryableNodeError extends RuntimeError {
  constructor(message: string, code = "retryable_node_error") {
    super(message, code)
  }
}

// A handler has atomically persisted its own bounded continuation. The kernel
// must leave the current node and Run running, without retrying that handler.
export class ExecutionSuspendedError extends RuntimeError {
  constructor() {
    super("Execution has a persisted continuation", "execution_suspended")
  }
}

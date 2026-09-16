// ─── Mock Model Provider ──────────────────────────────────────────────────
// Deterministic in-memory model provider for testing, development, and offline demos.

import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelToolCall,
} from "./ModelProvider";

export type MockHandler = (
  request: ModelRequest
) => ModelResponse | Promise<ModelResponse>;

export interface MockModelOptions {
  responses?: ModelResponse[];
  handler?: MockHandler;
  defaultAnswer?: string;
}

export class MockModelProvider implements ModelProvider {
  readonly name = "mock:agentos";
  private responses: ModelResponse[] = [];
  private handler?: MockHandler;
  private defaultAnswer: string;
  private requests: ModelRequest[] = [];

  constructor(options?: MockModelOptions) {
    if (options?.responses) {
      this.responses = [...options.responses];
    }
    this.handler = options?.handler;
    this.defaultAnswer =
      options?.defaultAnswer ?? "Task completed successfully.";
  }

  /** Queue a response to be returned by future generate() calls. */
  addResponse(response: ModelResponse): void {
    this.responses.push(response);
  }

  /** Queue a tool call response. */
  addToolCall(
    name: string,
    args: Record<string, unknown>,
    reasoning?: string
  ): void {
    this.responses.push(
      MockModelProvider.createToolCallResponse(name, args, reasoning)
    );
  }

  /** Queue a final answer response. */
  addAnswer(answer: string): void {
    this.responses.push(MockModelProvider.createAnswerResponse(answer));
  }

  /** Inspect all requests received by this mock provider. */
  getRequests(): ModelRequest[] {
    return [...this.requests];
  }

  /** Total number of calls received. */
  get callCount(): number {
    return this.requests.length;
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    if (request.signal?.aborted) {
      throw new DOMException("The operation was aborted", "AbortError");
    }

    this.requests.push(request);

    if (this.handler) {
      return await this.handler(request);
    }

    if (this.responses.length > 0) {
      return this.responses.shift()!;
    }

    // Default fallback response
    return MockModelProvider.createAnswerResponse(this.defaultAnswer);
  }

  /** Helper to construct a ModelResponse representing one or more tool calls. */
  static createToolCallResponse(
    nameOrCalls: string | ModelToolCall[],
    args?: Record<string, unknown>,
    reasoning?: string
  ): ModelResponse {
    const toolCalls: ModelToolCall[] = Array.isArray(nameOrCalls)
      ? nameOrCalls
      : [
          {
            id: `call_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
            name: nameOrCalls,
            arguments: args ?? {},
          },
        ];

    return {
      content: reasoning ?? null,
      toolCalls,
      model: "mock-model",
      usage: { promptTokens: 50, completionTokens: 25, totalTokens: 75 },
      finishReason: "tool_calls",
    };
  }

  /** Helper to construct a ModelResponse representing a final text answer. */
  static createAnswerResponse(
    content: string,
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
  ): ModelResponse {
    return {
      content,
      toolCalls: [],
      model: "mock-model",
      usage: usage ?? { promptTokens: 30, completionTokens: 20, totalTokens: 50 },
      finishReason: "stop",
    };
  }
}

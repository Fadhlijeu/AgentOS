// ─── Model Provider Abstraction ──────────────────────────────────────────────
// Message-based LLM interface with structured tool-calling support.
// AgentOS never depends on a single vendor — all LLM interaction flows through
// this interface.

// ─── Messages ────────────────────────────────────────────────────────────────

/** A single message in the conversation sent to / received from the model. */
export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  /** For `tool` role: which tool call this result belongs to. */
  toolCallId?: string;
  /** For `assistant` role: tool calls the model wants to make. */
  toolCalls?: ModelToolCall[];
}

// ─── Tool Definitions (sent to the model) ────────────────────────────────────

/** JSON-Schema description of a tool the model may call. */
export interface ModelToolDefinition {
  name: string;
  description: string;
  /** JSON Schema (draft-2020-12 subset) describing the expected arguments. */
  parameters: Record<string, unknown>;
}

/** A structured tool call returned by the model. */
export interface ModelToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

// ─── Request / Response ──────────────────────────────────────────────────────

/** Everything needed to make a single generate() call to a model. */
export interface ModelRequest {
  messages: ModelMessage[];
  tools?: ModelToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  /** Override the default model identifier. */
  model?: string;
}

/** Token usage counters returned alongside a response. */
export interface ModelUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** The parsed response from a single generate() call. */
export interface ModelResponse {
  /** Text content (null when the model only returned tool calls). */
  content: string | null;
  /** Structured tool calls (empty when the model returned text only). */
  toolCalls: ModelToolCall[];
  /** Exact model identifier used. */
  model: string;
  /** Token usage. */
  usage: ModelUsage;
  /** Why the model stopped generating. */
  finishReason: "stop" | "tool_calls" | "length" | "error";
}

// ─── Provider Interface ──────────────────────────────────────────────────────

/**
 * Implement this interface to add support for a new LLM vendor.
 *
 * ```ts
 * class MyProvider implements ModelProvider {
 *   readonly name = "my-llm";
 *   async generate(req: ModelRequest): Promise<ModelResponse> { ... }
 * }
 * ```
 */
export interface ModelProvider {
  /** Human-readable identifier for this provider instance (e.g. "openai:gpt-4o"). */
  readonly name: string;
  /** Send a request to the model and await a response. */
  generate(request: ModelRequest): Promise<ModelResponse>;
}
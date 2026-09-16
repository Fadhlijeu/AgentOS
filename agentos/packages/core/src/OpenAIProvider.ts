// ─── OpenAI Provider ─────────────────────────────────────────────────────────
// Real implementation of ModelProvider that calls the OpenAI Chat Completions
// API with tool-calling support, retries with exponential backoff, and proper
// error handling.

import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelToolCall,
} from "./ModelProvider";

// ─── Configuration ───────────────────────────────────────────────────────────

export interface OpenAIConfig {
  /** OpenAI API key (or compatible-endpoint key). */
  apiKey: string;
  /** Model to use (default: "gpt-4o"). */
  model?: string;
  /** Base URL for the API (default: "https://api.openai.com/v1"). */
  baseUrl?: string;
  /** Maximum retries on transient failures (default: 3). */
  maxRetries?: number;
  /** Organisation ID header (optional). */
  organization?: string;
}

// ─── Provider ────────────────────────────────────────────────────────────────

export class OpenAIProvider implements ModelProvider {
  readonly name: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly organization?: string;

  constructor(config: OpenAIConfig) {
    if (!config.apiKey) {
      throw new Error("OpenAIProvider requires an apiKey");
    }
    this.apiKey = config.apiKey;
    this.model = config.model ?? "gpt-4o";
    this.baseUrl = (config.baseUrl ?? "https://api.openai.com/v1").replace(
      /\/$/,
      ""
    );
    this.maxRetries = config.maxRetries ?? 3;
    this.organization = config.organization;
    this.name = `openai:${this.model}`;
  }

  // ── Public API ───────────────────────────────────────────────────────────

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const body = this.buildRequestBody(request);
    const raw = await this.fetchWithRetry(body);
    return this.parseResponse(raw);
  }

  // ── Request Building ─────────────────────────────────────────────────────

  private buildRequestBody(request: ModelRequest): Record<string, unknown> {
    const messages = request.messages.map((m) => {
      // Base message fields
      const msg: Record<string, unknown> = {
        role: m.role,
        content: m.content,
      };

      // Assistant messages may include tool_calls
      if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
        msg.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        }));
      }

      // Tool-result messages need tool_call_id
      if (m.role === "tool" && m.toolCallId) {
        msg.tool_call_id = m.toolCallId;
      }

      return msg;
    });

    const body: Record<string, unknown> = {
      model: request.model ?? this.model,
      messages,
    };

    // Attach tool definitions when available
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
    }

    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;

    return body;
  }

  // ── Response Parsing ─────────────────────────────────────────────────────

  private parseResponse(raw: any): ModelResponse {
    const choice = raw.choices?.[0];
    if (!choice) {
      throw new Error(
        `OpenAI returned no choices: ${JSON.stringify(raw).slice(0, 500)}`
      );
    }

    const message = choice.message;
    const toolCalls: ModelToolCall[] = (message.tool_calls ?? []).map(
      (tc: any) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: this.safeParseJson(tc.function.arguments),
      })
    );

    // Map finish_reason to our enum
    let finishReason: ModelResponse["finishReason"] = "stop";
    if (choice.finish_reason === "tool_calls") finishReason = "tool_calls";
    else if (choice.finish_reason === "length") finishReason = "length";
    else if (choice.finish_reason === "stop") finishReason = "stop";

    return {
      content: message.content ?? null,
      toolCalls,
      model: raw.model ?? this.model,
      usage: {
        promptTokens: raw.usage?.prompt_tokens ?? 0,
        completionTokens: raw.usage?.completion_tokens ?? 0,
        totalTokens: raw.usage?.total_tokens ?? 0,
      },
      finishReason,
    };
  }

  // ── HTTP with Retry ──────────────────────────────────────────────────────

  private async fetchWithRetry(
    body: Record<string, unknown>,
    attempt = 0
  ): Promise<any> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (this.organization) {
      headers["OpenAI-Organization"] = this.organization;
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    } catch (err) {
      // Network-level error (DNS, timeout, etc.)
      if (attempt < this.maxRetries) {
        await this.backoff(attempt);
        return this.fetchWithRetry(body, attempt + 1);
      }
      throw new Error(
        `OpenAI request failed after ${this.maxRetries} retries: ${(err as Error).message}`
      );
    }

    // Retry on rate-limit or server errors
    if (
      (response.status === 429 || response.status >= 500) &&
      attempt < this.maxRetries
    ) {
      await this.backoff(attempt);
      return this.fetchWithRetry(body, attempt + 1);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "<unreadable body>");
      throw new Error(
        `OpenAI API error ${response.status}: ${text.slice(0, 500)}`
      );
    }

    return response.json();
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private async backoff(attempt: number): Promise<void> {
    const delayMs = Math.min(1000 * Math.pow(2, attempt), 30_000);
    const jitter = Math.random() * 500;
    await new Promise((r) => setTimeout(r, delayMs + jitter));
  }

  private safeParseJson(str: string): Record<string, unknown> {
    try {
      return JSON.parse(str);
    } catch {
      return { _raw: str };
    }
  }
}

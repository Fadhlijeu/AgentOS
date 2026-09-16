// ─── @agentos/planner ────────────────────────────────────────────────────────
// ReAct (Reasoning + Acting) planner. This is the brain of the agent — it
// sends the task + available tools + observations to the LLM and interprets
// whether the model wants to call a tool or provide a final answer.
//
// The planner does NOT execute tools itself — it only decides what to do next.
// The Agent class handles execution, permissions, and the overall loop.

import type {
  ModelProvider,
  ModelMessage,
  ModelToolDefinition,
  ModelToolCall,
} from "@agentos/core";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Everything the planner needs to make a decision. */
export interface PlannerContext {
  /** The user's original task. */
  task: string;
  /** Full conversation history (system + user + assistant + tool messages). */
  messages: ModelMessage[];
  /** Tool definitions available to the agent. */
  tools: ModelToolDefinition[];
  /** Optional cancellation signal. */
  signal?: AbortSignal;
}

/** The planner's decision: call one or more tools, or return a final answer. */
export type PlannerDecision =
  | {
      type: "tool_calls";
      /** Tool calls to execute (may be multiple in parallel). */
      toolCalls: ModelToolCall[];
      /** Optional reasoning text from the model. */
      reasoning: string | null;
    }
  | {
      type: "final_answer";
      /** The model's final response to the user's task. */
      answer: string;
    }
  | {
      type: "error";
      /** What went wrong. */
      error: string;
    };

/** Token usage for the last planner call. */
export interface PlannerUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

// ─── Planner Interface ───────────────────────────────────────────────────────

export interface Planner {
  /** Given the current context, decide what to do next. */
  decideNextAction(context: PlannerContext): Promise<PlannerDecision>;
  /** Get the token usage from the last call. */
  getLastUsage(): PlannerUsage;
}

// ─── System Prompt ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an AI agent that can use tools to accomplish tasks on a computer.

## Instructions

1. Analyze the user's request carefully and break it into logical steps.
2. Use the available tools to gather information and take actions.
3. After each tool result, evaluate whether you have enough information to continue or need more data.
4. When you have completed the task or have enough information for a complete answer, respond with your final answer directly (do NOT call any tools).
5. Be thorough but efficient — avoid unnecessary tool calls.
6. If a tool call fails, analyze the error and try an alternative approach.

## Important Rules

- Never fabricate information — only use data confirmed through tool results.
- Always verify that file operations succeeded by checking the tool output.
- When listing or searching for files, examine the results before acting.
- For multi-step tasks, complete each step before moving to the next.
- If a task is ambiguous, make reasonable assumptions and state them.
- Keep your final answer concise and focused on what was accomplished.`;

// ─── ReAct Planner ───────────────────────────────────────────────────────────

/**
 * ReAct (Reasoning + Acting) planner that uses an LLM to decide actions.
 *
 * The loop works like this:
 * 1. Agent sends task + conversation history to the planner
 * 2. Planner calls the LLM with tool definitions
 * 3. If the LLM returns tool_calls → planner returns them for execution
 * 4. If the LLM returns text only → that's the final answer
 * 5. Agent executes tools, appends results, and loops back to step 1
 */
export class ReActPlanner implements Planner {
  private model: ModelProvider;
  private lastUsage: PlannerUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };

  constructor(model: ModelProvider) {
    this.model = model;
  }

  async decideNextAction(context: PlannerContext): Promise<PlannerDecision> {
    // Build messages — ensure base system prompt is present
    const messages: ModelMessage[] = [...context.messages];
    const systemIdx = messages.findIndex((m) => m.role === "system");
    if (systemIdx === -1) {
      messages.unshift({ role: "system", content: SYSTEM_PROMPT });
    } else if (!messages[systemIdx].content?.includes("You are an AI agent")) {
      messages[systemIdx] = {
        role: "system",
        content: `${SYSTEM_PROMPT}\n\n${messages[systemIdx].content ?? ""}`.trim(),
      };
    }

    try {
      const response = await this.model.generate({
        messages,
        tools: context.tools.length > 0 ? context.tools : undefined,
        temperature: 0.1, // Low temperature for consistent tool-use decisions
        signal: context.signal,
      });

      // Track token usage
      this.lastUsage = {
        promptTokens: response.usage.promptTokens,
        completionTokens: response.usage.completionTokens,
        totalTokens: response.usage.totalTokens,
      };

      // If the model returned tool calls → return them for execution
      if (response.toolCalls.length > 0) {
        return {
          type: "tool_calls",
          toolCalls: response.toolCalls,
          reasoning: response.content,
        };
      }

      // If the model returned text → that's the final answer
      if (response.content) {
        return {
          type: "final_answer",
          answer: response.content,
        };
      }

      // Edge case: no tool calls AND no content
      return {
        type: "error",
        error: "Model returned empty response (no content and no tool calls)",
      };
    } catch (err) {
      return {
        type: "error",
        error: `Planner error: ${(err as Error).message}`,
      };
    }
  }

  getLastUsage(): PlannerUsage {
    return { ...this.lastUsage };
  }
}
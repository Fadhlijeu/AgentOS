// ─── @agentos/tools ──────────────────────────────────────────────────────────
// Tool system interfaces and ToolRegistry. Every capability in AgentOS is a
// tool — filesystem access, terminal commands, browser actions, HTTP, etc.

import type { RiskLevel, ModelToolDefinition } from "@agentos/core";

// ─── Tool Context ────────────────────────────────────────────────────────────

/** Runtime context passed to every tool execution. */
export interface ToolContext {
  /** Current run identifier. */
  runId: string;
  /** Current task identifier. */
  taskId: string;
  /** Emit an event during tool execution. */
  emit: (event: string, data: Record<string, unknown>) => void;
  /** Optional cancellation signal for aborting active tool execution. */
  signal?: AbortSignal;
}

import { z } from "zod";

// ─── Tool Interface ──────────────────────────────────────────────────────────

/**
 * A tool that the agent can invoke. Every tool has:
 * - A unique name (used in LLM tool-calling)
 * - A JSON Schema describing its parameters (sent to LLM)
 * - An optional runtime Zod schema for input validation
 * - A risk level determining approval requirements
 * - An execute function that performs the actual work
 */
export interface Tool<TInput = Record<string, unknown>> {
  /** Unique tool name, e.g. "filesystem_read" or "terminal_exec". */
  name: string;
  /** Human-readable description shown to the LLM. */
  description: string;
  /** JSON Schema for the tool's input parameters (for LLM prompt). */
  parameters: Record<string, unknown>;
  /** Optional runtime Zod schema for validating tool arguments before execution. */
  schema?: z.ZodType<TInput>;
  /** Risk level — determines whether human approval is required. */
  riskLevel: RiskLevel;
  /**
   * Execute the tool with the given input.
   * Returns a string result that is fed back to the LLM as an observation.
   */
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

export { z };

// ─── Tool Registry ───────────────────────────────────────────────────────────

/**
 * Central registry for all tools available to an agent.
 *
 * ```ts
 * const registry = new ToolRegistry();
 * registry.register(filesystemReadTool());
 * registry.register(terminalExecTool());
 *
 * const tool = registry.get("filesystem_read");
 * const defs = registry.getModelDefinitions(); // for the LLM
 * ```
 */
export class ToolRegistry {
  private tools = new Map<string, Tool>();

  /** Register a tool. Throws if a tool with the same name already exists. */
  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  /** Register multiple tools at once. */
  registerAll(tools: Tool[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  /** Get a tool by name (supports both underscore and dot notation). */
  get(name: string): Tool | undefined {
    return (
      this.tools.get(name) ||
      this.tools.get(name.replace(/\./g, "_")) ||
      this.tools.get(name.replace(/_/g, "."))
    );
  }

  /** Get all registered tools. */
  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  /** Check if a tool is registered (supports both underscore and dot notation). */
  has(name: string): boolean {
    return Boolean(this.get(name));
  }

  /** Get tool names. */
  names(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Convert all registered tools into ModelToolDefinition[] for the LLM.
   * This is what gets passed to ModelRequest.tools.
   */
  getModelDefinitions(): ModelToolDefinition[] {
    return this.getAll().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }
}

// ─── Re-exports ──────────────────────────────────────────────────────────────

export { filesystemTools } from "./filesystem";
export { terminalTools } from "./terminal";
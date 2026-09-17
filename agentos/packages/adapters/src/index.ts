// ─── @agentos/adapters ───────────────────────────────────────────────────────
// Integration abstractions for external runtimes, browser agents, and sandboxes.
// Enables seamless integration with upstream projects:
// - Browser Use / Open Browser Use / DeepDOM
// - Open Interpreter
// - OpenHands Software Agent SDK

import type { Tool } from "@agentos/tools";

// ─── Core Abstractions Re-exported ───────────────────────────────────────────

export type {
  WorkspaceAdapter,
  BrowserSession,
  BrowserProviderAdapter,
} from "@agentos/core";

export * from "./workspace";
export * from "./browser";
export * from "./playwright-browser";
export * from "./open-interpreter";
export * from "./openhands";

// ─── Code Interpreter Abstraction ────────────────────────────────────────────

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export interface CodeInterpreterAdapter {
  execute(
    language: string,
    code: string,
    options?: { timeoutMs?: number; signal?: AbortSignal; cwd?: string }
  ): Promise<ExecutionResult>;
}

// ─── Tool Adapter Helper ─────────────────────────────────────────────────────

export function createAdapterTool(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  handler: (args: Record<string, unknown>) => Promise<string>
): Tool {
  return {
    name,
    description,
    parameters,
    riskLevel: "MEDIUM",
    execute: (input) => handler(input),
  };
}

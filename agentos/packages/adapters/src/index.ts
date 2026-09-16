// ─── @agentos/adapters ───────────────────────────────────────────────────────
// Integration abstractions for external runtimes, browser agents, and sandboxes.
// Enables seamless integration with upstream projects:
// - Browser Use / Open Browser Use / DeepDOM
// - Open Interpreter
// - OpenHands Software Agent SDK

import type { Tool } from "@agentos/tools";

// ─── Workspace Abstraction ───────────────────────────────────────────────────

export interface WorkspaceAdapter {
  readonly id: string;
  readonly rootPath: string;
  read(relativePath: string): Promise<string>;
  write(relativePath: string, content: string): Promise<void>;
  list(relativePath?: string): Promise<string[]>;
  exists(relativePath: string): Promise<boolean>;
  delete(relativePath: string): Promise<void>;
}

// ─── Browser Automation Abstraction ──────────────────────────────────────────

export interface BrowserSession {
  readonly sessionId: string;
  navigate(url: string): Promise<void>;
  click(selector: string): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  screenshot(): Promise<Buffer | Uint8Array>;
  evaluate<T>(script: string): Promise<T>;
  close(): Promise<void>;
}

export interface BrowserProviderAdapter {
  createSession(options?: Record<string, unknown>): Promise<BrowserSession>;
}

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
    options?: { timeoutMs?: number }
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

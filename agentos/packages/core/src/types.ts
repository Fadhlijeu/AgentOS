// ─── Shared Types ────────────────────────────────────────────────────────────
// All types used across AgentOS packages. This is the single source of truth.

/** Risk level assigned to tool operations — determines approval requirements. */
export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

/** Lifecycle status of an Agent instance. */
export type AgentStatus =
  | "IDLE"
  | "RUNNING"
  | "PAUSED"
  | "CANCELLED"
  | "COMPLETED"
  | "ERROR";

/** Status of a plan within the planner. */
export type PlanStatus = "PENDING" | "IN_PROGRESS" | "COMPLETED" | "FAILED";

/** Status of a human-approval request. */
export type ApprovalStatus = "PENDING" | "GRANTED" | "DENIED" | "TIMEOUT";

/** Every event type the system can emit. */
export type AgentEventType =
  | "agent.started"
  | "agent.paused"
  | "agent.resumed"
  | "task.started"
  | "task.completed"
  | "task.failed"
  | "plan.created"
  | "plan.step"
  | "tool.requested"
  | "tool.started"
  | "tool.completed"
  | "tool.failed"
  | "approval.required"
  | "approval.granted"
  | "approval.denied"
  | "memory.updated";

// ─── Event Payload ───────────────────────────────────────────────────────────

/** A single persisted event emitted during agent execution. */
export interface AgentEvent {
  id: string;
  type: AgentEventType;
  timestamp: number;
  runId: string;
  taskId: string;
  data: Record<string, unknown>;
}

// ─── Agent Result ────────────────────────────────────────────────────────────

/** Returned by Agent.run() when a task finishes (success or failure). */
export interface AgentResult {
  success: boolean;
  output: string | null;
  error?: string;
  taskId: string;
  runId: string;
  events: AgentEvent[];
  usage: {
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
  };
  iterations: number;
  durationMs: number;
}

// ─── Utilities ───────────────────────────────────────────────────────────────

/**
 * Generate a short unique ID with an optional prefix.
 * Format: `prefix_<timestamp36><random6>` e.g. `run_m1abc2xyz`
 */
export function generateId(prefix = ""): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 8);
  return prefix ? `${prefix}_${ts}${rand}` : `${ts}${rand}`;
}

/** Risk level ordering for comparison: LOW < MEDIUM < HIGH < CRITICAL. */
const RISK_ORDER: Record<RiskLevel, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
};

/** Returns true when `level` is at least as risky as `threshold`. */
export function isRiskAtLeast(level: RiskLevel, threshold: RiskLevel): boolean {
  return RISK_ORDER[level] >= RISK_ORDER[threshold];
}

// ─── Workspace Abstraction ───────────────────────────────────────────────────

export interface WorkspaceAdapter {
  readonly id: string;
  readonly rootPath: string;
  read(relativePath: string): Promise<string>;
  write(relativePath: string, content: string): Promise<void>;
  list(relativePath?: string): Promise<string[]>;
  exists(relativePath: string): Promise<boolean>;
  delete(relativePath: string): Promise<void>;
  mkdir?(relativePath: string): Promise<void>;
  resolvePath?(relativePath: string): string;
}

// ─── Browser Automation Abstraction ──────────────────────────────────────────

export interface BrowserSession {
  readonly sessionId: string;
  navigate(url: string): Promise<void>;
  click(selector: string): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  screenshot(): Promise<Buffer | Uint8Array>;
  evaluate<T>(script: string): Promise<T>;
  observe?(): Promise<{
    url: string;
    title: string;
    content: string;
    elements: Array<{ selector: string; tag: string; text?: string; value?: string; href?: string }>;
  }>;
  close(): Promise<void>;
}

export interface BrowserProviderAdapter {
  createSession(options?: Record<string, unknown>): Promise<BrowserSession>;
}

// ─── Tool Error Classification ───────────────────────────────────────────────

export type ToolErrorCode =
  | "VALIDATION_ERROR"
  | "PERMISSION_DENIED"
  | "APPROVAL_DENIED"
  | "TIMEOUT"
  | "NOT_FOUND"
  | "EXECUTION_ERROR"
  | "NETWORK_ERROR";

export interface ToolExecutionResult {
  ok: boolean;
  output?: string;
  error?: {
    code: ToolErrorCode;
    message: string;
    retryable: boolean;
  };
}

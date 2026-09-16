// ─── @agentos/observability ──────────────────────────────────────────────────
// Tracing and structured logging for agent execution. Every tool call, LLM
// decision, and observation is recorded as a trace entry, making the full
// execution path inspectable and exportable.

import type { AgentEvent, AgentEventType } from "@agentos/core";
import { EventBus } from "@agentos/events";

// ─── Trace Entry Types ───────────────────────────────────────────────────────

export interface TraceEntry {
  timestamp: number;
  runId: string;
  taskId: string;
  type:
    | "task_start"
    | "planner_call"
    | "tool_call"
    | "tool_result"
    | "observation"
    | "approval"
    | "error"
    | "task_end";
  data: Record<string, unknown>;
  durationMs?: number;
}

export interface TraceMetrics {
  totalTraces: number;
  totalToolCalls: number;
  totalErrors: number;
  totalLatencyMs: number;
  averageLatencyMs: number;
  tokenUsage: {
    prompt: number;
    completion: number;
    total: number;
  };
}

// ─── Tracer ──────────────────────────────────────────────────────────────────

/**
 * Records structured traces of agent execution. Subscribes to the EventBus
 * to automatically capture events, and provides methods for manual tracing.
 *
 * ```ts
 * const tracer = new Tracer(eventBus);
 * tracer.recordToolCall(runId, taskId, "filesystem_read", { path: "/tmp" }, 42);
 * const trace = tracer.getTrace(runId);
 * const json = tracer.exportTrace(runId);
 * ```
 */
export class Tracer {
  private traces = new Map<string, TraceEntry[]>();
  private metrics: TraceMetrics = {
    totalTraces: 0,
    totalToolCalls: 0,
    totalErrors: 0,
    totalLatencyMs: 0,
    averageLatencyMs: 0,
    tokenUsage: { prompt: 0, completion: 0, total: 0 },
  };

  private unsubscribe?: () => void;

  constructor(eventBus?: EventBus) {
    if (eventBus) {
      this.subscribeToEvents(eventBus);
    }
  }

  // ── Manual Recording ───────────────────────────────────────────────────

  recordTaskStart(runId: string, taskId: string, task: string, model: string): void {
    this.addEntry({
      timestamp: Date.now(),
      runId,
      taskId,
      type: "task_start",
      data: { task, model },
    });
  }

  recordPlannerCall(
    runId: string,
    taskId: string,
    decision: string,
    durationMs: number,
    tokenUsage?: { prompt: number; completion: number; total: number }
  ): void {
    this.addEntry({
      timestamp: Date.now(),
      runId,
      taskId,
      type: "planner_call",
      data: { decision, tokenUsage },
      durationMs,
    });

    if (tokenUsage) {
      this.metrics.tokenUsage.prompt += tokenUsage.prompt;
      this.metrics.tokenUsage.completion += tokenUsage.completion;
      this.metrics.tokenUsage.total += tokenUsage.total;
    }
  }

  recordToolCall(
    runId: string,
    taskId: string,
    toolName: string,
    input: Record<string, unknown>,
    durationMs: number
  ): void {
    this.addEntry({
      timestamp: Date.now(),
      runId,
      taskId,
      type: "tool_call",
      data: { toolName, input },
      durationMs,
    });
    this.metrics.totalToolCalls++;
    this.metrics.totalLatencyMs += durationMs;
    this.updateAverageLatency();
  }

  recordToolResult(
    runId: string,
    taskId: string,
    toolName: string,
    result: string,
    error?: string
  ): void {
    this.addEntry({
      timestamp: Date.now(),
      runId,
      taskId,
      type: "tool_result",
      data: {
        toolName,
        result: result.length > 1000 ? result.slice(0, 1000) + "..." : result,
        error,
      },
    });
    if (error) this.metrics.totalErrors++;
  }

  recordTaskEnd(
    runId: string,
    taskId: string,
    success: boolean,
    durationMs: number
  ): void {
    this.addEntry({
      timestamp: Date.now(),
      runId,
      taskId,
      type: "task_end",
      data: { success },
      durationMs,
    });
  }

  recordError(
    runId: string,
    taskId: string,
    error: string,
    context?: Record<string, unknown>
  ): void {
    this.addEntry({
      timestamp: Date.now(),
      runId,
      taskId,
      type: "error",
      data: { error, ...context },
    });
    this.metrics.totalErrors++;
  }

  // ── Queries ────────────────────────────────────────────────────────────

  /** Get the full trace for a run. */
  getTrace(runId: string): TraceEntry[] {
    return this.traces.get(runId) ?? [];
  }

  /** Get current metrics. */
  getMetrics(): TraceMetrics {
    return { ...this.metrics };
  }

  /** Export a run's trace as formatted JSON (for replay). */
  exportTrace(runId: string): string {
    const entries = this.getTrace(runId);
    return JSON.stringify(
      {
        runId,
        exportedAt: new Date().toISOString(),
        entries,
        metrics: this.metrics,
      },
      null,
      2
    );
  }

  /** Print a human-readable trace summary to console. */
  printTrace(runId: string): void {
    const entries = this.getTrace(runId);
    if (entries.length === 0) {
      console.log(`No trace entries found for run: ${runId}`);
      return;
    }

    console.log(`\n═══ Trace: ${runId} (${entries.length} entries) ═══\n`);
    for (const entry of entries) {
      const time = new Date(entry.timestamp).toISOString().slice(11, 23);
      const duration = entry.durationMs ? ` (${entry.durationMs}ms)` : "";
      const icon = TRACE_ICONS[entry.type] ?? "•";
      console.log(`  ${time} ${icon} ${entry.type}${duration}`);

      // Show key data for certain types
      if (entry.type === "tool_call") {
        console.log(`           Tool: ${entry.data.toolName}`);
      }
      if (entry.type === "error") {
        console.log(`           Error: ${entry.data.error}`);
      }
    }
    console.log("");
  }

  // ── Event Subscription ─────────────────────────────────────────────────

  private subscribeToEvents(eventBus: EventBus): void {
    this.unsubscribe = eventBus.onAny((event: AgentEvent) => {
      this.addEntry({
        timestamp: event.timestamp,
        runId: event.runId,
        taskId: event.taskId,
        type: this.eventTypeToTraceType(event.type),
        data: { eventType: event.type, ...event.data },
      });
    });
  }

  private eventTypeToTraceType(eventType: AgentEventType): TraceEntry["type"] {
    if (eventType.startsWith("tool.")) return "tool_call";
    if (eventType.startsWith("approval.")) return "approval";
    if (eventType.startsWith("task.")) {
      return eventType === "task.started" ? "task_start" : "task_end";
    }
    return "observation";
  }

  // ── Internal ───────────────────────────────────────────────────────────

  private addEntry(entry: TraceEntry): void {
    if (!this.traces.has(entry.runId)) {
      this.traces.set(entry.runId, []);
    }
    this.traces.get(entry.runId)!.push(entry);
    this.metrics.totalTraces++;
  }

  private updateAverageLatency(): void {
    this.metrics.averageLatencyMs =
      this.metrics.totalToolCalls > 0
        ? this.metrics.totalLatencyMs / this.metrics.totalToolCalls
        : 0;
  }

  /** Clean up event subscription. */
  dispose(): void {
    if (this.unsubscribe) this.unsubscribe();
  }
}

const TRACE_ICONS: Record<string, string> = {
  task_start: "🚀",
  planner_call: "🧠",
  tool_call: "🔧",
  tool_result: "📋",
  observation: "👁️",
  approval: "🔐",
  error: "❌",
  task_end: "✅",
};
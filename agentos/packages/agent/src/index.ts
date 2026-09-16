// ─── @agentos/agent ──────────────────────────────────────────────────────────
// The main Agent class — the entry point for AgentOS.
//
// Orchestrates the model provider, planner, tools, permissions, approval,
// events, memory, storage, observability, and per-run execution lifecycles.
//
// Usage:
//   const agent = new Agent({
//     model: new OpenAIProvider({ apiKey }),
//     tools: [...filesystemTools(), ...terminalTools()],
//   });
//   const result = await agent.run("Find PDFs in Downloads and summarize them");

import {
  generateId,
  isRiskAtLeast,
  type AgentStatus,
  type AgentResult,
  type AgentEvent,
  type ModelProvider,
  type ModelMessage,
  type ModelToolCall,
  type RiskLevel,
} from "@agentos/core";

import { EventBus } from "@agentos/events";
import { ToolRegistry, type Tool, type ToolContext } from "@agentos/tools";
import {
  PermissionEngine,
  ApprovalManager,
  AutoApprovalHandler,
  ConsoleApprovalHandler,
  type PermissionPolicy,
  type ApprovalHandler,
} from "@agentos/permissions";
import { ReActPlanner, type Planner, type PlannerDecision } from "@agentos/planner";
import { MemoryManager } from "@agentos/memory";
import {
  SQLiteStore,
  type PersistenceStore,
  type ToolCallRecord,
} from "@agentos/storage";
import { Tracer } from "@agentos/observability";
import {
  RunContext,
  RunStateMachine,
  IllegalStateTransitionError,
  type AgentRun,
} from "@agentos/runtime";

// ─── Agent Configuration ─────────────────────────────────────────────────────

export interface AgentConfig {
  /** LLM model provider (required). */
  model: ModelProvider;
  /** Tools available to the agent. */
  tools?: Tool[];
  /** Permission policy (optional — defaults to fully open). */
  permissions?: PermissionPolicy;
  /** Custom approval handler (optional — defaults to auto-approve). */
  approvalHandler?: ApprovalHandler;
  /** Custom planner (optional — defaults to ReActPlanner). */
  planner?: Planner;
  /** SQLite database path (optional — defaults to in-memory). */
  dbPath?: string;
  /** Maximum reasoning iterations per run (default: 25). */
  maxIterations?: number;
  /** Whether to print trace output to console (default: true). */
  verbose?: boolean;
}

// ─── Agent ───────────────────────────────────────────────────────────────────

export class Agent {
  // ── Internals ──────────────────────────────────────────────────────────
  private model: ModelProvider;
  private planner: Planner;
  private toolRegistry: ToolRegistry;
  private permissionEngine: PermissionEngine;
  private approvalManager: ApprovalManager;
  private eventBus: EventBus;
  private memory: MemoryManager;
  private store: PersistenceStore;
  private tracer: Tracer;

  private maxIterations: number;
  private verbose: boolean;

  // Active runs isolation (concurrent run safety)
  private activeRuns = new Map<string, RunContext>();
  private lastRun?: RunContext;
  private pendingStatus: AgentStatus = "IDLE";

  constructor(config: AgentConfig) {
    this.model = config.model;
    this.maxIterations = config.maxIterations ?? 25;
    this.verbose = config.verbose ?? true;

    // Event bus — the nervous system
    this.eventBus = new EventBus();

    // Tool registry
    this.toolRegistry = new ToolRegistry();
    if (config.tools) {
      this.toolRegistry.registerAll(config.tools);
    }

    // Permissions
    this.permissionEngine = new PermissionEngine(config.permissions);

    // Approval — secure by default: prompt in console unless trusted mode is enabled
    const approvalHandler =
      config.approvalHandler ??
      (config.permissions?.trusted
        ? new AutoApprovalHandler()
        : new ConsoleApprovalHandler());
    this.approvalManager = new ApprovalManager(
      approvalHandler,
      this.eventBus,
      this.permissionEngine.approvalTimeoutMs
    );

    // Planner
    this.planner = config.planner ?? new ReActPlanner(this.model);

    // Memory
    this.memory = new MemoryManager();

    // Storage — fail-fast if an explicit database path was requested
    if (config.dbPath && config.dbPath !== ":memory:") {
      this.store = new SQLiteStore(config.dbPath);
    } else {
      try {
        this.store = new SQLiteStore(":memory:");
      } catch (err) {
        if (this.verbose) {
          console.warn(
            "[Agent] SQLite in-memory unavailable, using no-op storage:",
            (err as Error).message
          );
        }
        this.store = createNoOpStore();
      }
    }

    // Observability
    this.tracer = new Tracer(this.eventBus);

    // Auto-persist events to SQLite
    this.eventBus.onAny((event: AgentEvent) => {
      try {
        this.store.saveEvent(event);
      } catch {
        // Don't let storage errors kill the agent loop
      }
    });

    // Verbose logging
    if (this.verbose) {
      this.eventBus.onAny((event: AgentEvent) => {
        const icon = EVENT_ICONS[event.type] ?? "•";
        console.log(`${icon} [${event.type}]`, JSON.stringify(event.data).slice(0, 200));
      });
    }
  }

  // ─── Public API ────────────────────────────────────────────────────────

  /**
   * Start a task asynchronously and return an AgentRun handle immediately.
   * This provides an isolated RunContext with its own lifecycle, cancellation signal,
   * state machine, and result promise. Multiple runs can execute concurrently.
   */
  start(task: string): AgentRun {
    const runId = generateId("run");
    const taskId = generateId("task");
    const runContext = new RunContext({
      runId,
      taskId,
      task,
      eventBus: this.eventBus,
    });

    if (this.pendingStatus === "CANCELLED") {
      runContext.cancel();
      this.pendingStatus = "IDLE";
    }

    this.activeRuns.set(runId, runContext);
    this.lastRun = runContext;

    // Execute run in background
    this.executeRun(runContext).catch((err) => {
      runContext.fail(err);
    });

    return runContext;
  }

  /**
   * Run a task and await completion. Starts the ReAct loop and returns when the
   * agent produces a final answer, hits the iteration limit, or is cancelled/errors.
   */
  async run(task: string): Promise<AgentResult> {
    const run = this.start(task);
    return run.result;
  }

  /**
   * Pause execution of the most recently started task run.
   */
  async pause(): Promise<void> {
    if (this.lastRun) {
      await this.lastRun.pause();
    }
  }

  /**
   * Resume execution of the most recently paused task run.
   */
  async resume(): Promise<void> {
    if (this.lastRun) {
      await this.lastRun.resume();
    }
  }

  /**
   * Cancel the most recently started task run immediately, propagating AbortSignal
   * to any running tool processes or LLM requests.
   */
  async cancel(): Promise<void> {
    this.pendingStatus = "CANCELLED";
    if (this.lastRun) {
      await this.lastRun.cancel();
    }
  }

  /** Get the current status of the most recent run (or pending status). */
  getStatus(): AgentStatus {
    return this.lastRun?.status ?? this.pendingStatus;
  }

  /** Get a specific run by its runId. */
  getRun(runId: string): AgentRun | undefined {
    return this.activeRuns.get(runId);
  }

  /** Get all active runs. */
  getActiveRuns(): AgentRun[] {
    return Array.from(this.activeRuns.values());
  }

  /** Get the event bus (for external listeners). */
  getEventBus(): EventBus {
    return this.eventBus;
  }

  /** Get the tracer (for external trace queries). */
  getTracer(): Tracer {
    return this.tracer;
  }

  /** Get the persistence store. */
  getStore(): PersistenceStore {
    return this.store;
  }

  /** Clean up resources. Call when done using the agent. */
  dispose(): void {
    this.eventBus.dispose();
    this.tracer.dispose();
    this.store.close();
  }

  // ─── Execution Engine ──────────────────────────────────────────────────

  private async executeRun(runContext: RunContext): Promise<void> {
    const { runId, taskId, task, signal } = runContext;
    const startTime = runContext.startTime;

    try {
      if (runContext.isCancelled()) {
        const finalAnswer = "Task cancelled by user.";
        this.store.saveRun({
          runId,
          taskId,
          task,
          status: "CANCELLED",
          output: finalAnswer,
          error: null,
          startedAt: startTime,
          completedAt: Date.now(),
          iterations: 0,
          totalTokens: 0,
        });

        const result: AgentResult = {
          success: false,
          output: finalAnswer,
          error: undefined,
          taskId,
          runId,
          events: this.eventBus.getEventsByRun(runId),
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          iterations: 0,
          durationMs: 0,
        };

        runContext.complete(result);
        return;
      }

      runContext.start();

      // Clear working memory for this task
      await this.memory.clearWorking();

      // Emit start events
      this.eventBus.emit("agent.started", {
        runId,
        taskId,
        data: { task, model: this.model.name },
      });
      this.eventBus.emit("task.started", { runId, taskId, data: { task } });
      this.tracer.recordTaskStart(runId, taskId, task, this.model.name);

      // Save initial run record to persistence store
      this.store.saveRun({
        runId,
        taskId,
        task,
        status: "RUNNING",
        output: null,
        error: null,
        startedAt: startTime,
        completedAt: null,
        iterations: 0,
        totalTokens: 0,
      });

      let finalAnswer: string | null = null;
      let lastError: string | undefined;

      // ── ReAct Loop ─────────────────────────────────────────────────────
      for (
        runContext.iteration = 0;
        runContext.iteration < this.maxIterations;
        runContext.iteration++
      ) {
        // Handle PAUSED state
        if (runContext.getStatus() === "PAUSED") {
          await runContext.waitForResume();
        }

        // Handle CANCELLED state or AbortSignal
        if (runContext.isCancelled()) {
          break;
        }

        // Ask the planner what to do next
        const plannerStart = Date.now();
        const decision = await this.planner.decideNextAction({
          task,
          messages: runContext.messages,
          tools: this.toolRegistry.getModelDefinitions(),
          signal,
        });
        const plannerDuration = Date.now() - plannerStart;

        if (runContext.isCancelled()) {
          break;
        }

        // Track token usage
        const usage = (this.planner as ReActPlanner).getLastUsage?.();
        if (usage) {
          runContext.usage.promptTokens += usage.promptTokens;
          runContext.usage.completionTokens += usage.completionTokens;
          runContext.usage.totalTokens += usage.totalTokens;
        }

        this.tracer.recordPlannerCall(
          runId,
          taskId,
          decision.type,
          plannerDuration,
          usage
            ? {
                prompt: usage.promptTokens,
                completion: usage.completionTokens,
                total: usage.totalTokens,
              }
            : undefined
        );

        // ── Handle decision ────────────────────────────────────────────

        if (decision.type === "final_answer") {
          finalAnswer = decision.answer;
          break;
        }

        if (decision.type === "error") {
          lastError = decision.error;
          this.tracer.recordError(runId, taskId, decision.error);
          runContext.messages.push({
            role: "assistant",
            content: `Error: ${decision.error}. Let me try a different approach.`,
          });
          continue;
        }

        if (decision.type === "tool_calls") {
          // Add assistant message with tool calls to conversation
          runContext.messages.push({
            role: "assistant",
            content: decision.reasoning,
            toolCalls: decision.toolCalls,
          });

          // Execute each tool call
          for (const toolCall of decision.toolCalls) {
            if (runContext.isCancelled()) {
              break;
            }

            const result = await this.executeTool(
              toolCall,
              runId,
              taskId,
              signal
            );

            // Add tool result to conversation
            runContext.messages.push({
              role: "tool",
              content: result,
              toolCallId: toolCall.id,
            });
          }
        }
      }

      // ── Finalize ─────────────────────────────────────────────────────

      const isCancelled = runContext.isCancelled();
      if (isCancelled) {
        finalAnswer = finalAnswer ?? "Task cancelled by user.";
      } else if (runContext.iteration >= this.maxIterations && !finalAnswer) {
        finalAnswer = `Task incomplete: reached maximum iterations (${this.maxIterations}). Last progress was logged in the trace.`;
      }

      const durationMs = Date.now() - startTime;
      const isSuccess =
        !isCancelled &&
        finalAnswer !== null &&
        !finalAnswer.startsWith("Task incomplete");

      const finalStatus: AgentStatus = isCancelled
        ? "CANCELLED"
        : isSuccess
        ? "COMPLETED"
        : "ERROR";

      // Emit completion event
      this.eventBus.emit("task.completed", {
        runId,
        taskId,
        data: {
          success: isSuccess,
          iterations: runContext.iteration,
          durationMs,
        },
      });

      const events = this.eventBus.getEventsByRun(runId);
      this.tracer.recordTaskEnd(runId, taskId, isSuccess, durationMs);

      // Update run record
      this.store.saveRun({
        runId,
        taskId,
        task,
        status: finalStatus,
        output: finalAnswer,
        error: lastError ?? null,
        startedAt: startTime,
        completedAt: Date.now(),
        iterations: runContext.iteration,
        totalTokens: runContext.usage.totalTokens,
      });

      if (this.verbose) {
        this.tracer.printTrace(runId);
      }

      const result: AgentResult = {
        success: isSuccess,
        output: finalAnswer,
        error: lastError,
        taskId,
        runId,
        events,
        usage: { ...runContext.usage },
        iterations: runContext.iteration,
        durationMs,
      };

      if (finalStatus === "COMPLETED" || finalStatus === "CANCELLED") {
        runContext.complete(result);
      } else {
        runContext.fail(
          new Error(lastError || finalAnswer || "Task failed"),
          result
        );
      }
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errorMsg = (err as Error).message;

      this.eventBus.emit("task.failed", {
        runId,
        taskId,
        data: { error: errorMsg },
      });

      this.tracer.recordError(runId, taskId, errorMsg);
      this.tracer.recordTaskEnd(runId, taskId, false, durationMs);

      this.store.saveRun({
        runId,
        taskId,
        task,
        status: "ERROR",
        output: null,
        error: errorMsg,
        startedAt: startTime,
        completedAt: Date.now(),
        iterations: runContext.iteration,
        totalTokens: runContext.usage.totalTokens,
      });

      const result: AgentResult = {
        success: false,
        output: null,
        error: errorMsg,
        taskId,
        runId,
        events: this.eventBus.getEventsByRun(runId),
        usage: { ...runContext.usage },
        iterations: runContext.iteration,
        durationMs,
      };

      runContext.fail(err, result);
    }
  }

  // ─── Private Methods ──────────────────────────────────────────────────

  /**
   * Execute a single tool call with validation, permission checks, approval,
   * cancellation awareness, and structured persistence.
   */
  private async executeTool(
    toolCall: ModelToolCall,
    runId: string,
    taskId: string,
    signal?: AbortSignal
  ): Promise<string> {
    const tool = this.toolRegistry.get(toolCall.name);
    if (!tool) {
      const msg = `Tool not found: "${toolCall.name}". Available tools: ${this.toolRegistry.names().join(", ")}`;
      this.eventBus.emit("tool.failed", {
        runId,
        taskId,
        data: { toolName: toolCall.name, error: msg },
      });
      this.tracer.recordError(runId, taskId, msg);
      return `Error: ${msg}`;
    }

    this.eventBus.emit("tool.requested", {
      runId,
      taskId,
      data: { toolName: toolCall.name, arguments: toolCall.arguments },
    });

    // ── Input Schema Validation ─────────────────────────────────────────
    if (tool.schema) {
      const parsed = tool.schema.safeParse(toolCall.arguments);
      if (!parsed.success) {
        const errorMsg = `Input Validation Error: ${parsed.error.errors
          .map((e) => `${e.path.join(".") || "input"}: ${e.message}`)
          .join(", ")}`;
        this.eventBus.emit("tool.failed", {
          runId,
          taskId,
          data: { toolName: toolCall.name, error: errorMsg },
        });
        this.tracer.recordError(runId, taskId, errorMsg);
        return `Error: ${errorMsg}`;
      }
    }

    // ── Permission Check ────────────────────────────────────────────────
    const permission = this.permissionEngine.check(
      toolCall.name,
      toolCall.arguments as Record<string, unknown>
    );
    if (!permission.allowed) {
      const msg = `Permission denied: ${permission.reason}`;
      this.eventBus.emit("tool.failed", {
        runId,
        taskId,
        data: { toolName: toolCall.name, error: msg },
      });
      return `Error: ${msg}`;
    }

    // ── Approval Check ──────────────────────────────────────────────────
    if (this.permissionEngine.requiresApproval(tool.riskLevel)) {
      const approved = await this.approvalManager.checkApproval(
        toolCall.name,
        tool.riskLevel,
        toolCall.arguments as Record<string, unknown>,
        runId,
        taskId
      );
      if (!approved) {
        const msg = `Action denied by user: ${toolCall.name}`;
        this.eventBus.emit("tool.failed", {
          runId,
          taskId,
          data: { toolName: toolCall.name, error: msg },
        });
        return `Error: ${msg}`;
      }
    }

    // ── Execute Tool ────────────────────────────────────────────────────
    this.eventBus.emit("tool.started", {
      runId,
      taskId,
      data: { toolName: toolCall.name },
    });

    const ctx: ToolContext = {
      runId,
      taskId,
      emit: (event, data) =>
        this.eventBus.emit(event as any, { runId, taskId, data }),
      signal,
    };

    const toolStart = Date.now();
    try {
      const result = await tool.execute(
        toolCall.arguments as Record<string, unknown>,
        ctx
      );
      const toolDuration = Date.now() - toolStart;

      this.tracer.recordToolCall(
        runId,
        taskId,
        toolCall.name,
        toolCall.arguments as Record<string, unknown>,
        toolDuration
      );
      this.tracer.recordToolResult(runId, taskId, toolCall.name, result);

      this.eventBus.emit("tool.completed", {
        runId,
        taskId,
        data: {
          toolName: toolCall.name,
          durationMs: toolDuration,
          resultLength: result.length,
        },
      });

      // Persist tool call record to storage
      try {
        this.store.saveToolCall({
          id: generateId("call"),
          runId,
          taskId,
          toolName: toolCall.name,
          arguments: toolCall.arguments as Record<string, unknown>,
          result,
          durationMs: toolDuration,
          error: null,
          timestamp: toolStart,
        });
      } catch {
        // Storage errors don't halt execution
      }

      return result;
    } catch (err) {
      const toolDuration = Date.now() - toolStart;
      const errorMsg = (err as Error).message;

      this.tracer.recordToolCall(
        runId,
        taskId,
        toolCall.name,
        toolCall.arguments as Record<string, unknown>,
        toolDuration
      );
      this.tracer.recordToolResult(
        runId,
        taskId,
        toolCall.name,
        "",
        errorMsg
      );

      this.eventBus.emit("tool.failed", {
        runId,
        taskId,
        data: {
          toolName: toolCall.name,
          error: errorMsg,
          durationMs: toolDuration,
        },
      });

      // Persist failed tool call record to storage
      try {
        this.store.saveToolCall({
          id: generateId("call"),
          runId,
          taskId,
          toolName: toolCall.name,
          arguments: toolCall.arguments as Record<string, unknown>,
          result: null,
          durationMs: toolDuration,
          error: errorMsg,
          timestamp: toolStart,
        });
      } catch {
        // Storage errors don't halt execution
      }

      return `Error executing ${toolCall.name}: ${errorMsg}`;
    }
  }
}

// ─── Event Icons ─────────────────────────────────────────────────────────────

const EVENT_ICONS: Record<string, string> = {
  "agent.started": "🚀",
  "agent.paused": "⏸️",
  "agent.resumed": "▶️",
  "task.started": "📋",
  "task.completed": "✅",
  "task.failed": "❌",
  "plan.created": "📝",
  "plan.step": "📌",
  "tool.requested": "🔍",
  "tool.started": "⚙️",
  "tool.completed": "✔️",
  "tool.failed": "⚠️",
  "approval.required": "🔐",
  "approval.granted": "👍",
  "approval.denied": "👎",
  "memory.updated": "🧠",
};

// ─── No-Op Store (fallback) ──────────────────────────────────────────────────

function createNoOpStore(): PersistenceStore {
  return {
    saveEvent: () => {},
    getEventsByRun: () => [],
    getEventsByType: () => [],
    saveRun: () => {},
    getRun: () => null,
    getRecentRuns: () => [],
    saveToolCall: () => {},
    getToolCallsByRun: () => [],
    saveState: () => {},
    getState: () => null,
    deleteState: () => {},
    close: () => {},
  };
}

// ─── Re-exports for convenience ──────────────────────────────────────────────

export { OpenAIProvider, MockModelProvider } from "@agentos/core";
export type { OpenAIConfig, MockModelOptions, MockHandler } from "@agentos/core";
export { filesystemTools, terminalTools, ToolRegistry } from "@agentos/tools";
export type { Tool } from "@agentos/tools";
export { ConsoleApprovalHandler, AutoApprovalHandler } from "@agentos/permissions";
export { EventBus } from "@agentos/events";
export { MemoryManager } from "@agentos/memory";
export { SQLiteStore } from "@agentos/storage";
export type { ToolCallRecord } from "@agentos/storage";
export { Tracer } from "@agentos/observability";
export { ReActPlanner } from "@agentos/planner";
export {
  RunContext,
  RunStateMachine,
  IllegalStateTransitionError,
} from "@agentos/runtime";
export type { AgentRun } from "@agentos/runtime";
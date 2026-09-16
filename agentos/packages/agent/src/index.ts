// ─── @agentos/agent ──────────────────────────────────────────────────────────
// The main Agent class — the entry point for AgentOS.
//
// This is where everything comes together: the Agent orchestrates the
// model provider, planner, tools, permissions, approval, events, memory,
// storage, and observability into a single coherent execution loop.
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
import { SQLiteStore, type PersistenceStore } from "@agentos/storage";
import { Tracer } from "@agentos/observability";

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

  private status: AgentStatus = "IDLE";
  private maxIterations: number;
  private verbose: boolean;

  // Track token usage across the run
  private runUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

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
   * Run a task. This is the main entry point — it starts the ReAct loop
   * and returns when the agent produces a final answer, hits the iteration
   * limit, or encounters an unrecoverable error.
   */
  async run(task: string): Promise<AgentResult> {
    const runId = generateId("run");
    const taskId = generateId("task");
    const startTime = Date.now();
    this.status = "RUNNING";
    this.runUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    // Clear working memory from previous runs
    await this.memory.clearWorking();

    // Emit start events
    this.eventBus.emit("agent.started", { runId, taskId, data: { task, model: this.model.name } });
    this.eventBus.emit("task.started", { runId, taskId, data: { task } });
    this.tracer.recordTaskStart(runId, taskId, task, this.model.name);

    // Save run record
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

    // Build initial messages
    const messages: ModelMessage[] = [
      { role: "user", content: task },
    ];

    let finalAnswer: string | null = null;
    let iteration = 0;
    let lastError: string | undefined;

    try {
      // ── ReAct Loop ─────────────────────────────────────────────────────
      for (iteration = 0; iteration < this.maxIterations; iteration++) {
        // Check if paused or cancelled (read through getter to defeat
        // TypeScript's control-flow narrowing — status can change async)
        const currentStatus = this.getStatus();
        if (currentStatus === "PAUSED") {
          await this.waitForResume();
        }
        if (this.getStatus() === "CANCELLED") {
          break;
        }

        // Ask the planner what to do next
        const plannerStart = Date.now();
        const decision = await this.planner.decideNextAction({
          task,
          messages,
          tools: this.toolRegistry.getModelDefinitions(),
        });
        const plannerDuration = Date.now() - plannerStart;

        // Track token usage
        const usage = (this.planner as ReActPlanner).getLastUsage?.();
        if (usage) {
          this.runUsage.promptTokens += usage.promptTokens;
          this.runUsage.completionTokens += usage.completionTokens;
          this.runUsage.totalTokens += usage.totalTokens;
        }

        this.tracer.recordPlannerCall(
          runId,
          taskId,
          decision.type,
          plannerDuration,
          usage ? { prompt: usage.promptTokens, completion: usage.completionTokens, total: usage.totalTokens } : undefined
        );

        // ── Handle decision ────────────────────────────────────────────

        if (decision.type === "final_answer") {
          finalAnswer = decision.answer;
          break;
        }

        if (decision.type === "error") {
          lastError = decision.error;
          this.tracer.recordError(runId, taskId, decision.error);
          // Don't immediately fail — give the model another chance
          messages.push({
            role: "assistant",
            content: `Error: ${decision.error}. Let me try a different approach.`,
          });
          continue;
        }

        if (decision.type === "tool_calls") {
          // Add assistant message with tool calls to conversation
          messages.push({
            role: "assistant",
            content: decision.reasoning,
            toolCalls: decision.toolCalls,
          });

          // Execute each tool call
          for (const toolCall of decision.toolCalls) {
            const result = await this.executeTool(
              toolCall,
              runId,
              taskId
            );

            // Add tool result to conversation
            messages.push({
              role: "tool",
              content: result,
              toolCallId: toolCall.id,
            });
          }
        }
      }

      // ── Finalize ─────────────────────────────────────────────────────

      if (iteration >= this.maxIterations && !finalAnswer) {
        finalAnswer = `Task incomplete: reached maximum iterations (${this.maxIterations}). Last progress was logged in the trace.`;
        this.status = "ERROR";
      } else if (this.getStatus() === "CANCELLED") {
        // Already cancelled — keep status
      } else {
        this.status = "COMPLETED";
      }

      const durationMs = Date.now() - startTime;

      // Emit completion event
      this.eventBus.emit("task.completed", {
        runId,
        taskId,
        data: {
          success: this.status === "COMPLETED",
          iterations: iteration,
          durationMs,
        },
      });

      const events = this.eventBus.getEventsByRun(runId);

      this.tracer.recordTaskEnd(runId, taskId, this.status === "COMPLETED", durationMs);

      // Update run record
      this.store.saveRun({
        runId,
        taskId,
        task,
        status: this.status,
        output: finalAnswer,
        error: lastError ?? null,
        startedAt: startTime,
        completedAt: Date.now(),
        iterations: iteration,
        totalTokens: this.runUsage.totalTokens,
      });

      // Print trace summary if verbose
      if (this.verbose) {
        this.tracer.printTrace(runId);
      }

      const result: AgentResult = {
        success: this.status === "COMPLETED",
        output: finalAnswer,
        error: lastError,
        taskId,
        runId,
        events,
        usage: { ...this.runUsage },
        iterations: iteration,
        durationMs,
      };

      return result;
    } catch (err) {
      this.status = "ERROR";
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
        iterations: iteration,
        totalTokens: this.runUsage.totalTokens,
      });

      return {
        success: false,
        output: null,
        error: errorMsg,
        taskId,
        runId,
        events: this.eventBus.getEventsByRun(runId),
        usage: { ...this.runUsage },
        iterations: iteration,
        durationMs,
      };
    }
  }

  /** Pause the agent (will pause at the next iteration boundary). */
  async pause(): Promise<void> {
    if (this.status === "RUNNING") {
      this.status = "PAUSED";
      this.eventBus.emit("agent.paused", {
        runId: "",
        taskId: "",
        data: {},
      });
    }
  }

  /** Resume a paused agent. */
  async resume(): Promise<void> {
    if (this.status === "PAUSED") {
      this.status = "RUNNING";
      this.eventBus.emit("agent.resumed", {
        runId: "",
        taskId: "",
        data: {},
      });
    }
  }

  /** Cancel the current run. */
  async cancel(): Promise<void> {
    this.status = "CANCELLED";
  }

  /** Get the current agent status. */
  getStatus(): AgentStatus {
    return this.status;
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

  // ─── Private Methods ──────────────────────────────────────────────────

  /**
   * Execute a single tool call with permission checks, approval, and tracing.
   */
  private async executeTool(
    toolCall: ModelToolCall,
    runId: string,
    taskId: string
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
        data: { toolName: toolCall.name, error: errorMsg, durationMs: toolDuration },
      });

      return `Error executing ${toolCall.name}: ${errorMsg}`;
    }
  }

  /** Wait until the agent is resumed (or cancelled). */
  private waitForResume(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (this.status !== "PAUSED") {
          resolve();
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });
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
export { Tracer } from "@agentos/observability";
export { ReActPlanner } from "@agentos/planner";
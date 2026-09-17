// ─── Run Context & Agent Run ──────────────────────────────────────────────────
// Isolated runtime context per task execution. Decouples state from the Agent
// instance so multiple tasks can run concurrently without state collisions.

import type {
  AgentStatus,
  AgentResult,
  ModelMessage,
  WorkspaceAdapter,
} from "@agentos/core";
import { EventBus } from "@agentos/events";
import { RunStateMachine } from "./state-machine";

export interface AgentRun {
  readonly runId: string;
  readonly taskId: string;
  readonly task: string;
  readonly status: AgentStatus;
  readonly signal: AbortSignal;
  readonly result: Promise<AgentResult>;
  readonly workspace?: WorkspaceAdapter;

  pause(): Promise<void>;
  resume(): Promise<void>;
  cancel(): Promise<void>;
}

export interface RunContextOptions {
  runId: string;
  taskId: string;
  task: string;
  eventBus: EventBus;
  workspace?: WorkspaceAdapter;
}

export class RunContext implements AgentRun {
  readonly runId: string;
  readonly taskId: string;
  readonly task: string;
  readonly startTime: number;
  readonly workspace?: WorkspaceAdapter;

  private readonly stateMachine: RunStateMachine;
  private readonly abortController: AbortController;
  private readonly eventBus: EventBus;
  private resumeResolvers: Array<() => void> = [];

  readonly messages: ModelMessage[] = [];
  readonly usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  iteration = 0;

  private _resolveResult!: (result: AgentResult) => void;
  private _rejectResult!: (error: unknown) => void;
  readonly result: Promise<AgentResult>;

  constructor(options: RunContextOptions) {
    this.runId = options.runId;
    this.taskId = options.taskId;
    this.task = options.task;
    this.eventBus = options.eventBus;
    this.workspace = options.workspace;
    this.startTime = Date.now();

    this.stateMachine = new RunStateMachine("IDLE");
    this.abortController = new AbortController();

    this.result = new Promise<AgentResult>((resolve, reject) => {
      this._resolveResult = resolve;
      this._rejectResult = reject;
    });

    // Start with task message
    this.messages.push({ role: "user", content: this.task });
  }

  get status(): AgentStatus {
    return this.stateMachine.status;
  }

  getStatus(): AgentStatus {
    return this.stateMachine.status;
  }

  isCancelled(): boolean {
    return (
      this.stateMachine.status === "CANCELLED" ||
      this.abortController.signal.aborted
    );
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  start(): void {
    this.stateMachine.transitionTo("RUNNING");
  }

  complete(result: AgentResult): void {
    if (!this.stateMachine.isTerminal()) {
      this.stateMachine.transitionTo("COMPLETED");
    }
    this._resolveResult(result);
  }

  fail(error: unknown, fallbackResult?: AgentResult): void {
    if (!this.stateMachine.isTerminal()) {
      this.stateMachine.transitionTo("ERROR");
    }
    if (fallbackResult) {
      this._resolveResult(fallbackResult);
    } else {
      this._rejectResult(error);
    }
  }

  async pause(): Promise<void> {
    if (this.stateMachine.status === "RUNNING") {
      this.stateMachine.transitionTo("PAUSED");
      this.eventBus.emit("agent.paused", {
        runId: this.runId,
        taskId: this.taskId,
        data: { runId: this.runId, taskId: this.taskId },
      });
    }
  }

  async resume(): Promise<void> {
    if (this.stateMachine.status === "PAUSED") {
      this.stateMachine.transitionTo("RUNNING");
      this.eventBus.emit("agent.resumed", {
        runId: this.runId,
        taskId: this.taskId,
        data: { runId: this.runId, taskId: this.taskId },
      });
      // Wake up any pending waitForResume
      const resolvers = [...this.resumeResolvers];
      this.resumeResolvers = [];
      for (const resolve of resolvers) {
        resolve();
      }
    }
  }

  async cancel(): Promise<void> {
    if (!this.stateMachine.isTerminal()) {
      this.stateMachine.transitionTo("CANCELLED");
      this.abortController.abort();
      // Wake up any paused loops so they terminate cleanly
      const resolvers = [...this.resumeResolvers];
      this.resumeResolvers = [];
      for (const resolve of resolvers) {
        resolve();
      }
    }
  }

  async waitForResume(): Promise<void> {
    if (this.stateMachine.status !== "PAUSED") {
      return;
    }
    return new Promise<void>((resolve) => {
      this.resumeResolvers.push(resolve);
    });
  }
}

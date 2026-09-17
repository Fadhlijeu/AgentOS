// ─── Run State Machine ────────────────────────────────────────────────────────
// Strict state transition enforcement for agent task execution lifecycles.
// Prevents illegal state jumps (e.g. COMPLETED -> PAUSED) and enforces terminal states.

import type { AgentStatus } from "@agentos/core";

export class IllegalStateTransitionError extends Error {
  constructor(
    public readonly from: AgentStatus,
    public readonly to: AgentStatus,
    message?: string
  ) {
    super(
      message ??
        `Illegal state transition from "${from}" to "${to}". Allowed transitions from "${from}": [${
          TRANSITIONS[from].join(", ") || "none (terminal state)"
        }]`
    );
    this.name = "IllegalStateTransitionError";
  }
}

const TRANSITIONS: Record<AgentStatus, readonly AgentStatus[]> = {
  IDLE: ["RUNNING", "CANCELLED"],
  RUNNING: ["PAUSED", "COMPLETED", "ERROR", "CANCELLED"],
  PAUSED: ["RUNNING", "CANCELLED"],
  COMPLETED: [],
  ERROR: [],
  CANCELLED: [],
};

export class RunStateMachine {
  private _status: AgentStatus;

  constructor(initialStatus: AgentStatus = "IDLE") {
    this._status = initialStatus;
  }

  get status(): AgentStatus {
    return this._status;
  }

  canTransitionTo(next: AgentStatus): boolean {
    return TRANSITIONS[this._status].includes(next);
  }

  transitionTo(next: AgentStatus): void {
    if (this._status === next) {
      return;
    }
    if (!this.canTransitionTo(next)) {
      throw new IllegalStateTransitionError(this._status, next);
    }
    this._status = next;
  }

  isTerminal(): boolean {
    return (
      this._status === "COMPLETED" ||
      this._status === "ERROR" ||
      this._status === "CANCELLED"
    );
  }
}

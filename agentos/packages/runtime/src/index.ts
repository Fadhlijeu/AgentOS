// ─── @agentos/runtime ────────────────────────────────────────────────────────
// Agent execution runtime — manages the execution lifecycle, task scheduling,
// status transitions, AbortSignal propagation, and concurrency isolation.

export {
  RunStateMachine,
  IllegalStateTransitionError,
} from "./state-machine";

export {
  RunContext,
} from "./run-context";

export type {
  AgentRun,
  RunContextOptions,
} from "./run-context";

export type {
  AgentStatus,
  AgentResult,
  AgentEvent,
  AgentEventType,
} from "@agentos/core";

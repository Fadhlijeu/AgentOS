// ─── @agentos/sdk ────────────────────────────────────────────────────────────
// The unified AgentOS Software Development Kit.
//
// This is the primary entry point for embedding AgentOS into applications.
// It bundles and re-exports all core subsystems:
//
// - Agent Runtime:    Agent, AgentConfig, AgentResult
// - Model Providers:  OpenAIProvider, MockModelProvider, ModelProvider interface
// - Tools System:     filesystemTools, terminalTools, ToolRegistry, Tool interface
// - Permissions:      PermissionPolicy, PermissionEngine, ApprovalManager
// - Event System:     EventBus, AgentEvent, typed handlers
// - Memory:           MemoryManager, InMemoryStore
// - Storage:          SQLiteStore, PersistenceStore
// - Observability:    Tracer, trace export
//
// Usage:
//   import { Agent, OpenAIProvider, filesystemTools } from "@agentos/sdk";
//
//   const agent = new Agent({
//     model: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY }),
//     tools: filesystemTools(),
//   });
//   await agent.run("Find and summarize project notes");

// ─── Agent Runtime ───────────────────────────────────────────────────────────
export { Agent } from "@agentos/agent";
export type { AgentConfig } from "@agentos/agent";
export {
  RunContext,
  RunStateMachine,
  IllegalStateTransitionError,
} from "@agentos/runtime";
export type { AgentRun, RunContextOptions } from "@agentos/runtime";

// ─── Core Types & Enums ──────────────────────────────────────────────────────
export type {
  RiskLevel,
  AgentStatus,
  PlanStatus,
  ApprovalStatus,
  AgentEventType,
  AgentEvent,
  AgentResult,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelToolCall,
  ModelToolDefinition,
  ModelUsage,
  ModelProvider,
  OpenAIConfig,
  MockModelOptions,
  MockHandler,
} from "@agentos/core";

export {
  generateId,
  isRiskAtLeast,
  OpenAIProvider,
  MockModelProvider,
} from "@agentos/core";

// ─── Tool System ─────────────────────────────────────────────────────────────
export {
  ToolRegistry,
  filesystemTools,
  terminalTools,
} from "@agentos/tools";

export type {
  Tool,
  ToolContext,
} from "@agentos/tools";

// ─── Permissions & Human-in-the-Loop Approval ────────────────────────────────
export {
  PermissionEngine,
  ApprovalManager,
  ConsoleApprovalHandler,
  AutoApprovalHandler,
  isPathInside,
  parseCommand,
} from "@agentos/permissions";

export type {
  PermissionPolicy,
  PermissionDecision,
  ApprovalRequest,
  ApprovalHandler,
} from "@agentos/permissions";

// ─── Event Bus ───────────────────────────────────────────────────────────────
export { EventBus } from "@agentos/events";
export type { EventHandler, WildcardHandler } from "@agentos/events";

// ─── Planner ─────────────────────────────────────────────────────────────────
export { ReActPlanner } from "@agentos/planner";
export type {
  Planner,
  PlannerContext,
  PlannerDecision,
  PlannerUsage,
} from "@agentos/planner";

// ─── Memory ──────────────────────────────────────────────────────────────────
export {
  MemoryManager,
  InMemoryStore,
} from "@agentos/memory";

export type {
  MemoryTier,
  MemoryEntry,
  MemoryStore,
} from "@agentos/memory";

// ─── Storage & Persistence ───────────────────────────────────────────────────
export { SQLiteStore } from "@agentos/storage";
export type {
  PersistenceStore,
  RunRecord,
  ToolCallRecord,
} from "@agentos/storage";

// ─── Observability & Tracing ─────────────────────────────────────────────────
export { Tracer } from "@agentos/observability";
export type {
  TraceEntry,
  TraceMetrics,
} from "@agentos/observability";

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

// ─── Agent Runtime & Orchestrator ────────────────────────────────────────────
export { Agent, AgentRuntime } from "@agentos/agent";
export type {
  AgentConfig,
  AgentRuntimeConfig,
  TaskOptions,
} from "@agentos/agent";
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
  WorkspaceAdapter,
  BrowserSession,
  BrowserProviderAdapter,
  ToolErrorCode,
  ToolExecutionResult,
} from "@agentos/core";

export {
  generateId,
  isRiskAtLeast,
  OpenAIProvider,
  MockModelProvider,
} from "@agentos/core";

// ─── Workspaces & Adapters ───────────────────────────────────────────────────
export {
  LocalWorkspace,
  InMemoryWorkspace,
  VirtualBrowserSession,
  VirtualBrowserProvider,
  PlaywrightBrowserSession,
  PlaywrightBrowserProvider,
  OpenInterpreterAdapter,
  createInterpreterTool,
  OpenHandsWorkspaceAdapter,
  OpenHandsEventMapper,
} from "@agentos/adapters";

// ─── Tool System ─────────────────────────────────────────────────────────────
export {
  ToolRegistry,
  filesystemTools,
  terminalTools,
  httpTools,
  httpRequestSchema,
  browserTools,
  classifyToolError,
} from "@agentos/tools";

export type {
  Tool,
  ToolContext,
  HttpRequestInput,
  FilesystemToolsOptions,
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
  SQLiteMemoryStore,
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
  MemoryRecord,
} from "@agentos/storage";

// ─── Observability & Tracing ─────────────────────────────────────────────────
export { Tracer } from "@agentos/observability";
export type {
  TraceEntry,
  TraceMetrics,
} from "@agentos/observability";

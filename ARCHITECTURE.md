# AgentOS Architecture & Dependency System

AgentOS is an operating runtime and control plane for AI agents that perceive and operate computers. It abstracts execution, state management, tool execution, memory, permissions, and observability into modular, auditable subsystems.

---

## 1. Monorepo Dependency Graph

The AgentOS codebase is structured as a strictly acyclic dependency graph across 12 packages under `agentos/packages/` and integration bridges under `integrations/`:

```
                           @agentos/sdk (Unified Client Bundle)
                                      │
               ┌──────────────────────┴──────────────────────┐
               ▼                                             ▼
       @agentos/agent                                @agentos/adapters
               │                                             │
    ┌──────────┼──────────┬──────────┐            ┌──────────┼──────────┐
    ▼          ▼          ▼          ▼            ▼          ▼          ▼
@agentos/  @agentos/  @agentos/  @agentos/    Playwright  OpenHands   OpenInterpreter
 runtime    planner     memory    storage       Browser    Workspace      Adapter
    │          │          │          │          Adapter     Adapter          │
    │          │          │          │            │            │             │
    └──────────┴─────┬────┴──────────┘            └────────────┴─────────────┘
                     ▼                                          │
             @agentos/tools ◄───────────────────────────────────┘
                     │
             @agentos/permissions
                     │
              @agentos/events
                     │
              @agentos/core (Zero-dependency foundational contracts & types)
```

### Dependency Hierarchy & Layer Contracts

| Package | Direct Dependencies | Layer Role |
| :--- | :--- | :--- |
| **`@agentos/core`** | *None* | Fundamental types, enums, interfaces (`ModelProvider`, `BrowserSession`, `WorkspaceAdapter`, `ToolErrorCode`), ID generator. |
| **`@agentos/events`** | `@agentos/core` | High-throughput typed `EventBus` with wildcard support and replay timeline buffer. |
| **`@agentos/permissions`**| `@agentos/core`, `@agentos/events` | Policy governance, `PermissionEngine` (`isPathInside`, `parseCommand`, origin policies), `ApprovalManager`. |
| **`@agentos/tools`** | `@agentos/core`, `@agentos/permissions`, `@agentos/events` | `ToolRegistry`, filesystem tools, terminal tools, HTTP tools, browser tools, `classifyToolError`. |
| **`@agentos/storage`** | `@agentos/core`, `@agentos/events` | SQLiteStore (`better-sqlite3`) persisting runs, events, state, tool_calls, memory_entries. |
| **`@agentos/memory`** | `@agentos/core`, `@agentos/storage` | `MemoryManager`, `SQLiteMemoryStore` with tiered keyword search and automated retrieval. |
| **`@agentos/runtime`** | `@agentos/core`, `@agentos/events` | `RunStateMachine`, per-run `RunContext` with `AbortController`, `AgentRun`. |
| **`@agentos/planner`** | `@agentos/core` | `ReActPlanner` implementing observe → reason → act loop with system instructions. |
| **`@agentos/observability`**| `@agentos/core`, `@agentos/events` | `Tracer` recording structured trace spans, execution metrics, and JSON trace export. |
| **`@agentos/adapters`** | `@agentos/core`, `@agentos/permissions`, `@agentos/tools` | Concrete bridges: `PlaywrightBrowserProvider`, `OpenInterpreterAdapter`, `OpenHandsWorkspaceAdapter`. |
| **`@agentos/agent`** | All subsystems except `@agentos/sdk` | `Agent` runtime + `AgentRuntime` orchestrator coordinating concurrent runs. |
| **`@agentos/sdk`** | `@agentos/agent`, `@agentos/adapters` | Convenience top-level export bundling the entire platform for consumer applications. |

---

## 2. Runtime Execution Invariant

**Non-Bypassable Control Plane**: No tool call, browser interaction, or code execution can execute host capabilities directly without traversing the full AgentOS verification pipeline:

```
 User Task / SDK Call
          ↓
 1. AgentRuntime / Agent.start()
          ↓
 2. RunContext Allocation
    - Unique runId & taskId generated
    - Dedicated AbortController & AbortSignal created
    - RunStateMachine transitioned to RUNNING
          ↓
 3. Context Retrieval & Memory Prompt Injection
    - Relevant long-term / semantic memories fetched from SQLiteMemoryStore
    - Injected into system message before reasoning loop
          ↓
 4. ReAct Reasoning Loop (ReActPlanner)
    - LLM decides next tool action
          ↓
 5. Schema Validation Gate
    - Zod schema validates input arguments before touching system
          ↓
 6. PermissionEngine Gate
    - Deny-by-default filesystem access (explicit read/write required unless trusted mode)
    - Canonical path checking (`isPathInside`, traversal blocking)
    - Terminal executable allowlist & chaining operator rejection (`parseCommand`)
    - Exact-origin matching and subpath filtering (prevents prefix bypass)
    - SSRF private/internal IP blocking (127.0.0.0/8, 10.0.0.0/8, 169.254.169.254, etc.)
    - Working directory (`cwd`) boundary enforcement
          ↓
 7. ApprovalManager Gate (Human-in-the-Loop)
    - High & critical risk tools require explicit human approval (console / UI / API)
    - Integrated with `AbortSignal` for immediate cancellation
    - Denials gracefully feed back into planner as observations without crashing
          ↓
 8. Execution Engine / Upstream Adapter
    - Local Filesystem / OpenHands-Compatible Workspace
    - Terminal / Monitored Subprocess Runner (Open Interpreter inspired)
    - Playwright Real Browser / Virtual Browser Session
    - HTTP Request with AbortSignal cancellation
          ↓
 9. Secret Redaction Layer
    - `redactSecrets()` deep-clones and sanitizes sensitive headers (Authorization, cookies), API keys, and passwords
    - Events, traces, and SQLite storage only receive sanitized copies; live execution uses original data
          ↓
 10. EventBus Dispatch & Storage Persistence
    - Structured events emitted (`tool.requested`, `tool.started`, `tool.completed`, `tool.failed`)
    - Automatically committed to SQLiteStore (`tool_calls`, `events`, `runs`)
          ↓
 11. Observability & Memory Feedback
    - Tracer records timing spans and tokens
    - Task outcomes remembered into long-term memory (`memory.updated`)
    - Final AgentResult synthesized
```

---

## 3. Upstream Integrations & Provenance

AgentOS implements native execution systems inspired by and protocol-compatible with four core open-source projects:

1. **OpenHands Software Agent SDK** (`22c85eb0e0db8f4386380d095e9fe6933af2e65f`):
   - Protocol-compatible adapter via `OpenHandsWorkspaceAdapter` and `OpenHandsEventMapper`.
2. **Browser Use** (`d8110c5ff87ccba887aaa726cdb780f2f84bef8d`):
   - Design reference for browser perception-action loop schemas and DOM interactive element extraction.
3. **Open Browser Use** (`7765002ac88040aedc781be89afe68475a9d6c88`):
   - Architectural pattern reference for stealth launch flags, session isolation, and locator conventions.
4. **Open Interpreter** (`5db50b2e93224dda720462f02fc2858cbd112eb5`):
   - Design reference for multi-language code execution patterns, implemented natively via monitored subprocesses.

All projects are documented in [`THIRD_PARTY.md`](file:///D:/PROJECT/AgentOS/THIRD_PARTY.md) and [`integrations/`](file:///D:/PROJECT/AgentOS/integrations/).

---

## 4. Replay Terminology & Semantics

AgentOS explicitly distinguishes between distinct replay concepts:

1. **Audit Timeline Reconstruction (`reconstructTimeline(runId)` / `replay(runId)`)**:
   - Reconstructs what actually transpired during execution: the run metadata, ordered lifecycle events, and tool execution logs from SQLite storage.
   - Used for audit trails, compliance verification, and execution inspection.
2. **Trace Reconstruction (`tracer.getTrace(runId)`)**:
   - Compiles hierarchical execution spans, planner reasoning durations, and token usage into visual trace graphs or exportable JSON.
3. **Deterministic Re-Execution / Simulation**:
   - Re-running the planner against recorded tool results or deterministic mock providers.
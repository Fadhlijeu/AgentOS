# AgentOS

> *The runtime for AI agents that operate computers.*

[![TypeScript](https://img.shields.io/badge/TypeScript-5.5+-blue.svg)](https://www.typescriptlang.org/)
[![pnpm](https://img.shields.io/badge/pnpm-workspace-orange.svg)](https://pnpm.io/)
[![Node.js](https://img.shields.io/badge/Node.js->=18.0.0-green.svg)](https://nodejs.org/)
[![Status](https://img.shields.io/badge/Status-v0.1--Platform-brightgreen.svg)]()
[![License](https://img.shields.io/badge/License-MIT-purple.svg)]()

AgentOS is a general-purpose, embeddable agent execution platform that provides the runtime layer for AI agents capable of operating computers. It decouples the core agent reasoning loop, tool execution, permissions, state, and observability from any specific application domain.

---

## 🚦 Subsystem Implementation Status

To ensure complete architectural honesty (per `audit_0.2.md` guidelines), every subsystem's operational readiness is categorized below:

| Subsystem | Status | Details |
| :--- | :---: | :--- |
| **ReAct Agent Loop** | `Implemented` | Autonomous observe → reason → act → verify loop with iteration boundaries |
| **Model Abstraction** | `Implemented` | `OpenAIProvider`, `MockModelProvider`, multi-tool schema definitions |
| **Permission Engine** | `Implemented` | Path canonicalization (`isPathInside`), command parsing without chaining (`parseCommand`), origin gating, cwd jailing |
| **Human Approval** | `Implemented` | Risk-level gating (`LOW`, `MEDIUM`, `HIGH`, `CRITICAL`), interactive console & custom UI handlers |
| **Per-Run Lifecycle & State Machine**| `Implemented` | `RunStateMachine`, per-run `RunContext` with real `AbortSignal` cancellation and concurrent run isolation |
| **Event Bus** | `Implemented` | High-throughput typed `EventBus` with wildcard matching and traceable events (`runId`, `taskId`) |
| **Durable Tiered Memory** | `Implemented` | SQLite-backed `working`, `long-term`, and `semantic` memory tiers with automated context retrieval and outcome persistence |
| **SQLite Persistence** | `Implemented` | WAL-mode SQLite storage for `runs`, `events`, `state`, `tool_calls`, and `memory_entries` with fail-fast policies |
| **Observability & Tracing** | `Implemented` | Structured latency spans, token metrics, and exportable JSON execution traces |
| **Workspace Runtime Jailing** | `Implemented` | `LocalWorkspace` and `InMemoryWorkspace` enforcing boundary-aware traversal prevention |
| **HTTP / API Tool** | `Implemented` | `http_request` with Zod validation, cancellation support, and origin allow/deny lists |
| **Real Browser Automation** | `Adapter available` | `PlaywrightBrowserProvider` driving real Chrome/Edge; `VirtualBrowserProvider` available for unit tests |
| **Code Interpreter Execution** | `Adapter available` | `OpenInterpreterAdapter` executing Python/Shell/Node in monitored subprocesses |
| **OpenHands Ecosystem Adapter** | `Adapter available` | `OpenHandsWorkspaceAdapter` and `OpenHandsEventMapper` translating actions & observations |
| **Audit Timeline Reconstruction** | `Implemented` | `agent.reconstructTimeline(runId)` reconstructing runs, events, and tool logs from SQLite |
| **Deterministic Simulation Re-Execution** | `Experimental` | Re-running reasoning loop against recorded mock responses |
| **OS-Level Container Sandboxing** | `Planned` | Docker / Firecracker microVM execution for untrusted host commands |
| **Control Plane Scheduler & Queue** | `Planned` | Persistent recurring cron jobs and background worker task queue |
| **Desktop GUI Application** | `Experimental` | Preview CLI and developer desktop playground under `agentos/apps/` |

---

## 🏛️ Architecture & Philosophy

```
                         AGENTOS
                            │
             ┌──────────────┴──────────────┐
             │                             │
       Agent Runtime                 Control Plane
             │                             │
      ┌──────┼────────┐             ┌──────┼──────┐
      │      │        │             │      │      │
   Planner Memory   Context      Policy  Events  State
      │
      ▼
    Tools
      │
 ┌────┼─────────────┬─────────────┐
 ▼    ▼             ▼             ▼
Web  Files       Terminal      Interpreter / Upstream
 │
 ├── Playwright Real Browser (Chrome/Edge)
 ├── VirtualBrowserSession (Fast Unit Tests)
 ├── Open Browser Use Bridge
 └── Browser Use Schema Patterns
```

* **🧠 Brain**: LLM Provider abstraction, ReAct task decomposition, SQLite durable memory, and prompt context injection.
* **✋ Hands**: Node.js & workspace filesystem tools, hardened terminal execution, HTTP request tools, real Playwright browser automation, and Open Interpreter multi-language code execution.
* **⚡ Nervous System**: Strongly typed `EventBus`, capability-based `PermissionEngine`, Human-in-the-Loop `ApprovalManager`, SQLite persistence, and structured `Tracer`.

---

## 🚀 Quickstart

### Installation & Build

```bash
# Clone the repository
git clone https://github.com/Fadhlijeu/AgentOS.git
cd AgentOS

# Install dependencies across all workspace packages
pnpm install

# Build all packages to dist/
pnpm build
```

### Real Browser Agent Example

```typescript
import {
  Agent,
  OpenAIProvider,
  browserTools,
  PlaywrightBrowserProvider,
  ConsoleApprovalHandler,
} from "@agentos/sdk";

// Initialize real Playwright browser provider (uses local Chrome or Edge)
const browserProvider = new PlaywrightBrowserProvider({
  headless: true,
});

const agent = new Agent({
  model: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY! }),
  tools: browserTools({ provider: browserProvider }),
  permissions: {
    browser: {
      allowOrigins: ["https://example.com", "https://news.ycombinator.com"],
      denyOrigins: ["https://untrusted-site.com"],
    },
    approval: {
      requireFor: "HIGH",
    },
  },
  approvalHandler: new ConsoleApprovalHandler(),
});

const result = await agent.run(
  "Navigate to https://example.com, inspect the page, and report the headline."
);

console.log("Agent result:\n", result.output);
agent.dispose();
```

---

## 📦 Packages in Monorepo

| Package | Purpose |
| :--- | :--- |
| [`@agentos/sdk`](./agentos/packages/sdk) | Unified client entry point bundling all runtime, tooling, and adapter modules |
| [`@agentos/agent`](./agentos/packages/agent) | Main agent runtime and `AgentRuntime` orchestrator coordinating multi-run lifecycles |
| [`@agentos/core`](./agentos/packages/core) | Shared types, enums, `ModelProvider`, `WorkspaceAdapter`, `BrowserSession` |
| [`@agentos/events`](./agentos/packages/events) | Strongly typed event bus, wildcard handlers, and traceable event stream |
| [`@agentos/tools`](./agentos/packages/tools) | Tool contracts, `ToolRegistry`, filesystem tools, terminal tools, HTTP, and browser tools |
| [`@agentos/permissions`](./agentos/packages/permissions) | Path jailing (`isPathInside`), safe command parser (`parseCommand`), origin policies |
| [`@agentos/planner`](./agentos/packages/planner) | ReAct reasoning planner with system prompt task decomposition |
| [`@agentos/memory`](./agentos/packages/memory) | Durable SQLite memory manager with tiered retrieval (`working`, `long-term`, `semantic`) |
| [`@agentos/storage`](./agentos/packages/storage) | SQLite persistence using `better-sqlite3` with WAL mode, indexing, and audit tables |
| [`@agentos/observability`](./agentos/packages/observability) | Structured tracing, execution latency metrics, and JSON trace export |
| [`@agentos/runtime`](./agentos/packages/runtime) | `RunStateMachine`, isolated `RunContext` with `AbortSignal`, `AgentRun` handles |
| [`@agentos/adapters`](./agentos/packages/adapters) | Real `PlaywrightBrowserProvider`, `OpenInterpreterAdapter`, `OpenHandsWorkspaceAdapter` |
| [`@agentos/playground`](./agentos/apps/playground) | Interactive CLI application to explore and verify agent capabilities |

---

## 🧪 Verification & Testing

```bash
# Run complete test suite (all unit, security, concurrency, memory, workspace tests)
pnpm test

# Run real browser integration test
pnpm run test:real-browser

# Run offline ReAct filesystem demo
pnpm example:filesystem

# Check entire repository TypeScript types
pnpm run typecheck
```

---

## 📚 Third-Party Provenance & Upstream Bridges

AgentOS incorporates design patterns and adapters from the following open-source projects:
* [OpenHands Software Agent SDK](https://github.com/OpenHands/software-agent-sdk) (`22c85eb0e0db8f4386380d095e9fe6933af2e65f`) — MIT
* [Browser Use](https://github.com/browser-use/browser-use) (`d8110c5ff87ccba887aaa726cdb780f2f84bef8d`) — MIT
* [Open Browser Use](https://github.com/open-browser-use/open-browser-use) (`7765002ac88040aedc781be89afe68475a9d6c88`) — MIT
* [Open Interpreter](https://github.com/openinterpreter/openinterpreter) (`5db50b2e93224dda720462f02fc2858cbd112eb5`) — Apache-2.0

Full provenance, license verification, and integration contracts are documented in [THIRD_PARTY.md](./THIRD_PARTY.md) and [integrations/](./integrations/).

---

## 📄 License

MIT © 2026 Fadhli

# AgentOS

> *The runtime for AI agents that operate computers.*

[![TypeScript](https://img.shields.io/badge/TypeScript-5.5+-blue.svg)](https://www.typescriptlang.org/)
[![pnpm](https://img.shields.io/badge/pnpm-workspace-orange.svg)](https://pnpm.io/)
[![Node.js](https://img.shields.io/badge/Node.js->=18.0.0-green.svg)](https://nodejs.org/)
[![Status](https://img.shields.io/badge/Status-v0.1--MVP-brightgreen.svg)]()
[![License](https://img.shields.io/badge/License-MIT-purple.svg)]()

AgentOS is a general-purpose, embeddable agent execution platform that provides the runtime layer for AI agents capable of operating computers. It decouples the core agent reasoning loop, tool execution, permissions, state, and observability from any specific application domain.

---

## 🏛️ Architecture & Philosophy

AgentOS is built around three fundamental pillars:

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
Web  Files       Terminal      Computer
```

* **🧠 Brain**: LLM Provider abstraction, ReAct task decomposition, Multi-tier memory (working, long-term, semantic), and Observation loop.
* **✋ Hands**: Extensible tool system with Zod schema definitions, Node.js filesystem tools (`read`, `write`, `list`, `exists`, `move`, `delete`), and sandboxed terminal execution (`exec`).
* **⚡ Nervous System**: Strongly typed `EventBus` emitting 15 lifecycle events, capability-based `PermissionEngine`, Human-in-the-Loop `ApprovalManager`, SQLite persistence, and structured execution `Tracer`.

---

## 🚀 Quickstart

Install dependencies and build the workspace:

```bash
# Clone the repository
git clone https://github.com/Fadhlijeu/AgentOS.git
cd AgentOS

# Install dependencies across all workspace packages
pnpm install

# Build all packages to dist/
pnpm build
```

### Simple Agent Example

```typescript
import {
  Agent,
  OpenAIProvider,
  filesystemTools,
  terminalTools,
  ConsoleApprovalHandler,
} from "@agentos/sdk";

const agent = new Agent({
  model: new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY,
  }),
  tools: [
    ...filesystemTools(),
    ...terminalTools(),
  ],
  permissions: {
    terminal: {
      allow: ["ls", "dir", "cat", "git", "node"],
      deny: ["rm", "del", "format"],
    },
    approval: {
      requireFor: "HIGH", // Prompt for user approval before dangerous operations
    },
  },
  approvalHandler: new ConsoleApprovalHandler(),
});

const result = await agent.run(
  "Find the latest summary file in the workspace, inspect its contents, and report the key metrics."
);

console.log("Agent output:\n", result.output);
```

---

## 📦 Packages in Monorepo

| Package | Purpose |
| :--- | :--- |
| [`@agentos/sdk`](./agentos/packages/sdk) | Unified entry point bundling all AgentOS runtime and tooling modules |
| [`@agentos/agent`](./agentos/packages/agent) | Main agent runtime coordinating observe → reason → act → verify loop |
| [`@agentos/core`](./agentos/packages/core) | Shared types, `ModelProvider`, `OpenAIProvider`, and `MockModelProvider` |
| [`@agentos/events`](./agentos/packages/events) | Strongly typed event bus, wildcard handlers, and event history log |
| [`@agentos/tools`](./agentos/packages/tools) | Tool contracts, `ToolRegistry`, filesystem tools, and terminal exec |
| [`@agentos/permissions`](./agentos/packages/permissions) | Path prefix restrictions, command allow/denylists, and approval flow |
| [`@agentos/planner`](./agentos/packages/planner) | ReAct reasoning planner with system prompt task decomposition |
| [`@agentos/memory`](./agentos/packages/memory) | Memory manager supporting working, long-term, and semantic tiers |
| [`@agentos/storage`](./agentos/packages/storage) | SQLite persistence using `better-sqlite3` with WAL mode and indexing |
| [`@agentos/observability`](./agentos/packages/observability) | Structured tracing, execution latency metrics, and JSON trace export |
| [`@agentos/runtime`](./agentos/packages/runtime) | Task lifecycle controllers and status transition management |
| [`@agentos/adapters`](./agentos/packages/adapters) | Integration abstractions for Browser automation, interpreters, and sandboxes |
| [`@agentos/playground`](./agentos/apps/playground) | Interactive CLI application to explore agent capabilities |

---

## 🧪 Verification & Testing

AgentOS includes an end-to-end automated test suite and offline verification examples that run deterministically using `MockModelProvider` without requiring external API keys.

```bash
# Run automated E2E test suite (7/7 tests)
pnpm test

# Run offline ReAct filesystem demo
pnpm example:filesystem

# Run interactive CLI playground
pnpm playground

# Run real OpenAI agent (requires OPENAI_API_KEY)
OPENAI_API_KEY="sk-..." pnpm example:basic "Summarize workspace structure"
```

---

## 🔒 Security & Guardrails

* **Fine-Grained Permissions**: Restrict filesystem reads and writes to specific directory trees.
* **Terminal Command Filtering**: Enforce whitelist and blacklist matching on executed shell commands.
* **Human Approval**: Configurable risk-level threshold (`LOW`, `MEDIUM`, `HIGH`, `CRITICAL`). Actions matching or exceeding the threshold require explicit approval via terminal prompt or custom UI handler.
* **Lifecycle Control**: First-class support for `agent.pause()`, `agent.resume()`, and `agent.cancel()`.

---

## 📚 Third-Party Provenance

This project references and integrates design patterns from open-source agent ecosystems:
* [OpenHands Software Agent SDK](https://github.com/OpenHands/software-agent-sdk)
* [Browser Use](https://github.com/browser-use/browser-use)
* [Open Browser Use](https://github.com/open-browser-use/open-browser-use)
* [Open Interpreter](https://github.com/openinterpreter/openinterpreter)
* [DeepDOM-Agent](https://github.com/fadhlijeu/DeepDOM-Agent) & [deep-browser](https://github.com/fadhlijeu/deep-browser)

Full provenance details are documented in [THIRD_PARTY.md](./THIRD_PARTY.md).

---

## 📄 License

MIT © 2026 Fadhli

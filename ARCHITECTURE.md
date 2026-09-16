# AgentOS Architecture

## Overview

AgentOS is a general-purpose agent runtime/platform providing the execution layer for AI agents. It consists of two primary components:

- **Agent Runtime**: Core agent execution, planning, tools, memory, state, events, permissions, approval, observability, replay, and persistence
- **Control Plane**: Policy, planning, and higher-level orchestration

```
                         AGENTOS
                            │
             ┌──────────────┴──────────────┐
             │                             │
      Agent Runtime                  Control Plane
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
 │
 ├── DeepDOM
 ├── Browser Use
 └── Open Browser Use
```

## Core Abstractions

### Agent Interface
```typescript
interface Agent {
  run(task: string): Promise<AgentResult>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  cancel(): Promise<void>;
}
```

### Model Provider Abstraction
```typescript
interface ModelProvider {
  generate(request: ModelRequest): Promise<ModelResponse>;
}
```

### Tool System
```typescript
interface Tool<Input, Output> {
  name: string;
  description: string;
  inputSchema: Schema;
  riskLevel: RiskLevel;
  execute(input: Input, ctx: ToolContext): Promise<Output>;
}
```

### Permission System
- Capability-based permissions per tool
- Path restrictions for filesystem
- Command restrictions for terminal
- Origin restrictions for browser
- Approval policies for risk levels

### Event System
Every important operation produces serializable events:
- agent.started, task.started, plan.created, tool.requested, tool.started, tool.completed, tool.failed, approval.required, approval.granted, approval.denied, memory.updated, agent.paused, agent.resumed, task.completed, task.failed

### Memory System
- Working Memory: current task, current observations, current plan
- Long-Term Memory: preferences, facts, previous outcomes
- Semantic Memory: embeddings, retrieval, knowledge

### Workspace Abstraction
```typescript
interface Workspace {
  read(...): Promise<any>;
  write(...): Promise<any>;
  list(...): Promise<any>;
  delete(...): Promise<any>;
  exists(...): Promise<boolean>;
}
```

### Browser Provider Abstraction
```typescript
interface BrowserProvider {
  createSession(): Promise<BrowserSession>;
}
```

## Design Principles

1. **Domain-agnostic**: AgentOS core does not care about the application domain
2. **Pluggable**: LLM providers, tools, memory, and workspace are all replaceable
3. **Observable**: Every task is fully traceable with structured observability
4. **Replayable**: Completed runs are exportable and deterministic where possible
5. **Secure**: Capability permissions, path restrictions, approval policies are first-class
6. **Extensible**: New tools, providers, and workspaces can be added without modifying core

## v0.1 MVP Requirements

Must support:
- Agent with run/pause/resume/cancel
- Model abstraction (multiple LLM providers)
- Tool system (filesystem, terminal, browser adapter)
- Planner/reasoning loop
- Permissions
- Human approval
- Event system
- SQLite persistence
- Task execution
- Basic replay/logging

## Key Task Flow

```
Task
  ↓
Plan (Planner)
  ↓
LLM decision
  ↓
Tool call
  ↓
Tool result
  ↓
Observation
  ↓
Next action (repeat until done)
```

## Integration Points

- **DeepDOM**: Browser DOM abstraction
- **Browser Use**: Browser automation engine
- **Open Browser Use**: Local browser control with MCP
- **Open Interpreter**: Local execution, terminal, code execution
- **OpenHands SDK**: Agent architecture reference
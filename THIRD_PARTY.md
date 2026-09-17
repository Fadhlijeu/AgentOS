# Third-Party Provenance & Upstream Integration Record

This document provides complete, reproducible provenance for all third-party open-source repositories integrated into AgentOS. Each project is tracked by an exact immutable commit SHA, upstream URL, verified license, integration boundary, layer ownership, and specific reused subsystems.

---

## 1. OpenHands Software Agent SDK

- **Repository**: [OpenHands/software-agent-sdk](https://github.com/OpenHands/software-agent-sdk)
- **Upstream URL**: https://github.com/OpenHands/software-agent-sdk
- **License**: MIT License ([software-agent-sdk/LICENSE](file:///D:/PROJECT/AgentOS/software-agent-sdk/LICENSE))
- **Exact Commit SHA**: `22c85eb0e0db8f4386380d095e9fe6933af2e65f`
- **Local Path**: `D:\PROJECT\AgentOS\software-agent-sdk`
- **Reused Subsystems**:
  - Workspace abstraction patterns (`openhands-workspace`)
  - Event hierarchy & Action/Observation paradigm (`openhands-sdk`)
  - Tool design patterns and conversation schemas (`openhands-tools`)
- **Integration Method**:
  - Adapter bridge via [`OpenHandsWorkspaceAdapter`](file:///D:/PROJECT/AgentOS/agentos/packages/adapters/src/openhands.ts) implementing AgentOS `WorkspaceAdapter`.
  - Bidirectional event mapping via `OpenHandsEventMapper` converting OpenHands `Action`/`Observation` into typed AgentOS `AgentEvent`.
- **Layer Ownership**:
  - *AgentOS owns*: Orchestration, security permissions (`PermissionEngine`), human approval (`ApprovalManager`), SQLite persistence, and runtime state machine.
  - *OpenHands pattern provides*: Workspace sandboxing semantics and action/observation event mapping.
- **Omitted Subsystems & Rationale**:
  - Python agent-server runtime (`openhands-agent-server`): Omitted from TypeScript core to maintain zero-overhead native execution; integrated via adapter protocol.
- **Modifications**:
  - Upstream repository preserved pristine at commit `22c85eb0e0db8f4386380d095e9fe6933af2e65f`. Adapters reside in `@agentos/adapters`.
- **Attribution**: Copyright (c) 2026 OpenHands contributors. MIT License.

---

## 2. Browser Use

- **Repository**: [browser-use/browser-use](https://github.com/browser-use/browser-use)
- **Upstream URL**: https://github.com/browser-use/browser-use
- **License**: MIT License ([browser-use/LICENSE](file:///D:/PROJECT/AgentOS/browser-use/LICENSE))
- **Exact Commit SHA**: `d8110c5ff87ccba887aaa726cdb780f2f84bef8d`
- **Local Path**: `D:\PROJECT\AgentOS\browser-use`
- **Reused Subsystems**:
  - Browser automation perception-action loop design
  - DOM tree parsing and interactive element filtering (`browser_use/dom`)
  - Browser controller contracts (`browser_use/controller`)
- **Integration Method**:
  - Pattern and protocol implementation in `@agentos/tools/src/browser.ts` and `@agentos/adapters/src/playwright-browser.ts`.
  - Real browser execution driven by Playwright targeting system Chrome/Edge or Python CLI bridge.
- **Layer Ownership**:
  - *AgentOS owns*: Browser permission policies (`allowOrigins`, `denyOrigins`, protocol checks), risk-level approval gating, structured telemetry, trace JSON export.
  - *Browser Use provides*: Action schema inspiration (navigate, click, type, observe, screenshot).
- **Modifications**:
  - Upstream repository preserved pristine at commit `d8110c5ff87ccba887aaa726cdb780f2f84bef8d`.
- **Attribution**: Copyright (c) 2024 Gregor Zunic. MIT License.

---

## 3. Open Browser Use

- **Repository**: [open-browser-use/open-browser-use](https://github.com/open-browser-use/open-browser-use)
- **Upstream URL**: https://github.com/open-browser-use/open-browser-use
- **License**: MIT License ([open-browser-use/LICENSE](file:///D:/PROJECT/AgentOS/open-browser-use/LICENSE))
- **Exact Commit SHA**: `7765002ac88040aedc781be89afe68475a9d6c88`
- **Local Path**: `D:\PROJECT\AgentOS\open-browser-use`
- **Reused Subsystems**:
  - Browser-control core types & DOM locator conventions (`packages/browser-control-core`)
  - Snapshot text formatting (`packages/sdk/src/snapshot-text.ts`)
  - Guardrail and policy structures (`packages/sdk/src/guards.ts`)
- **Integration Method**:
  - Concrete adapter in `@agentos/adapters/src/playwright-browser.ts` adhering to the Playwright-shaped SDK conventions established by open-browser-use.
- **Layer Ownership**:
  - *AgentOS owns*: Security isolation, approval checks, run lifecycle, and SQLite storage.
  - *Open Browser Use provides*: DOM extraction and element interaction semantics.
- **Modifications**:
  - Upstream repository preserved pristine at commit `7765002ac88040aedc781be89afe68475a9d6c88`.
- **Attribution**: Copyright (c) 2026 open-browser-use contributors. MIT License.

---

## 4. Open Interpreter

- **Repository**: [openinterpreter/openinterpreter](https://github.com/openinterpreter/openinterpreter)
- **Upstream URL**: https://github.com/openinterpreter/openinterpreter
- **License**: Apache License 2.0 ([openinterpreter/LICENSE](file:///D:/PROJECT/AgentOS/openinterpreter/LICENSE))
- **Exact Commit SHA**: `5db50b2e93224dda720462f02fc2858cbd112eb5`
- **Local Path**: `D:\PROJECT\AgentOS\openinterpreter`
- **Reused Subsystems**:
  - Multi-language code execution patterns (Python, Shell, JavaScript)
  - Subprocess execution isolation and output streaming
  - Interpreter SDK protocol (`sdk/typescript`, `@openai/codex-sdk`)
- **Integration Method**:
  - Concrete adapter in [`OpenInterpreterAdapter`](file:///D:/PROJECT/AgentOS/agentos/packages/adapters/src/open-interpreter.ts) implementing `CodeInterpreterAdapter`.
  - Bridges execution to controlled Python/subprocess runners while strictly enforcing AgentOS `PermissionEngine` (`terminal` allow/deny rules) and `ApprovalManager`.
- **Layer Ownership**:
  - *AgentOS owns*: Command parsing (`parseCommand`), operator injection prevention, cwd boundaries, risk classification, approval prompts.
  - *Open Interpreter provides*: Language execution runtime and environment setup.
- **Modifications**:
  - Upstream repository preserved pristine at commit `5db50b2e93224dda720462f02fc2858cbd112eb5`.
- **Attribution**: Copyright (c) 2026 Open Interpreter contributors. Apache-2.0 License.

---

## 5. User-Owned First-Party Components

- **DeepDOM-Agent**: https://github.com/fadhlijeu/DeepDOM-Agent
- **deep-browser**: https://github.com/fadhlijeu/deep-browser
- **Status**: First-party modules developed by the user; treated as native internal blueprints rather than third-party dependencies.
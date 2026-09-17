# Integration: Open Interpreter

- **Upstream Repository**: [openinterpreter/openinterpreter](https://github.com/openinterpreter/openinterpreter)
- **Locked Commit**: `5db50b2e93224dda720462f02fc2858cbd112eb5`
- **License**: Apache License 2.0

## Architecture & Integration Pattern

Open Interpreter provides a local execution environment for autonomous agents to run multi-language code:
1. **Language Execution**: Support for Python, Shell/Bash, JavaScript/Node.
2. **Interactive Subprocess Management**: Execution with timeout control, stdout/stderr streaming, and structured exit statuses.
3. **TypeScript Codex SDK**: Available in `sdk/typescript` (`@openai/codex-sdk`) providing client and runtime bindings.

## AgentOS Bridge Contract

In AgentOS, Open Interpreter code execution is integrated via:
- **Adapter**: [`OpenInterpreterAdapter`](file:///D:/PROJECT/AgentOS/agentos/packages/adapters/src/open-interpreter.ts) implementing `CodeInterpreterAdapter`.
- **Tool**: `code_interpret` tool created via `createInterpreterTool()`.
- **Control Plane Invariant**: All code executions are subject to `PermissionEngine` command policy and `ApprovalManager` risk-level gates before subprocess execution.

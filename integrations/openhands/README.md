# Integration: OpenHands Software Agent SDK

- **Upstream Repository**: [OpenHands/software-agent-sdk](https://github.com/OpenHands/software-agent-sdk)
- **Locked Commit**: `22c85eb0e0db8f4386380d095e9fe6933af2e65f`
- **License**: MIT License

## Architecture & Integration Pattern

OpenHands Software Agent SDK provides a comprehensive ecosystem for software engineering agents:
1. **Workspace Sandboxing**: Isolated directory boundaries (`openhands-workspace`).
2. **Action/Observation Event Flow**: Typed pairs of actions (`CmdRunAction`, `FileReadAction`, `FileWriteAction`, `BrowseURLAction`) and corresponding observations (`CmdOutputObservation`, `FileReadObservation`, etc.).
3. **Agent State Model**: Tracking agent status through discrete state transitions.

## AgentOS Bridge Contract

In AgentOS, OpenHands is integrated via:
- **Workspace Adapter**: [`OpenHandsWorkspaceAdapter`](file:///D:/PROJECT/AgentOS/agentos/packages/adapters/src/openhands.ts) implementing `WorkspaceAdapter` with canonical boundary enforcement.
- **Event Mapping**: `OpenHandsEventMapper` converts OpenHands actions and observations to AgentOS typed `AgentEvent` objects (`tool.requested`, `tool.completed`, `tool.failed`).
- **Omitted Subsystems**: The heavy Python agent-server runtime (`openhands-agent-server`) is deliberately not bundled into TypeScript core; AgentOS provides its own ultra-fast native TypeScript `AgentRuntime` while preserving protocol compatibility.

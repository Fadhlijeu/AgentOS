# Integration: Browser Use

- **Upstream Repository**: [browser-use/browser-use](https://github.com/browser-use/browser-use)
- **Locked Commit**: `d8110c5ff87ccba887aaa726cdb780f2f84bef8d`
- **License**: MIT License

## Architecture & Integration Pattern

`browser-use` provides battle-tested patterns for AI agents interacting with web browsers:
1. **DOM Perception**: Extraction of clickable, interactive elements and hierarchical tree simplification.
2. **Action Controllers**: Standardized primitives for browser interaction (`navigate`, `click`, `type`, `screenshot`, `scroll`).
3. **Agent Loop Integration**: How browser observations are returned to LLMs as concise, token-efficient state representations.

## AgentOS Bridge Contract

In AgentOS, browser interaction is governed by:
- **Interface**: `BrowserProviderAdapter` and `BrowserSession` in `@agentos/core`.
- **Runtime Tools**: `browserTools({ provider })` in `@agentos/tools`.
- **Concrete Engine**: `PlaywrightBrowserProvider` in `@agentos/adapters`.
- **Security & Governance**: `PermissionEngine` (`allowOrigins`, `denyOrigins`, protocol validation) and `ApprovalManager`.

No browser navigation can occur without passing through AgentOS permission and approval gates.

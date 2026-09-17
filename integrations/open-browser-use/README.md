# Integration: Open Browser Use

- **Upstream Repository**: [open-browser-use/open-browser-use](https://github.com/open-browser-use/open-browser-use)
- **Locked Commit**: `7765002ac88040aedc781be89afe68475a9d6c88`
- **License**: MIT License

## Architecture & Integration Pattern

`open-browser-use` implements a high-performance, Playwright-shaped browser control protocol and SDK:
1. **Protocol Types**: Defined in `packages/browser-control-core`.
2. **Locator & Query Abstraction**: Accessible in `packages/sdk/src/locator.ts`.
3. **Snapshot Text Engine**: Formats the DOM and accessibility tree into clean, parseable text (`packages/sdk/src/snapshot-text.ts`).
4. **Guards & Policy Checks**: Pre-flight verification before dispatching DOM clicks or form inputs.

## AgentOS Bridge Contract

AgentOS implements the Playwright-shaped SDK conventions established by Open Browser Use in `@agentos/adapters/src/playwright-browser.ts`:
- Emits structured DOM observations (tag, selector, text, type, href).
- Integrates with `classifyToolError` to distinguish locator timeouts from network failures.
- Directly supports local Chrome and Microsoft Edge sessions via Playwright.

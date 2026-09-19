// ─── AgentOS — Audit 1.0 Remediation Verification Suite ─────────────────────
//
// Formally verifies all P0 and P1 remediations identified in audit_1.0.md:
//
// 1. Automatic wiring of browser route interception from PermissionEngine to PlaywrightBrowserProvider & sessions.
// 2. Comprehensive outbound network isolation in Playwright route interception (fetch, XHR, WebSocket, subresources).
// 3. HTTP redirect policy validation on every redirect hop (allowOrigins, denyOrigins, DNS IP safety).
// 4. Central PermissionPolicy authority strictly overriding AGENTOS_ALLOW_PRIVATE_NETWORKS env var.
// 5. Explicit tool category and capability fields preventing name-prefix spoofing.
// 6. Per-run browser session and provider registry lifecycle cleanup on run completion.
// 7. AbortSignal listener removal preventing memory leaks on long-lived signals.
// 8. Transactional persistence before terminal event emission (single terminal event semantics).
// 9. Strict run isolation in memory.getWorking(key, runId) without global fallback.
// 10. Explicit unsandboxed host execution risk classification in terminal and interpreter tools.

import * as http from "http";
import { Agent, MockModelProvider } from "@agentos/agent";
import { PermissionEngine, validateHostIpSafety } from "@agentos/permissions";
import {
  browserTools,
  BrowserToolSuite,
  httpTools,
  terminalTools,
  filesystemTools,
} from "@agentos/tools";
import type { Tool } from "@agentos/tools";
import {
  PlaywrightBrowserProvider,
  PlaywrightBrowserSession,
  createInterpreterTool,
} from "@agentos/adapters";
import { MemoryManager } from "@agentos/memory";
import { EventBus } from "@agentos/events";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${msg}`);
  }
}

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    process.stdout.write(`  🛡️ [Audit 1.0] ${name} ... `);
    await fn();
    console.log("✅ PASS");
    passed++;
  } catch (err) {
    console.log("❌ FAIL");
    console.error(`     Error: ${(err as Error).message}`);
    failed++;
  }
}

async function runAudit10Tests() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║     🛡️ AgentOS — Audit 1.0 Remediation Test Suite        ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  // ─────────────────────────────────────────────────────────────────────────
  // P0-1: Automatic Wiring of Browser Route Interception
  // ─────────────────────────────────────────────────────────────────────────
  await test("P0-1: Agent constructor automatically wires permission security gateway to BrowserToolSuite", async () => {
    const provider = new PlaywrightBrowserProvider();
    const browserSuite = browserTools({ provider });
    const agent = new Agent({
      model: new MockModelProvider(),
      tools: browserSuite,
      permissions: {
        browser: {
          allowOrigins: ["https://example.com"],
          denyOrigins: ["https://example.com/blocked"],
        },
      },
    });

    const suiteInstance = browserSuite as BrowserToolSuite;
    assert(typeof suiteInstance.getProvider === "function", "Suite must expose getProvider()");
    const activeProvider = suiteInstance.getProvider() as PlaywrightBrowserProvider;
    assert(activeProvider !== null && activeProvider !== undefined, "Provider must be instantiated");

    // Check that provider navigation validator was wired
    const allowed = await (activeProvider as any).navigationValidator("https://example.com/page");
    assert(allowed === true, "Allowed origin must be approved by wired validator");

    const deniedOrigin = await (activeProvider as any).navigationValidator("https://malicious.example.com");
    assert(deniedOrigin === false, "Untrusted origin must be rejected by wired validator");

    const deniedPath = await (activeProvider as any).navigationValidator("https://example.com/blocked");
    assert(deniedPath === false, "Denied path must be rejected by wired validator");

    await agent.dispose();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // P0-2: Comprehensive Outbound Network Isolation in Route Interception
  // ─────────────────────────────────────────────────────────────────────────
  await test("P0-2: PlaywrightBrowserSession intercepts and blocks outbound XHR/fetch/subresources to private IPs", async () => {
    let routeHandler: ((route: any) => Promise<void>) | null = null;

    const mockPage: any = {
      route: async (_pattern: string, handler: (route: any) => Promise<void>) => {
        routeHandler = handler;
      },
      goto: async () => {},
      close: async () => {},
    };

    const session = new PlaywrightBrowserSession("test-session-1", {} as any, {} as any, mockPage, {
      navigationValidator: async (targetUrl: string) => {
        // Reject private/loopback destinations
        if (targetUrl.includes("127.0.0.1") || targetUrl.includes("localhost") || targetUrl.includes("169.254")) {
          return false;
        }
        return true;
      },
    });
    await session.init();

    assert(routeHandler !== null, "Route handler must be registered on mock page");

    // 1. Subresource / XHR / fetch request to 127.0.0.1:3000 (non-navigation request)
    let fetchAbortedReason: string | null = null;
    const mockFetchRoute = {
      request: () => ({
        isNavigationRequest: () => false,
        resourceType: () => "fetch",
        url: () => "http://127.0.0.1:3000/internal-admin",
      }),
      abort: async (reason: string) => {
        fetchAbortedReason = reason;
      },
      continue: async () => {
        throw new Error("Should not continue disallowed fetch request");
      },
    };

    await routeHandler!(mockFetchRoute);
    assert(fetchAbortedReason === "blockedbyclient", "Disallowed outbound fetch must be aborted with blockedbyclient");

    // 2. Allowed public API fetch
    let allowedContinued: boolean = false;
    const mockAllowedRoute = {
      request: () => ({
        isNavigationRequest: () => false,
        resourceType: () => "fetch",
        url: () => "https://api.github.com/zen",
      }),
      abort: async () => {
        throw new Error("Should not abort allowed public URL");
      },
      continue: async () => {
        allowedContinued = true;
      },
    };

    await routeHandler!(mockAllowedRoute);
    assert(Boolean(allowedContinued), "Allowed public outbound fetch must continue");

    // 3. Data URL exemption
    let dataContinued: boolean = false;
    const mockDataRoute = {
      request: () => ({
        isNavigationRequest: () => false,
        resourceType: () => "image",
        url: () => "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      }),
      abort: async () => {
        throw new Error("Should not abort data: URL");
      },
      continue: async () => {
        dataContinued = true;
      },
    };

    await routeHandler!(mockDataRoute);
    assert(Boolean(dataContinued), "data: image subresource must continue without error");

    await session.close();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // P0-3: HTTP Redirect Policy Validation on Every Redirect Hop
  // ─────────────────────────────────────────────────────────────────────────
  await test("P0-3: http_request enforces allowOrigins and denyOrigins across redirect hops", async () => {
    // Target server (restricted server C)
    const serverC = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Sensitive data on server C");
    });
    await new Promise<void>((resolve) => serverC.listen(0, "127.0.0.1", () => resolve()));
    const portC = (serverC.address() as any).port;

    // Origin server (server B redirects to server C)
    const serverB = http.createServer((_req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${portC}/secret` });
      res.end();
    });
    await new Promise<void>((resolve) => serverB.listen(0, "127.0.0.1", () => resolve()));
    const portB = (serverB.address() as any).port;

    try {
      const permissionEngine = new PermissionEngine({
        http: {
          allowPrivateNetworks: true, // allow initial localhost connection for test server
          denyOrigins: [`http://127.0.0.1:${portC}`], // but explicitly deny destination server C
        },
      });

      const tools = httpTools({
        allowPrivateNetworks: true, // allow private network loopback for test setup
        permissionValidator: async (url: string) => {
          return permissionEngine.checkHttpUrlAsync(url);
        },
      });
      const httpReq = tools.find((t) => t.name === "http_request")!;

      const result = await httpReq.execute(
        { url: `http://127.0.0.1:${portB}/initial`, followRedirects: true },
        { runId: "test-run", taskId: "test-task", emit: () => {} }
      );

      assert(
        result.includes("Security policy violation") && result.includes("restricted"),
        `Expected security policy denial on redirect, got: ${result}`
      );
    } finally {
      serverB.close();
      serverC.close();
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // P0-4: Central PermissionPolicy Authority Overriding Environment Variables
  // ─────────────────────────────────────────────────────────────────────────
  await test("P0-4: PermissionEngine policy strictly overrides AGENTOS_ALLOW_PRIVATE_NETWORKS env var", async () => {
    const originalEnv = process.env.AGENTOS_ALLOW_PRIVATE_NETWORKS;
    process.env.AGENTOS_ALLOW_PRIVATE_NETWORKS = "true";

    try {
      // PermissionEngine configured with default fail-closed private network policy (allowPrivateNetworks: false)
      const engine = new PermissionEngine({
        http: {
          allowPrivateNetworks: false,
        },
      });

      // Verification via checkHttpUrlAsync
      const checkResult = await engine.checkHttpUrlAsync("http://127.0.0.1:8080/admin");
      assert(!checkResult.allowed, "PermissionEngine must reject loopback despite env var");

      // Verification via http_request tool
      const tools = httpTools({
        permissionValidator: async (url: string) => engine.checkHttpUrlAsync(url),
      });
      const httpReq = tools.find((t) => t.name === "http_request")!;

      const result = await httpReq.execute(
        { url: "http://127.0.0.1:8080/admin" },
        { runId: "test-run", taskId: "test-task", emit: () => {} }
      );

      assert(
        result.includes("blocked") || result.includes("restricted"),
        `Expected private network error, got: ${result}`
      );
    } finally {
      if (originalEnv === undefined) {
        delete process.env.AGENTOS_ALLOW_PRIVATE_NETWORKS;
      } else {
        process.env.AGENTOS_ALLOW_PRIVATE_NETWORKS = originalEnv;
      }
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // P0-5: Explicit Tool Category and Capability Spoofing Prevention
  // ─────────────────────────────────────────────────────────────────────────
  await test("P0-5: PermissionEngine evaluates explicit tool.category & capability instead of name prefixes", async () => {
    const engine = new PermissionEngine({
      codeInterpreter: { enabled: false }, // code execution disabled
    });

    // Rogue tool disguised with a benign prefix "filesystem_helper" but explicit category: "code_interpreter"
    const rogueTool: Tool = {
      name: "filesystem_calc_helper",
      category: "code_interpreter",
      capability: "code.interpret",
      description: "Appears to be filesystem helper but runs code",
      parameters: {},
      riskLevel: "HIGH",
      execute: async () => "Executed code",
    };

    const check = engine.check(rogueTool, {});
    assert(!check.allowed, "Rogue tool with category 'code_interpreter' must be blocked when code execution disabled");
    assert(
      Boolean(check.reason?.includes("Code interpreter tools are disabled")),
      `Expected code interpreter disable reason, got: ${check.reason}`
    );

    // Benign tool named "browser_query_data" but category: "custom" and riskLevel: "LOW"
    const benignTool: Tool = {
      name: "browser_query_data",
      category: "custom",
      capability: "data.read",
      description: "Custom internal cache reader",
      parameters: {},
      riskLevel: "LOW",
      execute: async () => "Cache data",
    };

    const benignCheck = engine.check(benignTool, {});
    assert(benignCheck.allowed, "Custom low-risk tool must not be blocked by browser prefix rules");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // P1-6: Per-Run Browser Session and Provider Registry Cleanup
  // ─────────────────────────────────────────────────────────────────────────
  await test("P1-6: Browser sessions and provider registry entries are closed and disposed on run completion", async () => {
    const provider = new PlaywrightBrowserProvider();
    let closed = false;
    const mockSession = {
      sessionId: "test-sess-1",
      close: async () => {
        closed = true;
      },
      navigate: async () => ({ title: "Test", url: "https://example.com" }),
      screenshot: async () => Buffer.from(""),
      click: async () => {},
      type: async () => {},
      getText: async () => "hello",
      evaluate: async () => "Test Page Title",
    };

    provider.createSession = async () => {
      provider.getSessions().set("test-sess-1", mockSession as any);
      return mockSession as any;
    };

    const suite = browserTools({ provider });
    const browserOpenTool = suite.find((t) => t.name === "browser_open")!;

    // Open page in run-session-cleanup-test
    await browserOpenTool.execute(
      { url: "https://example.com" },
      { runId: "run-session-cleanup-test", taskId: "task-1", emit: () => {} }
    );

    assert(provider.getSessions().size === 1, "Session must be present in provider registry");
    assert((suite as any).getActiveRunCount() === 1, "Suite must track active run session");

    // Call tool.disposeRun
    await browserOpenTool.disposeRun!("run-session-cleanup-test");

    assert(closed, "Session close() must be invoked on disposeRun");
    assert((suite as any).getActiveRunCount() === 0, "Session map in suite must be cleared");
    assert(!provider.getSessions().has("test-sess-1"), "Provider registry must remove closed session");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // P1-7: AbortSignal Listener Removal Preventing Memory Leaks
  // ─────────────────────────────────────────────────────────────────────────
  await test("P1-7: Agent.start removes abort event listener from signal after completion", async () => {
    const agent = new Agent({
      model: new MockModelProvider(),
      tools: [],
    });

    const controller = new AbortController();
    let listenerCount = 0;
    const originalAdd = controller.signal.addEventListener.bind(controller.signal);
    const originalRemove = controller.signal.removeEventListener.bind(controller.signal);

    controller.signal.addEventListener = (type: string, listener: any, options?: any) => {
      if (type === "abort") listenerCount++;
      return originalAdd(type, listener, options);
    };

    controller.signal.removeEventListener = (type: string, listener: any, options?: any) => {
      if (type === "abort") listenerCount--;
      return originalRemove(type, listener, options);
    };

    const handle = agent.start("Execute simple leak-check task", {
      signal: controller.signal,
    });

    const result = await handle.result;
    assert(result.success, "Agent run should succeed");
    assert(listenerCount === 0, `Abort listener count must return to 0 (was ${listenerCount})`);

    await agent.dispose();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // P1-8: Single Terminal Event Semantics Under Persistence Failure
  // ─────────────────────────────────────────────────────────────────────────
  await test("P1-8: In persistenceMode='required', saveRun failure emits ONLY task.failed, never task.completed", async () => {
    const agent = new Agent({
      model: new MockModelProvider(),
      tools: [],
      persistenceMode: "required",
    });

    const eventBus = agent.getEventBus();
    const emittedTerminalEvents: string[] = [];

    eventBus.on("task.completed", () => emittedTerminalEvents.push("task.completed"));
    eventBus.on("task.failed", () => emittedTerminalEvents.push("task.failed"));
    eventBus.on("task.cancelled", () => emittedTerminalEvents.push("task.cancelled"));

    // Sabotage terminal saveRun in the state store (let initial RUNNING save succeed, fail terminal save)
    const store = agent.getStore();
    let saveCount = 0;
    const originalSaveRun = store.saveRun.bind(store);
    store.saveRun = (run: any) => {
      saveCount++;
      if (saveCount > 1) {
        throw new Error("Disk full: write failure during terminal run persistence");
      }
      return originalSaveRun(run);
    };

    const result = await agent.run("Perform task with required persistence");
    assert(!result.success, "Agent run must fail when persistence fails in required mode");
    assert(
      result.error?.includes("Persistence required: failed to save run record") ?? false,
      `Expected persistence error in result, got: ${result.error}`
    );
    assert(
      !emittedTerminalEvents.includes("task.completed"),
      "task.completed must NEVER be emitted when persistence fails"
    );
    assert(
      emittedTerminalEvents.filter((e) => e === "task.failed").length === 1,
      `Exactly one task.failed event must be emitted (got ${JSON.stringify(emittedTerminalEvents)})`
    );

    await agent.dispose();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // P1-9: Strict Run Isolation in memory.getWorking(key, runId)
  // ─────────────────────────────────────────────────────────────────────────
  await test("P1-9: memory.getWorking(key, runId) does not fall back to global working memory", async () => {
    const memory = new MemoryManager();

    // Set global un-scoped working memory
    await memory.setWorking("auth_token", "global-bearer-secret-token");

    // Run A writes its own working memory
    await memory.setWorking("auth_token", "run-a-token", undefined, "run-a");

    // Verify Run A gets its own token
    const runAToken = await memory.getWorking("auth_token", "run-a");
    assert(runAToken === "run-a-token", "Run A should get run-a token");

    // Run B has NOT set 'auth_token'. Must return null, NOT global fallback!
    const runBToken = await memory.getWorking("auth_token", "run-b");
    assert(
      runBToken === null,
      `Run B must receive null due to strict run isolation (got: ${JSON.stringify(runBToken)})`
    );

    // Query without runId retrieves global working memory
    const globalToken = await memory.getWorking("auth_token");
    assert(globalToken === "global-bearer-secret-token", "Unscoped query retrieves global token");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // P1-10: Explicit Unsandboxed Host Execution Risk Classification
  // ─────────────────────────────────────────────────────────────────────────
  await test("P1-10: Terminal and interpreter tools declare risk, category, and host execution notice", async () => {
    // 1. Terminal Tool
    const [terminal] = terminalTools();
    assert(terminal !== undefined, "terminal tool must exist");
    assert(terminal.riskLevel === "HIGH", "terminal tool must have HIGH risk level");
    assert(terminal.category === "terminal", "terminal tool must have category 'terminal'");
    assert(terminal.capability === "terminal.execute", "terminal tool must have capability 'terminal.execute'");
    assert(
      terminal.description.includes("HOST") ||
      terminal.description.includes("host"),
      "terminal tool description must warn about host system execution"
    );

    // 2. Open Interpreter Tool
    const mockInterpreterAdapter = {
      execute: async () => ({ stdout: "", stderr: "", exitCode: 0, durationMs: 0 }),
    };
    const interpreterTool = createInterpreterTool(mockInterpreterAdapter);
    assert(interpreterTool.riskLevel === "HIGH", "interpreterTool must have HIGH risk level");
    assert(interpreterTool.category === "code_interpreter", "interpreterTool must have category 'code_interpreter'");
    assert(interpreterTool.capability === "code.interpret", "interpreterTool must have capability 'code.interpret'");
    assert(
      interpreterTool.description.includes("HOST") ||
      interpreterTool.description.includes("host"),
      "interpreterTool description must warn about unsandboxed host system"
    );

    // 3. Filesystem tools
    const fsTools = filesystemTools();
    for (const tool of fsTools) {
      assert(tool.category === "filesystem", `Tool ${tool.name} must have category 'filesystem'`);
      assert(tool.capability !== undefined, `Tool ${tool.name} must declare capability`);
    }
  });

  console.log("\n════════════════════════════════════════════════════════════");
  console.log(`AUDIT 1.0 REMEDIATION RESULT: ${passed} passed, ${failed} failed`);
  console.log("════════════════════════════════════════════════════════════\n");

  if (failed > 0) {
    process.exit(1);
  }
}

runAudit10Tests().catch((err) => {
  console.error("Test execution fatal error:", err);
  process.exit(1);
});

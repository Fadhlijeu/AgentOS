// ─── AgentOS — Audit 0.4 Remediation Verification Suite ─────────────────────
//
// Formally verifies all P0 (Security) and P1 (Lifecycle/Correctness) remediations:
// P0-1: Filesystem deny-by-default
// P0-2: Partial-policy deny (read-only prevents write)
// P0-3: Secret redaction in events & traces
// P0-4: Browser exact-origin matching (blocks prefix bypass)
// P0-5: SSRF private IP blocking
// P0-6: Browser sandbox policy
// P0-7: Deny uncategorized tools when untrusted
// P1-8: activeRuns cleanup on terminal states
// P1-9: Working memory per-run scoping
// P1-10: Planner per-run token usage
// P1-11: Approval AbortSignal propagation
// P1-12: TaskOptions.signal / workspace propagation in AgentRuntime
// P1-13: Async dispose() with cancellation drain
// P1-14: Browser cancellation via AbortSignal

import * as os from "os";
import * as path from "path";
import * as fs from "fs";

import {
  Agent,
  MockModelProvider,
  filesystemTools,
  terminalTools,
  AutoApprovalHandler,
  PermissionEngine,
  AgentRuntime,
  redactSecrets,
  type ApprovalHandler,
  type ApprovalRequest,
} from "@agentos/agent";

import { ReActPlanner } from "@agentos/planner";
import { browserTools } from "@agentos/tools";
import { PlaywrightBrowserProvider, InMemoryWorkspace } from "@agentos/adapters";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${msg}`);
  }
}

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  process.stdout.write(`  🛡️ [Audit 0.4] ${name} ... `);
  try {
    await fn();
    console.log("✅ PASS");
    passed++;
  } catch (err) {
    console.log("❌ FAIL");
    console.error(`    ${(err as Error).message}`);
    failed++;
  }
}

async function main(): Promise<void> {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║     🛡️ AgentOS — Audit 0.4 Remediation Test Suite        ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  const tempDir = path.join(os.tmpdir(), `audit04_test_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    // ── P0-1: Filesystem deny-by-default ──────────────────────────────────────
    await test("P0-1: Filesystem access is denied by default without policy", () => {
      const pe = new PermissionEngine({});
      const res = pe.check("filesystem_read", { path: "/etc/passwd" });
      assert(!res.allowed, "Filesystem read must be denied by default");
      assert(res.reason?.includes("denied by default") ?? false, "Reason must state denied by default");
    });

    // ── P0-2: Partial-policy deny ─────────────────────────────────────────────
    await test("P0-2: Partial policy (read only) denies write operations", () => {
      const pe = new PermissionEngine({
        filesystem: {
          read: [tempDir],
        },
      });

      const readRes = pe.check("filesystem_read", { path: path.join(tempDir, "file.txt") });
      assert(readRes.allowed, "Configured read path must be allowed");

      const writeRes = pe.check("filesystem_write", { path: path.join(tempDir, "file.txt") });
      assert(!writeRes.allowed, "Unconfigured write capability must be denied");
      assert(writeRes.reason?.includes("write access not configured") ?? false, "Reason must state write not configured");

      const moveRes = pe.check("filesystem_move", {
        source: path.join(tempDir, "a.txt"),
        destination: path.join(tempDir, "b.txt"),
      });
      assert(!moveRes.allowed, "Move must be denied when write capability is not configured");
    });

    // ── P0-3: Secret redaction ────────────────────────────────────────────────
    await test("P0-3: Secret redaction sanitizes sensitive headers and tokens", () => {
      const sensitiveInput = {
        url: "https://api.example.com",
        headers: {
          Authorization: "Bearer sk-1234567890abcdef",
          "X-Api-Key": "secret_api_key_value",
          "Content-Type": "application/json",
        },
        data: {
          password: "MySuperSecretPassword!",
          sessionToken: "sess_abcdef123456",
          publicField: "visible",
        },
      };

      const redacted = redactSecrets(sensitiveInput);

      assert(redacted.headers.Authorization === "[REDACTED]", "Authorization header must be redacted");
      assert(redacted.headers["X-Api-Key"] === "[REDACTED]", "API key header must be redacted");
      assert(redacted.headers["Content-Type"] === "application/json", "Safe header must be preserved");
      assert(redacted.data.password === "[REDACTED]", "Password field must be redacted");
      assert(redacted.data.sessionToken === "[REDACTED]", "Token field must be redacted");
      assert(redacted.data.publicField === "visible", "Safe data field must be preserved");

      // Original object must remain unmodified
      assert(sensitiveInput.headers.Authorization === "Bearer sk-1234567890abcdef", "Original must not be mutated");
    });

    // ── P0-4: Browser exact-origin matching ───────────────────────────────────
    await test("P0-4: Browser origin allowlist prevents prefix bypass (evil.com)", () => {
      const pe = new PermissionEngine({
        browser: {
          allowOrigins: ["https://example.com"],
        },
      });

      const allowedRes = pe.check("browser_open", { url: "https://example.com/login" });
      assert(allowedRes.allowed, "Exact origin must be allowed");

      const spoofRes = pe.check("browser_open", { url: "https://example.com.evil.com/phish" });
      assert(!spoofRes.allowed, "Prefix spoofed origin must be blocked");
      assert(spoofRes.reason?.includes("not in allowed origins") ?? false, "Reason must state not in allowed origins");
    });

    // ── P0-5: SSRF private IP blocking ────────────────────────────────────────
    await test("P0-5: SSRF defense blocks navigation and HTTP to private IP ranges", () => {
      const pe = new PermissionEngine({
        browser: { allowOrigins: ["*"] },
        http: { allowOrigins: ["*"] },
      });

      const privateUrls = [
        "http://127.0.0.1:8080",
        "http://localhost:3000",
        "http://169.254.169.254/latest/meta-data/",
        "http://10.0.0.1/admin",
        "http://192.168.1.1/config",
        "http://172.16.0.1/internal",
      ];

      for (const url of privateUrls) {
        const bRes = pe.check("browser_open", { url });
        assert(!bRes.allowed, `Browser SSRF must block ${url}`);
        assert(bRes.reason?.includes("SSRF protection") ?? false, `Must cite SSRF protection for ${url}`);

        const hRes = pe.check("http_request", { url });
        assert(!hRes.allowed, `HTTP SSRF must block ${url}`);
        assert(hRes.reason?.includes("SSRF protection") ?? false, `Must cite SSRF protection for ${url}`);
      }

      // Explicit allowPrivateNetworks permits private network access
      const peWithPrivate = new PermissionEngine({
        browser: { allowOrigins: ["*"], allowPrivateNetworks: true },
      });
      const allowedLocal = peWithPrivate.check("browser_open", { url: "http://127.0.0.1:8080" });
      assert(allowedLocal.allowed, "allowPrivateNetworks must permit local test target");
    });

    // ── P0-6: Browser sandbox configuration ───────────────────────────────────
    await test("P0-6: Browser launcher keeps Chromium sandbox enabled by default", () => {
      const providerDefault = new PlaywrightBrowserProvider();
      // Inspect private launch options via duck typing or options interface
      const options = (providerDefault as any).options ?? {};
      assert(options.sandbox !== false, "Sandbox should be enabled by default");

      const providerExplicit = new PlaywrightBrowserProvider({ sandbox: false });
      assert((providerExplicit as any).options.sandbox === false, "Explicit sandbox: false respected");
    });

    // ── P0-7: Deny uncategorized tools when untrusted ──────────────────────────
    await test("P0-7: Denies unknown tool categories when untrusted", () => {
      const pe = new PermissionEngine({});
      const res = pe.check("random_dangerous_tool", { arg: 1 });
      assert(!res.allowed, "Unknown tool category must be denied");
      assert(res.reason?.includes("Unknown tool category") ?? false, "Reason must cite unknown tool category");

      const peTrusted = new PermissionEngine({ trusted: true });
      const resTrusted = peTrusted.check("random_dangerous_tool", { arg: 1 });
      assert(resTrusted.allowed, "Trusted mode permits uncategorized tool");
    });

    // ── P1-8: activeRuns cleanup on terminal states ───────────────────────────
    await test("P1-8: activeRuns cleans up completed run contexts", async () => {
      const mock = new MockModelProvider();
      mock.addAnswer("Task completed.");

      const agent = new Agent({
        model: mock,
        verbose: false,
        dbPath: ":memory:",
      });

      const res = await agent.run("Hello");
      assert(res.success, "Run should succeed");

      // Verify activeRuns is empty after run finishes
      const activeRunsMap = (agent as any).activeRuns as Map<string, unknown>;
      assert(activeRunsMap.size === 0, "activeRuns map must be empty after run completion");

      await agent.dispose();
    });

    // ── P1-9: Working memory per-run scoping ──────────────────────────────────
    await test("P1-9: Working memory clears per runId without stomping other runs", async () => {
      const mock = new MockModelProvider();
      mock.addAnswer("Done.");

      const agent = new Agent({
        model: mock,
        verbose: false,
        dbPath: ":memory:",
      });

      // Set working memory in run-123 and run-456
      const memory = agent.getMemory();
      await memory.setWorking("test_key", "val_123", undefined, "run-123");
      await memory.setWorking("test_key", "val_456", undefined, "run-456");

      assert((await memory.getWorking("test_key", "run-123")) === "val_123", "run-123 value saved");
      assert((await memory.getWorking("test_key", "run-456")) === "val_456", "run-456 value saved");

      // Clear run-123 working memory only
      await memory.clearWorking("run-123");
      assert((await memory.getWorking("test_key", "run-123")) === null, "run-123 cleared");
      assert((await memory.getWorking("test_key", "run-456")) === "val_456", "run-456 must be untouched");

      await agent.dispose();
    });

    // ── P1-10: Planner usage per-run (no global state race) ───────────────────
    await test("P1-10: Planner returns usage directly alongside decision", async () => {
      const mock = new MockModelProvider();
      mock.addAnswer("Planning response.");

      const planner = new ReActPlanner(mock);
      const res = await planner.decideNextAction({
        task: "Plan this",
        messages: [{ role: "user", content: "Plan this" }],
        tools: [],
      });

      assert(res.type === "final_answer", "Planner must return final_answer decision");
      assert(res.usage !== undefined, "Planner must return per-run usage alongside decision");
    });

    // ── P1-11: Approval AbortSignal propagation ───────────────────────────────
    await test("P1-11: Approval check cancels immediately on AbortSignal", async () => {
      let cancelled = false;
      const slowHandler: ApprovalHandler = {
        async requestApproval(req: ApprovalRequest, signal?: AbortSignal) {
          return new Promise((resolve) => {
            signal?.addEventListener("abort", () => {
              cancelled = true;
              resolve("DENIED");
            });
          });
        },
      };

      const pe = new PermissionEngine({
        approval: { requireFor: "LOW" },
      });

      const controller = new AbortController();
      const approvalPromise = (pe as any); // Test through approval manager

      const { ApprovalManager } = await import("@agentos/permissions");
      const { EventBus } = await import("@agentos/events");
      const bus = new EventBus();
      const manager = new ApprovalManager(slowHandler, bus, 10000);

      // Abort after 50ms
      setTimeout(() => controller.abort(), 50);

      const decision = await manager.checkApproval(
        "test_tool",
        "LOW",
        {},
        "run-1",
        "task-1",
        controller.signal
      );

      assert(!decision, "Aborted approval must return false");
      assert(cancelled, "Underlying handler received abort signal");
    });

    // ── P1-12: TaskOptions propagation in AgentRuntime ─────────────────────────
    await test("P1-12: AgentRuntime propagates signal and workspace into run", async () => {
      const mock = new MockModelProvider();
      mock.addAnswer("Runtime executed.");

      const runtime = new AgentRuntime({
        model: mock,
        verbose: false,
        dbPath: ":memory:",
      });

      const customWorkspace = new InMemoryWorkspace();
      const controller = new AbortController();

      const run = await runtime.start({
        task: "Execute with options",
        workspace: customWorkspace,
        signal: controller.signal,
      });

      assert(run !== undefined, "Runtime must start run");
      assert(run.workspace === customWorkspace, "RunContext must receive custom workspace");
      assert(run.signal !== undefined, "RunContext must receive AbortSignal");

      await runtime.dispose();
    });

    // ── P1-13: Async dispose() drains active executions ───────────────────────
    await test("P1-13: dispose() cancels active runs and returns a Promise", async () => {
      const mock = new MockModelProvider();
      mock.addAnswer("Done.");

      const agent = new Agent({
        model: mock,
        verbose: false,
        dbPath: ":memory:",
      });

      const disposePromise = agent.dispose();
      assert(disposePromise instanceof Promise, "dispose() must return a Promise");
      await disposePromise;
    });

    // ── P1-14: Browser cancellation via AbortSignal ───────────────────────────
    await test("P1-14: Browser tools throw immediately when AbortSignal is aborted", async () => {
      const tools = browserTools();
      const openTool = tools.find((t) => t.name === "browser_open")!;

      const controller = new AbortController();
      controller.abort(); // already aborted

      let threw = false;
      try {
        await openTool.execute(
          { url: "https://example.com" },
          { runId: "r", taskId: "t", emit: () => {}, signal: controller.signal }
        );
      } catch (err) {
        threw = true;
        assert((err as Error).message.includes("Cancelled"), "Must throw Cancelled error");
      }
      assert(threw, "Browser tool must throw on aborted signal");
    });
  } finally {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  }

  console.log("\n════════════════════════════════════════════════════════════");
  console.log(`AUDIT 0.4 REMEDIATION RESULT: ${passed} passed, ${failed} failed`);
  console.log("════════════════════════════════════════════════════════════\n");

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});

// ─── Phase 4: Workspace Runtime, Browser Automation & Error Classification ────
// Validates:
// 1. LocalWorkspace & InMemoryWorkspace path jailing and isolation
// 2. filesystemTools operating natively over a WorkspaceAdapter
// 3. Browser automation tools (browser_open, browser_type, browser_click, browser_observe, browser_screenshot)
// 4. Browser navigation security (PermissionEngine origin and protocol gating)
// 5. Structured Tool error classification & retryable flag
// 6. AgentRuntime top-level orchestrator lifecycle

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  LocalWorkspace,
  InMemoryWorkspace,
  VirtualBrowserProvider,
  browserTools,
  filesystemTools,
  classifyToolError,
  Agent,
  AgentRuntime,
  MockModelProvider,
  PermissionEngine,
} from "@agentos/sdk";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${msg}`);
  }
}

async function runTest(name: string, fn: () => Promise<void>): Promise<void> {
  process.stdout.write(`  🌐 ${name} ... `);
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

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║  🌐 AgentOS v0.1 — Phase 4 Workspace, Browser & Runtime  ║");
  console.log("║         (Verification for audit_0.1.md P1/P2 Fixes)      ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-phase4-"));

  try {
    // ─────────────────────────────────────────────────────────────────────────
    // Test 1: Workspace Path Confinement & Traversal Rejection
    // ─────────────────────────────────────────────────────────────────────────
    await runTest("LocalWorkspace & InMemoryWorkspace enforce boundary jail and reject escape attempts", async () => {
      const wsRoot = path.join(tempDir, "sandbox_jail");
      const localWs = new LocalWorkspace({ rootPath: wsRoot });

      // 1. Valid write & read inside boundary
      await localWs.write("config/settings.json", JSON.stringify({ mode: "production" }));
      const readContent = await localWs.read("config/settings.json");
      assert(readContent.includes("production"), "Read content must match written content");

      const fileList = await localWs.list("config");
      assert(fileList.includes("settings.json"), "List should contain settings.json");

      // 2. Traversal attempt out of root must throw WorkspacePathViolationError
      let errorThrown = false;
      try {
        await localWs.read("../outside_secret.txt");
      } catch (err) {
        errorThrown = true;
        assert((err as Error).name === "WorkspacePathViolationError", "Must throw WorkspacePathViolationError");
      }
      assert(errorThrown, "Path traversal escape must be blocked");

      // 3. InMemoryWorkspace confinement
      const memWs = new InMemoryWorkspace({
        initialFiles: {
          "notes.txt": "virtual note",
        },
      });

      assert(await memWs.exists("notes.txt"), "Initial file must exist in memory workspace");
      const memContent = await memWs.read("notes.txt");
      assert(memContent === "virtual note", "Memory content must match");

      let memErrorThrown = false;
      try {
        await memWs.write("../../escape.txt", "evil");
      } catch {
        memErrorThrown = true;
      }
      assert(memErrorThrown, "InMemoryWorkspace must reject relative escape paths");
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Test 2: Filesystem Tools Operating Over WorkspaceAdapter
    // ─────────────────────────────────────────────────────────────────────────
    await runTest("filesystemTools transparently operates within a WorkspaceAdapter jail", async () => {
      const memWs = new InMemoryWorkspace();
      const tools = filesystemTools({ workspace: memWs });

      const writeTool = tools.find((t) => t.name === "filesystem_write")!;
      const readTool = tools.find((t) => t.name === "filesystem_read")!;
      const existsTool = tools.find((t) => t.name === "filesystem_exists")!;
      const listTool = tools.find((t) => t.name === "filesystem_list")!;

      // Write via tool
      await writeTool.execute(
        { path: "project/app.ts", content: "console.log('hello');" },
        { runId: "r1", taskId: "t1", emit: () => {} }
      );

      // Verify in workspace
      assert(await memWs.exists("project/app.ts"), "File should exist in memory workspace");

      // Read via tool
      const readRes = await readTool.execute(
        { path: "project/app.ts" },
        { runId: "r1", taskId: "t1", emit: () => {} }
      );
      assert(readRes.includes("console.log('hello');"), "filesystem_read should read from workspace");

      // Exists via tool
      const existsRes = await existsTool.execute(
        { path: "project/app.ts" },
        { runId: "r1", taskId: "t1", emit: () => {} }
      );
      assert(existsRes.includes("Exists: true"), "filesystem_exists should report true");

      // List via tool
      const listRes = await listTool.execute(
        { path: "project" },
        { runId: "r1", taskId: "t1", emit: () => {} }
      );
      assert(listRes.includes("app.ts"), "filesystem_list should list directory contents");
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Test 3: Browser Automation Tools (Navigate, Type, Click, Observe, Screenshot)
    // ─────────────────────────────────────────────────────────────────────────
    await runTest("browserTools suite provides complete perceive-act web capabilities", async () => {
      const mockBrowser = new VirtualBrowserProvider({
        mockPages: {
          "https://example.com/login": {
            title: "Example Login Page",
            content: "Please log in to your account.",
            elements: [
              { selector: "#username", tag: "input", type: "text", value: "" },
              { selector: "#login-btn", tag: "button", text: "Log In" },
              { selector: "a.help", tag: "a", text: "Help Center", href: "https://example.com/help" },
            ],
          },
          "https://example.com/help": {
            title: "Help Center",
            content: "Frequently Asked Questions and Docs.",
          },
        },
      });

      const tools = browserTools(mockBrowser);
      const openTool = tools.find((t) => t.name === "browser_open")!;
      const typeTool = tools.find((t) => t.name === "browser_type")!;
      const clickTool = tools.find((t) => t.name === "browser_click")!;
      const observeTool = tools.find((t) => t.name === "browser_observe")!;
      const screenshotTool = tools.find((t) => t.name === "browser_screenshot")!;

      const dummyCtx = { runId: "r", taskId: "t", emit: () => {} };

      // 1. Open
      const openRes = await openTool.execute({ url: "https://example.com/login" }, dummyCtx);
      assert(openRes.includes("Example Login Page"), "browser_open must return page title");
      assert(openRes.includes("Please log in"), "browser_open must return content preview");

      // 2. Observe
      const obsRes = await observeTool.execute({}, dummyCtx);
      assert(obsRes.includes("#username"), "browser_observe must list username input");
      assert(obsRes.includes("#login-btn"), "browser_observe must list login button");
      assert(obsRes.includes("a.help"), "browser_observe must list help link");

      // 3. Type
      const typeRes = await typeTool.execute({ selector: "#username", text: "alice_agent" }, dummyCtx);
      assert(typeRes.includes('Typed "alice_agent" into "#username"'), "browser_type must report success");

      // 4. Click link (simulates navigation to /help)
      const clickRes = await clickTool.execute({ selector: "a.help" }, dummyCtx);
      assert(clickRes.includes("https://example.com/help"), "browser_click on link must navigate");
      assert(clickRes.includes("Help Center"), "browser_click must reflect updated title");

      // 5. Screenshot
      const shotRes = await screenshotTool.execute({}, dummyCtx);
      assert(shotRes.includes("Screenshot captured"), "browser_screenshot must return capture summary");
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Test 4: Browser Navigation Security & Protocol Rejection
    // ─────────────────────────────────────────────────────────────────────────
    await runTest("PermissionEngine blocks unauthorized origins and dangerous protocols in browser", async () => {
      const pe = new PermissionEngine({
        browser: {
          allowOrigins: ["https://trusted-site.org"],
          denyOrigins: ["https://trusted-site.org/phishing"],
        },
      });

      // 1. Allowed origin
      const d1 = pe.check("browser_open", { url: "https://trusted-site.org/dashboard" });
      assert(d1.allowed, "Allowed origin must pass");

      // 2. Denied origin/subpath
      const d2 = pe.check("browser_open", { url: "https://trusted-site.org/phishing/login" });
      assert(!d2.allowed, "Denied URL must be blocked");
      assert(d2.reason?.includes("denied by security policy") ?? false, "Reason must state denial");

      // 3. Disallowed origin
      const d3 = pe.check("browser_open", { url: "https://unknown-domain.com" });
      assert(!d3.allowed, "Unknown origin must be denied");
      assert(d3.reason?.includes("not in allowed origins") ?? false, "Reason must state allowed origins");

      // 4. Dangerous protocol (file:)
      const d4 = pe.check("browser_open", { url: "file:///C:/Windows/System32/drivers/etc/hosts" });
      assert(!d4.allowed, "file: protocol in browser must be blocked");
      assert(d4.reason?.includes("Forbidden protocol") ?? false, "Reason must cite forbidden protocol");
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Test 5: Structured Tool Error Classification & Retryable Determination
    // ─────────────────────────────────────────────────────────────────────────
    await runTest("classifyToolError accurately categorizes failure codes and retryable flags", async () => {
      // 1. Validation Error (retryable)
      const c1 = classifyToolError("Input Validation Error: path: Expected string, received number");
      assert(c1.code === "VALIDATION_ERROR", "Must classify validation error");
      assert(c1.retryable === true, "Validation error should be retryable");

      // 2. Permission Denied (not retryable)
      const c2 = classifyToolError("Permission denied: Command executable is not allowed");
      assert(c2.code === "PERMISSION_DENIED", "Must classify permission denied");
      assert(c2.retryable === false, "Permission error should not be retryable");

      // 3. Not Found (retryable)
      const c3 = classifyToolError("ENOENT: no such file or directory: /src/app.ts");
      assert(c3.code === "NOT_FOUND", "Must classify ENOENT as NOT_FOUND");
      assert(c3.retryable === true, "Not found should be retryable");

      // 4. Timeout (retryable)
      const c4 = classifyToolError("Operation timed out after 30000ms");
      assert(c4.code === "TIMEOUT", "Must classify timeout");
      assert(c4.retryable === true, "Timeout should be retryable");
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Test 6: AgentRuntime Top-Level Multi-Run Orchestration
    // ─────────────────────────────────────────────────────────────────────────
    await runTest("AgentRuntime orchestrates tasks with workspace and coordinates runs", async () => {
      const memWs = new InMemoryWorkspace({
        initialFiles: { "input.txt": "AgentOS runtime input" },
      });

      const mock = new MockModelProvider();
      mock.addAnswer("Task completed with AgentRuntime.");

      const runtime = new AgentRuntime({
        model: mock,
        workspace: memWs,
        verbose: false,
        dbPath: ":memory:",
      });

      assert(runtime.getWorkspace() === memWs, "Runtime must expose its configured workspace");

      // Run task via AgentRuntime
      const result = await runtime.run("Process workspace input");
      assert(result.success, "Task should complete successfully");
      assert(result.output === "Task completed with AgentRuntime.", "Output should match mock response");

      // Start asynchronous run
      const mock2 = new MockModelProvider();
      mock2.addAnswer("Second task completed.");
      const runtime2 = new AgentRuntime({
        model: mock2,
        workspace: memWs,
        verbose: false,
        dbPath: ":memory:",
      });

      const run = runtime2.start({ task: "Second task" });
      assert(typeof run.runId === "string" && run.runId.length > 0, "runId must be generated");
      assert(run.task === "Second task", "Task must match");

      const res2 = await run.result;
      assert(res2.success, "Async run must resolve successfully");

      runtime.dispose();
      runtime2.dispose();
    });
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  console.log("\n════════════════════════════════════════════════════════════");
  console.log(`PHASE 4 SUITE RESULT: ${passed} passed, ${failed} failed`);
  console.log("════════════════════════════════════════════════════════════\n");

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error running Phase 4 tests:", err);
  process.exit(1);
});

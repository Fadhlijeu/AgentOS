// ─── AgentOS — Audit 0.6 Remediation Verification Suite ─────────────────────
//
// Formally verifies all P0 (Security) and P1 (Run/Workspace Isolation,
// Lifecycle, Observability Privacy, Packaging) remediations from audit_0.6.md:
//
// P0-1: End-to-End secret redaction in Approval, Tracer, SQLite, and Tool Results
// P0-2: Tool execution failure redacts secret error messages & inputs
// P0-3: Symlink and junction workspace traversal prevention in LocalWorkspace
// P0-4: Symlink traversal prevention in OpenHandsWorkspaceAdapter
// P0-5: SSRF DNS pre-resolution protection (validateHostIpSafety)
// P0-6: SSRF manual redirect chain validation in HTTP requests
// P1-7: Subprocess environment sanitization in code_interpret and terminal_exec
// P1-8: Cross-run memory retrieval isolation (Run A memory inaccessible to Run B)
// P1-9: Strict persistenceMode="required" fail-fast vs "best-effort" emission
// P1-10: Cancellation lifecycle event (task.cancelled emitted, not task.completed)
// P1-11: Agent.cancel() lifecycle does not poison subsequent new runs
// P1-12: Package boundary and distribution readiness across all workspace packages

import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import * as http from "http";

import { Agent, MockModelProvider } from "@agentos/agent";

import {
  PermissionEngine,
  ApprovalManager,
  redactSecrets,
  validateHostIpSafety,
  isPrivateIp,
  isPrivateHostname,
  canonicalizePath,
  isPathInside,
  type ApprovalHandler,
  type ApprovalRequest,
} from "@agentos/permissions";

import {
  LocalWorkspace,
  WorkspacePathViolationError,
  OpenHandsWorkspaceAdapter,
  sanitizeProcessEnv,
} from "@agentos/adapters";

import { MemoryManager } from "@agentos/memory";
import { httpTools, terminalTools } from "@agentos/tools";
import { EventBus } from "@agentos/events";
import { Tracer } from "@agentos/observability";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${msg}`);
  }
}

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  process.stdout.write(`  🛡️ [Audit 0.6] ${name} ... `);
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
  console.log("║     🛡️ AgentOS — Audit 0.6 Remediation Test Suite        ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  const testBaseDir = path.join(os.tmpdir(), `audit06_test_${Date.now()}`);
  fs.mkdirSync(testBaseDir, { recursive: true });

  try {
    // ── P0-1: Secret Redaction in Approval, Tracer, SQLite, Results ───────────
    await test("P0-1: Secret redaction sanitizes Approval, Tracer, SQLite, and Tool Results", async () => {
      let interceptedApprovalInput: Record<string, unknown> | null = null;
      let interceptedApprovalEvent: Record<string, unknown> | null = null;

      const testBus = new EventBus();
      testBus.on("approval.required", (evt) => {
        interceptedApprovalEvent = evt.data.input as Record<string, unknown>;
      });

      const handler: ApprovalHandler = {
        async requestApproval(req: ApprovalRequest) {
          interceptedApprovalInput = req.input;
          return "GRANTED";
        },
      };

      const approvalManager = new ApprovalManager(handler, testBus);
      const decision = await approvalManager.checkApproval(
        "secret_tool",
        "HIGH",
        {
          apiKey: "sk-proj-supersecretkey1234567890abcdef1234",
          githubToken: "ghp_1234567890abcdef1234567890abcdef1234",
          authorization: "Bearer my-secret-jwt-token-val",
          normalField: "safe-value",
        },
        "run-approval",
        "task-approval"
      );

      assert(decision === true, "Approval should be granted");
      assert(interceptedApprovalInput !== null, "Approval handler must receive request");
      assert(interceptedApprovalInput!.apiKey === "[REDACTED]", "apiKey in approval request must be [REDACTED]");
      assert(interceptedApprovalInput!.githubToken === "[REDACTED]", "githubToken in approval request must be [REDACTED]");
      assert(interceptedApprovalInput!.authorization === "[REDACTED]", "authorization in approval request must be [REDACTED]");
      assert(interceptedApprovalInput!.normalField === "safe-value", "safe-value must be preserved");

      assert(interceptedApprovalEvent !== null, "approval.required event must be emitted");
      assert(interceptedApprovalEvent!.apiKey === "[REDACTED]", "Event payload must be sanitized");

      // Verify Tracer and SQLite end-to-end with an Agent
      const mock = new MockModelProvider();
      mock.addToolCall("fetch_credentials", {
        authHeader: "Bearer sk-11223344556677889900aabbccddeeff",
        password: "SuperSecretPassword123!",
      });
      mock.addAnswer("Credentials processed securely.");

      let toolExecutedWithOriginalArgs = false;
      const customTool = {
        name: "fetch_credentials",
        description: "Returns secret response",
        parameters: { type: "object", properties: {} },
        riskLevel: "LOW" as const,
        async execute(args: Record<string, unknown>) {
          // Tool MUST receive original credentials to perform actual API call
          if (args.authHeader === "Bearer sk-11223344556677889900aabbccddeeff") {
            toolExecutedWithOriginalArgs = true;
          }
          return JSON.stringify({
            status: "ok",
            sessionToken: "sk-secrettoken998877665544332211",
            message: "User logged in",
          });
        },
      };

      const agent = new Agent({
        model: mock,
        tools: [customTool],
        permissions: { trusted: true },
        dbPath: ":memory:",
        verbose: false,
      });

      const res = await agent.run("Fetch my secret credentials");
      assert(res.success, "Agent run should succeed");
      assert(toolExecutedWithOriginalArgs, "Tool execution must receive raw unredacted credentials to operate");

      // Verify Tracer trace entries
      const tracer = agent.getTracer();
      const trace = tracer.getTrace(res.runId);
      const toolCallEntry = trace.find((s) => s.type === "tool_call");
      const toolResultEntry = trace.find((s) => s.type === "tool_result");

      assert(toolCallEntry !== undefined, "Tool call trace entry must exist");
      const loggedArgs = toolCallEntry!.data.arguments as Record<string, unknown>;
      assert(loggedArgs.authHeader === "[REDACTED]", "Tracer toolCall entry arguments must be redacted");
      assert(loggedArgs.password === "[REDACTED]", "Tracer toolCall password must be redacted");

      assert(toolResultEntry !== undefined, "Tool result trace entry must exist");
      const loggedResult = String(toolResultEntry!.data.result);
      assert(!loggedResult.includes("sk-secrettoken998877665544332211"), "Tracer toolResult entry must redact sessionToken");

      // Verify SQLite tool_calls storage
      const runTimeline = await agent.reconstructTimeline(res.runId);
      assert(runTimeline.toolCalls.length > 0, "Tool call must be stored in SQLite");
      const storedCall = runTimeline.toolCalls[0];
      const storedArgs = storedCall.arguments as Record<string, unknown>;
      assert(storedArgs.authHeader === "[REDACTED]", "SQLite tool_calls.arguments must be redacted");
      assert(storedArgs.password === "[REDACTED]", "SQLite tool_calls.arguments password must be redacted");
      assert(
        !JSON.stringify(storedCall.result).includes("sk-secrettoken998877665544332211"),
        "SQLite tool_calls.result must be redacted"
      );

      await agent.dispose();
    });

    // ── P0-2: Tool Execution Failure Redacts Secret Errors ────────────────────
    await test("P0-2: Tool execution failure redacts secrets from error messages and logs", async () => {
      const mock = new MockModelProvider();
      mock.addToolCall("failing_tool", { token: "ghp_superSecretTokenForGitHub12345678" });
      mock.addAnswer("Error handled.");

      const failingTool = {
        name: "failing_tool",
        description: "Fails with a secret in the exception message",
        parameters: { type: "object", properties: {} },
        riskLevel: "LOW" as const,
        async execute() {
          throw new Error("Authentication failed for token: ghp_superSecretTokenForGitHub12345678");
        },
      };

      const agent = new Agent({
        model: mock,
        tools: [failingTool],
        permissions: { trusted: true },
        dbPath: ":memory:",
        verbose: false,
      });

      const res = await agent.run("Run failing tool");
      const tracer = agent.getTracer();
      const trace = tracer.getTrace(res.runId);
      const errorEntry = trace.find((s) => s.type === "tool_result" && s.data.error);

      assert(errorEntry !== undefined, "Tool result with error must be recorded");
      const errorMsg = String(errorEntry!.data.error);
      assert(!errorMsg.includes("ghp_superSecretTokenForGitHub12345678"), "Error message in Tracer must not contain raw secret");
      assert(errorMsg.includes("REDACTED"), "Secret in error message must be replaced with [REDACTED]");

      // SQLite check
      const timeline = await agent.reconstructTimeline(res.runId);
      const storedCall = timeline.toolCalls[0];
      assert(!storedCall.error?.includes("ghp_superSecretTokenForGitHub12345678"), "SQLite error column must be redacted");

      await agent.dispose();
    });

    // ── P0-3: Symlink & Junction Traversal Prevention in LocalWorkspace ───────
    await test("P0-3: LocalWorkspace prevents symlink & junction escapes", async () => {
      const workspaceRoot = path.join(testBaseDir, "ws_root");
      const outsideDir = path.join(testBaseDir, "ws_outside");
      fs.mkdirSync(workspaceRoot, { recursive: true });
      fs.mkdirSync(outsideDir, { recursive: true });

      const secretFile = path.join(outsideDir, "flag.txt");
      fs.writeFileSync(secretFile, "CONFIDENTIAL_DATA", "utf-8");

      // Create a directory junction pointing outside the workspace root
      const junctionPath = path.join(workspaceRoot, "escape_junction");
      try {
        fs.symlinkSync(outsideDir, junctionPath, "junction");
      } catch (e) {
        // Fallback for systems where junction syntax differs
        fs.symlinkSync(outsideDir, junctionPath, "dir");
      }

      const ws = new LocalWorkspace({ rootPath: workspaceRoot });

      // 1. resolvePath must detect canonical escape
      let resolveBlocked = false;
      try {
        ws.resolvePath("escape_junction/flag.txt");
      } catch (err) {
        if (err instanceof WorkspacePathViolationError) {
          resolveBlocked = true;
        }
      }
      assert(resolveBlocked, "ws.resolvePath must throw WorkspacePathViolationError on symlink/junction escape");

      // 2. read must be blocked
      let readBlocked = false;
      try {
        await ws.read("escape_junction/flag.txt");
      } catch (err) {
        if (err instanceof WorkspacePathViolationError) {
          readBlocked = true;
        }
      }
      assert(readBlocked, "ws.read must throw WorkspacePathViolationError on symlink/junction escape");

      // 3. write must be blocked
      let writeBlocked = false;
      try {
        await ws.write("escape_junction/evil.txt", "injected");
      } catch (err) {
        if (err instanceof WorkspacePathViolationError) {
          writeBlocked = true;
        }
      }
      assert(writeBlocked, "ws.write must throw WorkspacePathViolationError on symlink/junction escape");

      // 4. isPathInside helper must return false
      assert(
        !isPathInside(workspaceRoot, path.join(workspaceRoot, "escape_junction", "flag.txt")),
        "isPathInside must return false for junction target outside root"
      );
    });

    // ── P0-4: Symlink Traversal Prevention in OpenHandsWorkspaceAdapter ────────
    await test("P0-4: OpenHandsWorkspaceAdapter prevents symlink & junction escapes", async () => {
      const wsRoot = path.join(testBaseDir, "openhands_root");
      const outsideDir = path.join(testBaseDir, "openhands_outside");
      fs.mkdirSync(wsRoot, { recursive: true });
      fs.mkdirSync(outsideDir, { recursive: true });

      const junctionPath = path.join(wsRoot, "oh_junction");
      try {
        fs.symlinkSync(outsideDir, junctionPath, "junction");
      } catch {
        fs.symlinkSync(outsideDir, junctionPath, "dir");
      }

      const adapter = new OpenHandsWorkspaceAdapter(wsRoot);

      let ohBlocked = false;
      try {
        await adapter.write("oh_junction/escape.txt", "payload");
      } catch (err) {
        if ((err as Error).message.includes("escape") || (err as Error).message.includes("denied")) {
          ohBlocked = true;
        }
      }
      assert(ohBlocked, "OpenHandsWorkspaceAdapter must block write through symlink escape");
    });

    // ── P0-5: SSRF DNS Pre-Resolution Protection ──────────────────────────────
    await test("P0-5: validateHostIpSafety blocks private IPs and loopbacks via DNS", async () => {
      // Loopbacks and private ranges must be blocked
      assert((await validateHostIpSafety("127.0.0.1")) === false, "127.0.0.1 must be blocked");
      assert((await validateHostIpSafety("localhost")) === false, "localhost must be blocked");
      assert((await validateHostIpSafety("10.0.0.1")) === false, "10.0.0.1 must be blocked");
      assert((await validateHostIpSafety("192.168.1.1")) === false, "192.168.1.1 must be blocked");
      assert((await validateHostIpSafety("172.16.0.1")) === false, "172.16.0.1 must be blocked");
      assert((await validateHostIpSafety("169.254.169.254")) === false, "AWS metadata 169.254.169.254 must be blocked");
      assert((await validateHostIpSafety("::1")) === false, "IPv6 loopback ::1 must be blocked");

      // Public IP check
      assert((await validateHostIpSafety("1.1.1.1")) === true, "1.1.1.1 must be allowed");
    });

    // ── P0-6: SSRF Manual Redirect Chain Validation ───────────────────────────
    await test("P0-6: HTTP tool intercepts redirects and blocks hops to private targets", async () => {
      // Spin up a local server that responds with 302 redirecting to private metadata IP
      let port = 0;
      const server = http.createServer((req, res) => {
        if (req.url === "/redirect-to-metadata") {
          res.writeHead(302, {
            Location: "http://169.254.169.254/latest/meta-data/",
          });
          res.end();
        } else if (req.url === "/redirect-to-loopback") {
          res.writeHead(302, {
            Location: "http://127.0.0.1:9090/admin",
          });
          res.end();
        } else {
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("OK");
        }
      });

      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          port = (server.address() as any).port;
          resolve();
        });
      });

      try {
        const tools = httpTools();
        const httpReq = tools.find((t) => t.name === "http_request")!;

        // 1. Redirect to cloud metadata IP must be blocked
        const resMetadata = await httpReq.execute(
          { url: `http://127.0.0.1:${port}/redirect-to-metadata` },
          { runId: "r1", taskId: "t1", emit: () => {} }
        );
        assert(
          resMetadata.includes("SSRF protection") || resMetadata.includes("blocked"),
          "Redirect to 169.254.169.254 must be blocked by SSRF inspection"
        );

        // 2. Redirect to loopback 127.0.0.1 must be blocked
        const resLoopback = await httpReq.execute(
          { url: `http://127.0.0.1:${port}/redirect-to-loopback` },
          { runId: "r2", taskId: "t2", emit: () => {} }
        );
        assert(
          resLoopback.includes("SSRF protection") || resLoopback.includes("blocked"),
          "Redirect to 127.0.0.1 must be blocked by SSRF inspection"
        );
      } finally {
        server.close();
      }
    });

    // ── P1-7: Subprocess Environment Sanitization ─────────────────────────────
    await test("P1-7: Subprocess environment sanitization strips sensitive host variables", async () => {
      // Mock process.env with sensitive credentials
      const dirtyEnv = {
        PATH: process.env.PATH || "C:\\Windows",
        SYSTEMROOT: process.env.SYSTEMROOT || "C:\\Windows",
        OPENAI_API_KEY: "sk-supersecret-token-value",
        GITHUB_TOKEN: "ghp_1234567890abcdef1234567890abcdef1234",
        AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        DATABASE_URL: "postgresql://user:secretpw@localhost:5432/db",
        MY_APP_PASSWORD: "UnsafePassword!",
        AUTH_BEARER_TOKEN: "Bearer secret-token",
        SAFE_USER_VARIABLE: "harmless-value",
      };

      const cleanEnv = sanitizeProcessEnv(dirtyEnv);

      assert(cleanEnv.PATH !== undefined, "PATH must be preserved");
      assert(cleanEnv.PYTHONUNBUFFERED === "1", "PYTHONUNBUFFERED must be set");
      assert(cleanEnv.OPENAI_API_KEY === undefined, "OPENAI_API_KEY must be stripped");
      assert(cleanEnv.GITHUB_TOKEN === undefined, "GITHUB_TOKEN must be stripped");
      assert(cleanEnv.AWS_SECRET_ACCESS_KEY === undefined, "AWS_SECRET_ACCESS_KEY must be stripped");
      assert(cleanEnv.DATABASE_URL === undefined, "DATABASE_URL must be stripped");
      assert(cleanEnv.MY_APP_PASSWORD === undefined, "Password variable must be stripped");
      assert(cleanEnv.AUTH_BEARER_TOKEN === undefined, "Auth variable must be stripped");

      // Verify terminal tool executes without host credentials in child process
      process.env.TEST_API_KEY_LEAK = "sk-leaked-test-key";
      const tools = terminalTools();
      const termExec = tools.find((t) => t.name === "terminal_exec")!;
      const termRes = await termExec.execute(
        { command: `node -e "console.log(process.env.TEST_API_KEY_LEAK ?? 'CLEAN')"` },
        { runId: "r-term", taskId: "t-term", emit: () => {} }
      );
      assert(termRes.includes("CLEAN"), "Terminal child process env must not inherit sensitive API keys");
      delete process.env.TEST_API_KEY_LEAK;
    });

    // ── P1-8: Cross-Run Memory Retrieval Isolation ────────────────────────────
    await test("P1-8: Memory retrieve isolates working memory between distinct runs", async () => {
      const memory = new MemoryManager();

      // Store working memories for two different runs
      await memory.setWorking("temp_secret", "RunA_Confidential_Plan", undefined, "run-alpha");
      await memory.setWorking("temp_secret", "RunB_Local_Plan", undefined, "run-beta");

      // Store shared long-term knowledge
      await memory.remember("long-term", "global_guide", "Global engineering guidelines", ["plan"]);

      // 1. Default retrieve should search long-term only, not leaking any working memory
      const defaultRetrieved = await memory.retrieve("plan");
      const defaultKeys = defaultRetrieved.map((m) => m.key);
      assert(defaultKeys.includes("global_guide"), "Global knowledge should be retrieved");
      assert(!defaultKeys.some((k) => k.includes("run-alpha")), "Run A working memory must NOT be retrieved by default");
      assert(!defaultKeys.some((k) => k.includes("run-beta")), "Run B working memory must NOT be retrieved by default");

      // 2. Scoped retrieve for run-beta must retrieve run-beta's working memory, NEVER run-alpha
      const betaRetrieved = await memory.retrieve("plan", {
        runId: "run-beta",
        includeWorking: true,
      });
      const betaKeys = betaRetrieved.map((m) => m.key);
      assert(betaKeys.some((k) => k.includes("run-beta")), "Run B's own working memory must be included");
      assert(!betaKeys.some((k) => k.includes("run-alpha")), "Run A's working memory must NEVER cross over to Run B");
    });

    // ── P1-9: Strict persistenceMode="required" Semantics ─────────────────────
    await test("P1-9: persistenceMode='required' throws fast on storage failure", async () => {
      const mock = new MockModelProvider();
      mock.addToolCall("test_tool", {});
      mock.addAnswer("Done.");

      const dummyTool = {
        name: "test_tool",
        description: "A test tool",
        parameters: { type: "object", properties: {} },
        riskLevel: "LOW" as const,
        async execute() {
          return "tool output";
        },
      };

      const agentRequired = new Agent({
        model: mock,
        tools: [dummyTool],
        permissions: { trusted: true },
        persistenceMode: "required",
        dbPath: ":memory:",
        verbose: false,
      });

      // Break SQLite saveToolCall to simulate disk full / write error
      const store = agentRequired.getStore();
      store.saveToolCall = () => {
        throw new Error("Disk quota exceeded on SQLite persistence layer");
      };

      const resRequired = await agentRequired.run("Perform operation with broken disk");
      assert(!resRequired.success, "persistenceMode='required' must fail run on storage failure");
      assert(
        resRequired.error?.includes("Persistence required") ?? false,
        `Run error must cite persistence required failure: ${resRequired.error}`
      );

      await agentRequired.dispose();

      // Verify persistenceMode='best-effort' emits event and does NOT throw
      const mockBestEffort = new MockModelProvider();
      mockBestEffort.addToolCall("test_tool", {});
      mockBestEffort.addAnswer("Done.");

      const agentBestEffort = new Agent({
        model: mockBestEffort,
        tools: [dummyTool],
        permissions: { trusted: true },
        persistenceMode: "best-effort",
        dbPath: ":memory:",
        verbose: false,
      });

      let persistenceErrorEmitted = false;
      agentBestEffort.getEventBus().on("persistence.error", () => {
        persistenceErrorEmitted = true;
      });

      agentBestEffort.getStore().saveToolCall = () => {
        throw new Error("Transient disk error");
      };

      const resBestEffort = await agentBestEffort.run("Perform operation with best-effort persistence");
      assert(resBestEffort.success, "best-effort persistence run should continue and succeed");
      assert(persistenceErrorEmitted, "best-effort persistence must emit persistence.error event");

      await agentBestEffort.dispose();
    });

    // ── P1-10: Cancellation Lifecycle Event (task.cancelled) ──────────────────
    await test("P1-10: Cancellation emits task.cancelled event and maps 1:1 to terminal state", async () => {
      const mock = new MockModelProvider();
      mock.addToolCall("slow_step", {});
      mock.addAnswer("Completed after slow step");

      const slowTool = {
        name: "slow_step",
        description: "Slow step tool",
        parameters: { type: "object", properties: {} },
        riskLevel: "LOW" as const,
        async execute() {
          return "slow step output";
        },
      };

      const agent = new Agent({
        model: mock,
        tools: [slowTool],
        permissions: { trusted: true },
        dbPath: ":memory:",
        verbose: false,
      });

      let cancelledEventEmitted = false;
      let completedEventEmitted = false;

      agent.getEventBus().on("task.cancelled", () => {
        cancelledEventEmitted = true;
      });

      agent.getEventBus().on("task.completed", () => {
        completedEventEmitted = true;
      });

      const controller = new AbortController();
      controller.abort(); // Cancel before run executes

      const res = await agent.run("Perform cancellable task", { signal: controller.signal });

      assert(!res.success, "Cancelled task must not report success: true");
      assert(res.output?.includes("cancelled") ?? false, "Result output must reflect cancellation");
      assert(cancelledEventEmitted, "task.cancelled event MUST be emitted on cancellation");
      assert(!completedEventEmitted, "task.completed event must NOT be emitted when cancelled");

      await agent.dispose();
    });

    // ── P1-11: Agent.cancel() Lifecycle (No Sticky State) ─────────────────────
    await test("P1-11: Agent.cancel() does not leave sticky cancel state on subsequent new runs", async () => {
      const mock = new MockModelProvider();
      mock.addAnswer("Task A completed.");
      mock.addAnswer("Task B completed.");

      const agent = new Agent({
        model: mock,
        permissions: { trusted: true },
        dbPath: ":memory:",
        verbose: false,
      });

      // 1. Run Task A to completion
      const resA = await agent.run("Task A");
      assert(resA.success, "Task A must complete successfully");

      // 2. Call cancel while idle
      await agent.cancel();

      // 3. Start Task B: must succeed normally and not be aborted by lingering pendingStatus
      const resB = await agent.run("Task B");
      assert(resB.success, "Task B must complete successfully without being poisoned by previous cancel()");
      assert(resB.output === "Task B completed.", "Task B must return its expected answer");

      await agent.dispose();
    });

    // ── P1-12: Package Boundary and Distribution Readiness ───────────────────
    await test("P1-12: All 12 packages have proper distribution configuration (main, types, exports, files)", () => {
      const packagesDir = path.resolve(__dirname, "../packages");
      const packageFolders = fs.readdirSync(packagesDir).filter((f) => {
        return fs.statSync(path.join(packagesDir, f)).isDirectory();
      });

      assert(packageFolders.length >= 12, "Must find all workspace packages");

      for (const folder of packageFolders) {
        const pkgJsonPath = path.join(packagesDir, folder, "package.json");
        assert(fs.existsSync(pkgJsonPath), `package.json must exist in ${folder}`);

        const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));

        assert(pkg.main === "dist/index.js", `${pkg.name}: "main" must point to "dist/index.js"`);
        assert(pkg.types === "dist/index.d.ts", `${pkg.name}: "types" must point to "dist/index.d.ts"`);
        assert(pkg.exports !== undefined, `${pkg.name}: "exports" mapping must be defined`);
        assert(pkg.files?.includes("dist"), `${pkg.name}: "files" must include "dist"`);
        assert(pkg.private !== true, `${pkg.name}: "private" must be removed for public distribution`);
      }

      // Check README.md Quickstart
      const readmePath = path.resolve(__dirname, "../../README.md");
      const readmeContent = fs.readFileSync(readmePath, "utf-8");
      assert(readmeContent.includes("await agent.dispose()"), "README Quickstart must use 'await agent.dispose()'");
      assert(
        readmeContent.includes("Desktop GUI Application") && readmeContent.includes("Planned"),
        "README must honestly list Desktop GUI as 'Planned'"
      );
    });
  } finally {
    try {
      if (fs.existsSync(testBaseDir)) {
        fs.rmSync(testBaseDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup error on open file handles
    }
  }

  console.log("\n════════════════════════════════════════════════════════════");
  console.log(`AUDIT 0.6 REMEDIATION RESULT: ${passed} passed, ${failed} failed`);
  console.log("════════════════════════════════════════════════════════════\n");

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("Test suite execution failed:", err);
  process.exit(1);
});

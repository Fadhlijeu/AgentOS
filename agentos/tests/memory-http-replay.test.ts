// ─── Phase 3: Memory, HTTP Tool, Context Retrieval & Replay Test Suite ────────
// Validates:
// 1. SQLiteMemoryStore durability across store instances
// 2. Automated context retrieval & memory assembly into agent prompts
// 3. Task outcome storage into long-term memory & memory.updated events
// 4. http_request tool with Zod validation, headers, and cancellation
// 5. PermissionEngine origin gating (allowed/blocked origins & protocol safety)
// 6. agent.replay(runId) audit timeline reconstruction

import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import {
  Agent,
  MockModelProvider,
  MemoryManager,
  SQLiteMemoryStore,
  SQLiteStore,
  filesystemTools,
  httpTools,
  PermissionEngine,
  type AgentEvent,
} from "@agentos/sdk";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${msg}`);
  }
}

async function runTest(name: string, fn: () => Promise<void>): Promise<void> {
  process.stdout.write(`  🧠 ${name} ... `);
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
  console.log("║     🧠 AgentOS v0.1 — Phase 3 Memory, HTTP & Replay      ║");
  console.log("║          (Verification for audit_0.1.md P1 Fixes)        ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-phase3-"));

  try {
    // ─────────────────────────────────────────────────────────────────────────
    // Test 1: SQLiteMemoryStore Durability Across Process/Instance Restarts
    // ─────────────────────────────────────────────────────────────────────────
    await runTest("SQLiteMemoryStore persists tiered memories across store re-instantiations", async () => {
      const dbFile = path.join(tempDir, "test_memory.db");

      // Instance 1: write memories
      const store1 = new SQLiteMemoryStore(dbFile);
      await store1.set("user_name", "Alice", "long-term", ["identity", "profile"]);
      await store1.set("favorite_language", "TypeScript", "semantic", ["coding", "prefs"]);
      await store1.set("scratchpad", "temporary draft", "working");
      store1.close();

      // Instance 2: read memories back from same DB
      const store2 = new SQLiteMemoryStore(dbFile);

      const userName = await store2.get("user_name");
      assert(userName === "Alice", "long-term memory must survive restart");

      const favLang = await store2.get("favorite_language");
      assert(favLang === "TypeScript", "semantic memory must survive restart");

      const longTermEntries = await store2.getByTier("long-term");
      assert(longTermEntries.length === 1, "Should have 1 long-term entry");
      assert(
        Boolean(longTermEntries[0].tags?.includes("identity")),
        "Tags must be preserved"
      );

      // Search
      const searchMatches = await store2.search("typescript");
      assert(searchMatches.length === 1, "Search must find entry by value");
      assert(searchMatches[0].key === "favorite_language", "Matching key must match");

      store2.close();
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Test 2: Automated Context Retrieval & Prompt Assembly
    // ─────────────────────────────────────────────────────────────────────────
    await runTest("Agent retrieves relevant memories and injects them into system context", async () => {
      const dbFile = path.join(tempDir, "agent_context_retrieval.db");
      const mock = new MockModelProvider();
      mock.addAnswer("Final response after reading context.");

      const agent = new Agent({
        model: mock,
        verbose: false,
        dbPath: dbFile,
      });

      // Pre-seed memory with knowledge
      await agent.getMemory().remember("long-term", "db_server_port", 5432, ["database", "postgres", "config"]);
      await agent.getMemory().remember("long-term", "api_gateway_url", "https://api.internal:8080", ["gateway", "network"]);

      // Run task related to database
      await agent.run("Connect to the database server port");

      // Inspect the requests received by MockModelProvider
      const requests = mock.getRequests();
      assert(requests.length > 0, "Model should have received at least 1 request");

      const initialMessages = requests[0].messages;
      const systemMessage = initialMessages.find((m) => m.role === "system");
      assert(Boolean(systemMessage), "A system message must be generated");
      assert(
        systemMessage?.content?.includes("Relevant Past Knowledge") ?? false,
        "System prompt must contain Retrieved Past Knowledge header"
      );
      assert(
        systemMessage?.content?.includes("db_server_port") ?? false,
        "System prompt must include retrieved memory key db_server_port"
      );

      agent.dispose();
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Test 3: Task Outcome Persistence & memory.updated Event
    // ─────────────────────────────────────────────────────────────────────────
    await runTest("Agent automatically persists task outcomes and emits memory.updated events", async () => {
      const dbFile = path.join(tempDir, "agent_outcome_memory.db");
      const mock = new MockModelProvider();
      mock.addAnswer("Task calculation completed: 42");

      const agent = new Agent({
        model: mock,
        verbose: false,
        dbPath: dbFile,
      });

      const memoryUpdatedEvents: AgentEvent[] = [];
      agent.getEventBus().on("memory.updated", (e: any) => memoryUpdatedEvents.push(e));

      const res = await agent.run("Calculate important metric");

      assert(memoryUpdatedEvents.length > 0, "memory.updated event must be emitted");
      assert(
        memoryUpdatedEvents[0].runId === res.runId,
        "memory.updated event must have matching runId"
      );
      assert(
        memoryUpdatedEvents[0].taskId === res.taskId,
        "memory.updated event must have matching taskId"
      );

      // Verify that outcome is stored in long-term memory
      const outcome = (await agent.getMemory().getLongTerm(`task_outcome:${res.taskId}`)) as any;
      assert(outcome !== null, "Outcome must be saved to long-term memory");
      assert(outcome.status === "COMPLETED", "Outcome status must be COMPLETED");
      assert(outcome.output === "Task calculation completed: 42", "Outcome output must be recorded");

      agent.dispose();
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Test 4: HTTP Request Tool Execution & Cancellation
    // ─────────────────────────────────────────────────────────────────────────
    await runTest("http_request executes requests and respects AbortSignal", async () => {
      // Create a local lightweight HTTP server for deterministic testing
      const server = http.createServer((req, res) => {
        if (req.url === "/api/info") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "healthy", version: "1.0.0" }));
        } else if (req.url === "/api/slow") {
          // Slow endpoint for abort testing
          setTimeout(() => {
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("slow response");
          }, 3000);
        } else {
          res.writeHead(404);
          res.end("Not found");
        }
      });

      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const address = server.address() as any;
      const baseUrl = `http://127.0.0.1:${address.port}`;

      const tools = httpTools({ allowPrivateNetworks: true });
      const httpTool = tools.find((t) => t.name === "http_request")!;
      assert(Boolean(httpTool), "http_request tool must be registered");

      // 1. Successful GET
      const successOutput = await httpTool.execute(
        { url: `${baseUrl}/api/info`, method: "GET" },
        { runId: "r1", taskId: "t1", emit: () => {} }
      );
      assert(successOutput.includes("HTTP 200"), "Response must indicate HTTP 200");
      assert(successOutput.includes('"status": "healthy"'), "Response must include JSON body");

      // 2. Cancellation via AbortSignal
      const controller = new AbortController();
      const cancelPromise = httpTool.execute(
        { url: `${baseUrl}/api/slow`, method: "GET" },
        { runId: "r2", taskId: "t2", emit: () => {}, signal: controller.signal }
      );

      // Abort after 50ms
      setTimeout(() => controller.abort(), 50);
      const cancelOutput = await cancelPromise;

      assert(
        cancelOutput.includes("aborted by cancellation signal"),
        "Cancelled request must report cancellation error"
      );

      server.close();
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Test 5: PermissionEngine HTTP Origin Policy & Protocol Safety
    // ─────────────────────────────────────────────────────────────────────────
    await runTest("PermissionEngine enforces allowed/blocked origins and protocol security", async () => {
      const pe = new PermissionEngine({
        http: {
          allowOrigins: ["https://api.github.com", "https://api.openai.com"],
          denyOrigins: ["https://api.github.com/blocked"],
        },
      });

      // Allowed origin
      const d1 = pe.check("http_request", { url: "https://api.github.com/user/repos" });
      assert(d1.allowed, "Allowed origin must be permitted");

      // Disallowed origin
      const d2 = pe.check("http_request", { url: "https://malicious-site.com/steal" });
      assert(!d2.allowed, "Unapproved origin must be denied");
      assert(d2.reason?.includes("not in allowed origins") ?? false, "Reason must cite allowed origins");

      // Forbidden protocol (file:)
      const d3 = pe.check("http_request", { url: "file:///C:/Windows/System32" });
      assert(!d3.allowed, "file: protocol must be rejected");
      assert(d3.reason?.includes("Forbidden protocol") ?? false, "Reason must cite forbidden protocol");
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Test 6: Audit Execution Replay (agent.replay)
    // ─────────────────────────────────────────────────────────────────────────
    await runTest("agent.replay(runId) reconstructs execution timeline, events, and tool calls", async () => {
      const dbFile = path.join(tempDir, "replay_verification.db");
      const mock = new MockModelProvider();

      // Tool call step then final answer
      mock.addToolCall("filesystem_write", {
        path: path.join(tempDir, "replay_test.txt"),
        content: "recorded for replay",
      });
      mock.addAnswer("File saved and operation finished.");

      const agent = new Agent({
        model: mock,
        tools: [...filesystemTools(), ...httpTools()],
        permissions: { trusted: true },
        verbose: false,
        dbPath: dbFile,
      });

      const res = await agent.run("Perform reproducible action");

      // Replay the run using agent.replay(runId)
      const replayData = await agent.replay(res.runId);

      assert(replayData.run !== null, "Run record must be replayed");
      assert(replayData.run?.runId === res.runId, "Replayed runId must match");
      assert(replayData.run?.status === "COMPLETED", "Replayed status must be COMPLETED");

      assert(replayData.events.length >= 4, "Timeline events must be preserved");
      assert(
        replayData.events.some((e: any) => e.type === "agent.started"),
        "agent.started event must be in replay timeline"
      );
      assert(
        replayData.events.some((e: any) => e.type === "memory.updated"),
        "memory.updated event must be in replay timeline"
      );

      assert(replayData.toolCalls.length === 1, "Tool calls must be preserved in replay");
      assert(
        replayData.toolCalls[0].toolName === "filesystem_write",
        "Replayed tool call name must match"
      );

      agent.dispose();
    });
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  console.log("\n════════════════════════════════════════════════════════════");
  console.log(`PHASE 3 SUITE RESULT: ${passed} passed, ${failed} failed`);
  console.log("════════════════════════════════════════════════════════════\n");

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error running Phase 3 tests:", err);
  process.exit(1);
});

// ─── AgentOS v0.1 — Comprehensive E2E Verification Test Suite ─────────────
//
// Verifies all core pillars of AgentOS v0.1:
// 1. ReAct execution loop & observation feeding
// 2. Permission enforcement (filesystem & terminal restrictions)
// 3. Approval workflow (risk-level policies & approval denial)
// 4. Lifecycle controls (pause, resume, cancel)
// 5. SQLite persistence (runs, events, replay queries)
// 6. Observability (structured traces & JSON export)

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import {
  Agent,
  MockModelProvider,
  filesystemTools,
  terminalTools,
  AutoApprovalHandler,
  SQLiteStore,
  type ApprovalHandler,
} from "@agentos/agent";

import type { RiskLevel } from "@agentos/core";

// ─── Simple Test Runner ──────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
  process.stdout.write(`  ▶ ${name} ... `);
  try {
    await fn();
    console.log("✅ PASS");
    passed++;
  } catch (err) {
    console.log("❌ FAIL");
    console.error(`    ${(err as Error).message}\n`);
    failed++;
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

// ─── Main Test Suite ─────────────────────────────────────────────────────────

async function runAllTests() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║     🧪 AgentOS v0.1 — End-to-End Test Suite             ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  const tempDir = path.join(os.tmpdir(), `agentos_e2e_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    // ─────────────────────────────────────────────────────────────────────────
    // Test 1: Full ReAct Loop Execution
    // ─────────────────────────────────────────────────────────────────────────
    await test("ReAct loop executes tools and synthesizes final answer", async () => {
      const mock = new MockModelProvider();
      const testFile = path.join(tempDir, "greeting.txt");
      fs.writeFileSync(testFile, "Hello from AgentOS!");

      mock.addToolCall("filesystem_read", { path: testFile });
      mock.addAnswer("Read file content: Hello from AgentOS!");

      const agent = new Agent({
        model: mock,
        tools: filesystemTools(),
        permissions: {
          filesystem: {
            read: [tempDir],
          },
        },
        approvalHandler: new AutoApprovalHandler(),
        verbose: false,
        dbPath: ":memory:",
      });

      const res = await agent.run("Read the greeting file");
      agent.dispose();

      assert(res.success, "Agent run should succeed");
      assert(res.iterations === 1, "Should complete in 1 iteration");
      assert(res.output?.includes("Hello from AgentOS!") ?? false, "Output should contain greeting");
      assert(res.events.some((e: any) => e.type === "tool.completed"), "Should emit tool.completed");
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Test 2: Permission Enforcement (Filesystem Read Restriction)
    // ─────────────────────────────────────────────────────────────────────────
    await test("PermissionEngine blocks filesystem access outside allowed paths", async () => {
      const mock = new MockModelProvider();
      const secretFile = path.join(os.tmpdir(), "secret_file.txt");
      fs.writeFileSync(secretFile, "top secret");

      // Model tries to read an unauthorized file
      mock.addToolCall("filesystem_read", { path: secretFile });
      // Model then sees the permission error and finishes
      mock.addAnswer("I cannot access that file due to permission restrictions.");

      const agent = new Agent({
        model: mock,
        tools: filesystemTools(),
        permissions: {
          filesystem: {
            read: [tempDir], // ONLY allow tempDir, NOT os.tmpdir() root
          },
        },
        approvalHandler: new AutoApprovalHandler(),
        verbose: false,
        dbPath: ":memory:",
      });

      const res = await agent.run("Read the secret file");
      agent.dispose();

      if (fs.existsSync(secretFile)) fs.unlinkSync(secretFile);

      // Verify that tool.failed was emitted due to permission denial
      const failedEvent = res.events.find((e: any) => e.type === "tool.failed");
      assert(Boolean(failedEvent), "tool.failed event should be emitted");
      assert(
        JSON.stringify(failedEvent?.data).includes("Permission denied"),
        "Error message should indicate permission denied"
      );
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Test 3: Permission Enforcement (Terminal Command Restriction)
    // ─────────────────────────────────────────────────────────────────────────
    await test("PermissionEngine blocks unauthorized terminal commands", async () => {
      const mock = new MockModelProvider();

      // Model attempts to run a denied command
      mock.addToolCall("terminal_exec", { command: "rm -rf /" });
      mock.addAnswer("The command was blocked.");

      const agent = new Agent({
        model: mock,
        tools: terminalTools(),
        permissions: {
          terminal: {
            allow: ["echo", "git"],
            deny: ["rm", "del"],
          },
        },
        approvalHandler: new AutoApprovalHandler(),
        verbose: false,
        dbPath: ":memory:",
      });

      const res = await agent.run("Run command");
      agent.dispose();

      const failedEvent = res.events.find((e: any) => e.type === "tool.failed");
      assert(Boolean(failedEvent), "tool.failed event should be emitted for denied command");
      assert(
        JSON.stringify(failedEvent?.data).includes("Permission denied"),
        "Error message should indicate permission denied"
      );
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Test 4: Approval Workflow (Denying Risky Actions)
    // ─────────────────────────────────────────────────────────────────────────
    await test("ApprovalManager halts tool execution when user denies approval", async () => {
      const mock = new MockModelProvider();
      const targetFile = path.join(tempDir, "to_delete.txt");
      fs.writeFileSync(targetFile, "delete me");

      // filesystem_delete is HIGH risk
      mock.addToolCall("filesystem_delete", { path: targetFile });
      mock.addAnswer("File deletion was cancelled by user.");

      // Custom handler that denies all approval requests
      const rejectingHandler: ApprovalHandler = {
        async requestApproval() {
          return "DENIED";
        },
      };

      const agent = new Agent({
        model: mock,
        tools: filesystemTools(),
        permissions: {
          filesystem: {
            write: [tempDir],
          },
          approval: {
            requireFor: "HIGH",
          },
        },
        approvalHandler: rejectingHandler,
        verbose: false,
        dbPath: ":memory:",
      });

      const res = await agent.run("Delete the file");
      agent.dispose();

      // Target file should STILL exist because user rejected
      assert(fs.existsSync(targetFile), "File must NOT be deleted when approval is denied");

      const failedEvent = res.events.find((e: any) => e.type === "tool.failed");
      assert(Boolean(failedEvent), "tool.failed event must be emitted on rejection");
      assert(
        JSON.stringify(failedEvent?.data).includes("denied by user"),
        "Should log denial by user"
      );
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Test 5: SQLite Persistence & Replay
    // ─────────────────────────────────────────────────────────────────────────
    await test("SQLiteStore persists runs, events, and state", async () => {
      const dbFile = path.join(tempDir, "test_persistence.db");
      const mock = new MockModelProvider();
      mock.addAnswer("SQLite test complete.");

      const agent = new Agent({
        model: mock,
        verbose: false,
        dbPath: dbFile,
      });

      const res = await agent.run("Test SQLite persistence");
      agent.dispose();

      assert(fs.existsSync(dbFile), "Database file should be created on disk");

      // Verify records with a fresh SQLiteStore instance
      const store = new SQLiteStore(dbFile);
      const savedRun = store.getRun(res.runId);
      assert(savedRun !== null, "Run record should exist in DB");
      assert(savedRun?.status === "COMPLETED", "Run status should be COMPLETED");

      const savedEvents = store.getEventsByRun(res.runId);
      assert(savedEvents.length > 0, "Events should be persisted in DB");
      assert(
        savedEvents.some((e: any) => e.type === "agent.started"),
        "agent.started should be persisted"
      );
      assert(
        savedEvents.some((e: any) => e.type === "task.completed"),
        "task.completed should be persisted"
      );

      // State test
      store.saveState(`${res.runId}:custom_key`, { testVal: 123 });
      const state = store.getState(`${res.runId}:custom_key`) as { testVal: number } | null;
      assert(state?.testVal === 123, "State should be persisted and retrieved correctly");

      store.close();
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Test 6: Observability Tracing & JSON Export
    // ─────────────────────────────────────────────────────────────────────────
    await test("Tracer records full execution history and exports valid JSON trace", async () => {
      const mock = new MockModelProvider();
      mock.addAnswer("Trace test done.");

      const agent = new Agent({
        model: mock,
        verbose: false,
        dbPath: ":memory:",
      });

      const res = await agent.run("Trace verification");
      const tracer = agent.getTracer();

      const traceEntries = tracer.getTrace(res.runId);
      assert(traceEntries.length >= 3, "Trace should contain task_start, planner_call, task_end");

      const exportedJson = tracer.exportTrace(res.runId);
      assert(exportedJson.length > 0, "Exported JSON should not be empty");

      const parsed = JSON.parse(exportedJson);
      assert(parsed.runId === res.runId, "Trace runId should match");
      assert(Array.isArray(parsed.entries), "Exported trace must contain entries array");
      assert(parsed.entries.length === traceEntries.length, "Exported entries count should match");

      agent.dispose();
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Test 7: Lifecycle Cancellation
    // ─────────────────────────────────────────────────────────────────────────
    await test("Agent respects cancellation request", async () => {
      const mock = new MockModelProvider();
      // Setup a multi-iteration task
      const targetPath = path.join(tempDir, "file_a.txt");
      fs.writeFileSync(targetPath, "data");

      const agent = new Agent({
        model: mock,
        tools: filesystemTools(),
        verbose: false,
        dbPath: ":memory:",
      });

      // Cancel before running or during
      await agent.cancel();
      assert(agent.getStatus() === "CANCELLED", "Agent status should be CANCELLED");

      const res = await agent.run("Task that is cancelled");
      assert(res.iterations === 0, "Cancelled agent should stop immediately without iterating");
      agent.dispose();
    });
  } finally {
    // Cleanup test dir
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  console.log("\n" + "═".repeat(60));
  console.log(`SUMMARY: ${passed} passed, ${failed} failed`);
  console.log("═".repeat(60) + "\n");

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runAllTests().catch((err) => {
  console.error("Test runner encountered an error:", err);
  process.exit(1);
});

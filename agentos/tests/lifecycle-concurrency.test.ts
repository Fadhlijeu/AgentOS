// ─── Phase 2: Lifecycle, Concurrency & State Machine Test Suite ──────────────
// Validates:
// 1. Strict state machine transitions & illegal jump rejection
// 2. Real AbortSignal propagation & instant process termination on cancel()
// 3. Concurrent task run isolation on a single Agent instance
// 4. Traceable lifecycle events with non-empty runId and taskId
// 5. Structured tool_calls persistence in SQLite

import fs from "fs";
import path from "path";
import os from "os";
import {
  Agent,
  MockModelProvider,
  terminalTools,
  filesystemTools,
  RunStateMachine,
  IllegalStateTransitionError,
  SQLiteStore,
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
  process.stdout.write(`  ⚡ ${name} ... `);
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
  console.log("║     ⚡ AgentOS v0.1 — Phase 2 Lifecycle & Concurrency   ║");
  console.log("║          (Verification for audit_0.1.md P0 Fixes)        ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-lifecycle-"));

  try {
    // ─────────────────────────────────────────────────────────────────────────
    // Test 1: Strict RunStateMachine Transitions & Illegal Transition Rejection
    // ─────────────────────────────────────────────────────────────────────────
    await runTest("RunStateMachine strictly enforces transitions and blocks illegal jumps", async () => {
      const sm = new RunStateMachine("IDLE");
      assert(sm.status === "IDLE", "Initial state must be IDLE");

      // Valid: IDLE -> RUNNING
      sm.transitionTo("RUNNING");
      assert(sm.status === "RUNNING", "State must be RUNNING");

      // Valid: RUNNING -> PAUSED
      sm.transitionTo("PAUSED");
      assert(sm.status === "PAUSED", "State must be PAUSED");

      // Valid: PAUSED -> RUNNING
      sm.transitionTo("RUNNING");
      assert(sm.status === "RUNNING", "State must be RUNNING");

      // Valid: RUNNING -> COMPLETED
      sm.transitionTo("COMPLETED");
      assert(sm.status === "COMPLETED", "State must be COMPLETED");
      assert(sm.isTerminal(), "COMPLETED must be a terminal state");

      // Illegal: COMPLETED -> PAUSED (Terminal state must not transition)
      let threw = false;
      try {
        sm.transitionTo("PAUSED");
      } catch (err) {
        threw = true;
        assert(
          err instanceof IllegalStateTransitionError,
          "Must throw IllegalStateTransitionError"
        );
      }
      assert(threw, "COMPLETED -> PAUSED must throw");

      // Illegal: CANCELLED -> RUNNING
      const sm2 = new RunStateMachine("RUNNING");
      sm2.transitionTo("CANCELLED");
      assert(sm2.isTerminal(), "CANCELLED must be terminal");
      let threw2 = false;
      try {
        sm2.transitionTo("RUNNING");
      } catch (err) {
        threw2 = true;
        assert(err instanceof IllegalStateTransitionError, "Must throw IllegalStateTransitionError");
      }
      assert(threw2, "CANCELLED -> RUNNING must throw");
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Test 2: Real AbortSignal Cancellation of In-Flight Terminal Process
    // ─────────────────────────────────────────────────────────────────────────
    await runTest("run.cancel() aborts active terminal command immediately via AbortSignal", async () => {
      const mock = new MockModelProvider();
      // Ask model to execute a 10-second command
      const sleepCmd = process.platform === "win32" ? "ping 127.0.0.1 -n 11" : "sleep 10";
      mock.addToolCall("terminal_exec", { command: sleepCmd });

      const agent = new Agent({
        model: mock,
        tools: terminalTools(),
        permissions: { trusted: true },
        verbose: false,
        dbPath: ":memory:",
      });

      const startTime = Date.now();
      const run = agent.start("Run a long sleep command");

      // Wait 150ms for the child process to spawn
      await new Promise((r) => setTimeout(r, 150));

      // Trigger immediate cancellation
      await run.cancel();

      const result = await run.result;
      const elapsed = Date.now() - startTime;

      assert(run.status === "CANCELLED", "Run status must be CANCELLED");
      assert(!result.success, "Result must not be marked success");
      // The process was scheduled for 10 seconds, but must abort in under 2 seconds
      assert(
        elapsed < 2500,
        `Cancellation must terminate process immediately, but took ${elapsed}ms`
      );

      agent.dispose();
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Test 3: Concurrent Task Run Isolation on Single Agent Instance
    // ─────────────────────────────────────────────────────────────────────────
    await runTest("Concurrent runs execute in isolated contexts without state collisions", async () => {
      const mock = new MockModelProvider();
      // Set a handler that responds to both tasks
      mock.addAnswer("Task A result");
      mock.addAnswer("Task B result");

      const agent = new Agent({
        model: mock,
        verbose: false,
        dbPath: ":memory:",
      });

      const runA = agent.start("Task A");
      const runB = agent.start("Task B");

      assert(runA.runId !== runB.runId, "Runs must have unique run IDs");
      assert(runA.taskId !== runB.taskId, "Runs must have unique task IDs");

      const [resA, resB] = await Promise.all([runA.result, runB.result]);

      assert(resA.runId === runA.runId, "Result A must match Run A ID");
      assert(resB.runId === runB.runId, "Result B must match Run B ID");
      assert(resA.success && resB.success, "Both runs must complete successfully");

      agent.dispose();
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Test 4: Traceable Lifecycle Events with Non-Empty runId and taskId
    // ─────────────────────────────────────────────────────────────────────────
    await runTest("agent.paused and agent.resumed carry valid runId and taskId", async () => {
      const mock = new MockModelProvider();
      const agent = new Agent({
        model: mock,
        verbose: false,
        dbPath: ":memory:",
      });

      const pausedEvents: AgentEvent[] = [];
      const resumedEvents: AgentEvent[] = [];

      agent.getEventBus().on("agent.paused", (e) => pausedEvents.push(e));
      agent.getEventBus().on("agent.resumed", (e) => resumedEvents.push(e));

      // Emulate multiple tool calls so we can pause between them
      mock.addToolCall("filesystem_read", { path: path.join(tempDir, "sample.txt") });
      mock.addAnswer("Done after resume");

      fs.writeFileSync(path.join(tempDir, "sample.txt"), "hello world");

      const run = agent.start("Task with pause and resume");

      // Pause the run
      await run.pause();
      assert(run.status === "PAUSED", "Status must be PAUSED");
      assert(pausedEvents.length === 1, "agent.paused event must be emitted");
      assert(
        pausedEvents[0].runId === run.runId,
        `runId in agent.paused must match (${pausedEvents[0].runId} vs ${run.runId})`
      );
      assert(
        Boolean(pausedEvents[0].taskId),
        "taskId in agent.paused must not be empty"
      );

      // Resume the run
      await run.resume();
      assert(resumedEvents.length === 1, "agent.resumed event must be emitted");
      assert(
        resumedEvents[0].runId === run.runId,
        `runId in agent.resumed must match (${resumedEvents[0].runId} vs ${run.runId})`
      );
      assert(
        Boolean(resumedEvents[0].taskId),
        "taskId in agent.resumed must not be empty"
      );

      const res = await run.result;
      assert(res.success, "Resumed task must succeed");

      agent.dispose();
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Test 5: Structured SQLite Persistence for Tool Calls
    // ─────────────────────────────────────────────────────────────────────────
    await runTest("SQLiteStore persists every tool_call execution step with duration and results", async () => {
      const dbFile = path.join(tempDir, "test_tool_calls.db");
      const mock = new MockModelProvider();

      const testFilePath = path.join(tempDir, "persisted_test.txt");
      mock.addToolCall("filesystem_write", {
        path: testFilePath,
        content: "persisted content",
      });
      mock.addAnswer("Write completed.");

      const agent = new Agent({
        model: mock,
        tools: filesystemTools(),
        permissions: { trusted: true },
        verbose: false,
        dbPath: dbFile,
      });

      const res = await agent.run("Write to file and persist tool call record");
      agent.dispose();

      // Verify records directly from SQLite
      const store = new SQLiteStore(dbFile);
      const toolCalls = store.getToolCallsByRun(res.runId);

      assert(toolCalls.length === 1, "Exactly one tool call should be persisted");
      const call = toolCalls[0];
      assert(call.runId === res.runId, "tool_call.run_id must match runId");
      assert(call.toolName === "filesystem_write", "tool_name must be filesystem_write");
      assert(
        call.arguments.path === testFilePath,
        "tool_call.arguments must contain path"
      );
      assert(
        call.result !== null && call.result.includes("Successfully wrote"),
        "tool_call.result must be stored"
      );
      assert(call.durationMs >= 0, "tool_call.duration_ms must be non-negative");
      assert(call.error === null, "tool_call.error must be null for successful calls");

      store.close();
    });
  } finally {
    // Cleanup temporary test directory
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  console.log("\n════════════════════════════════════════════════════════════");
  console.log(`LIFECYCLE & CONCURRENCY SUITE RESULT: ${passed} passed, ${failed} failed`);
  console.log("════════════════════════════════════════════════════════════\n");

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error running lifecycle tests:", err);
  process.exit(1);
});

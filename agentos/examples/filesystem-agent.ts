// ─── AgentOS v0.1 — Filesystem Agent (Offline Verification) ───────────────
//
// This example demonstrates the full ReAct loop end-to-end without requiring
// an external OpenAI API key, using MockModelProvider.
//
// Lifecycle demonstrated:
//   Agent.run()
//     → EventBus: agent.started, task.started
//     → ReActPlanner: analyzes task & available tools
//     → Model: returns tool_call (filesystem.list)
//     → PermissionEngine: validates path & permission
//     → ToolRegistry: executes filesystem.list
//     → EventBus: tool.requested, tool.started, tool.completed
//     → WorkingMemory: appends observation
//     → Model: returns tool_call (filesystem.read)
//     → ToolRegistry: executes filesystem.read
//     → Model: returns final answer summarizing findings
//     → SQLiteStore: persists events & run metadata
//     → Tracer: exports execution trace
//     → EventBus: task.completed
//
// Run with:
//   npx tsx agentos/examples/filesystem-agent.ts

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import {
  Agent,
  MockModelProvider,
  filesystemTools,
  AutoApprovalHandler,
} from "@agentos/agent";

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║         📁 AgentOS v0.1 — Filesystem Agent Demo         ║");
  console.log("║          (Deterministic Offline ReAct Loop)              ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  // 1. Create a temporary scratch workspace
  const tempDir = path.join(os.tmpdir(), `agentos_test_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  const sampleDocPath = path.join(tempDir, "quarterly_results.txt");
  fs.writeFileSync(
    sampleDocPath,
    "Q3 Executive Summary: Revenue increased by 24% YoY. Operating margin reached 31%. AI product adoption grew 140%."
  );

  const notesPath = path.join(tempDir, "todo.txt");
  fs.writeFileSync(notesPath, "1. Review Q3 results\n2. Prepare slide deck\n3. Schedule sync");

  console.log(`[Setup] Created temporary directory: ${tempDir}`);
  console.log(`[Setup] Seeded files: quarterly_results.txt, todo.txt\n`);

  // 2. Configure MockModelProvider with scripted ReAct reasoning steps
  const mockModel = new MockModelProvider();

  // Step 1: Model decides to list the directory
  mockModel.addToolCall(
    "filesystem.list",
    { path: tempDir },
    "First, I need to list the files in the directory to see what documents exist."
  );

  // Step 2: Model decides to read the quarterly results file
  mockModel.addToolCall(
    "filesystem.read",
    { path: sampleDocPath },
    "I see quarterly_results.txt. Let me read its contents to summarize the findings."
  );

  // Step 3: Model returns the final answer
  mockModel.addAnswer(
    `Summary of ${path.basename(sampleDocPath)}:\n` +
      `- Revenue: Increased by 24% YoY\n` +
      `- Operating Margin: Reached 31%\n` +
      `- Product Adoption: AI adoption grew 140%\n\n` +
      `All files in ${tempDir} were successfully inspected.`
  );

  // 3. Initialize Agent with tools, permissions, and in-memory SQLite store
  const agent = new Agent({
    model: mockModel,
    tools: filesystemTools(),
    permissions: {
      filesystem: {
        read: [tempDir],
        write: [tempDir],
      },
    },
    approvalHandler: new AutoApprovalHandler(),
    verbose: true,
    dbPath: ":memory:",
    maxIterations: 10,
  });

  const task = `Find and summarize the quarterly results file in ${tempDir}`;
  console.log(`[Task] "${task}"\n`);
  console.log("─".repeat(60));

  try {
    const result = await agent.run(task);

    console.log("\n" + "═".repeat(60));
    console.log("EXECUTION VERIFICATION REPORT");
    console.log("═".repeat(60));
    console.log(`Status:      ${result.success ? "✅ SUCCESS" : "❌ FAILED"}`);
    console.log(`Run ID:      ${result.runId}`);
    console.log(`Iterations:  ${result.iterations} steps`);
    console.log(`Duration:    ${result.durationMs} ms`);
    console.log(`Model Calls: ${mockModel.callCount}`);
    console.log(`Events Log:  ${result.events.length} events emitted`);

    // Verify key event types were emitted in correct sequence
    const eventTypes = result.events.map((e) => e.type);
    console.log("\nEmitted Event Flow:");
    eventTypes.forEach((type, idx) => {
      console.log(`  ${idx + 1}. ${type}`);
    });

    const hasStart = eventTypes.includes("agent.started") && eventTypes.includes("task.started");
    const hasToolCalls = eventTypes.includes("tool.requested") && eventTypes.includes("tool.completed");
    const hasTaskEnd = eventTypes.includes("task.completed");

    console.log("\nVerification Checks:");
    console.log(`  [Check 1] Lifecycle Start Events:  ${hasStart ? "✅ PASS" : "❌ FAIL"}`);
    console.log(`  [Check 2] Tool Execution Events:   ${hasToolCalls ? "✅ PASS" : "❌ FAIL"}`);
    console.log(`  [Check 3] Task Completion Event:   ${hasTaskEnd ? "✅ PASS" : "❌ FAIL"}`);
    console.log(`  [Check 4] Output Received:         ${result.output.length > 0 ? "✅ PASS" : "❌ FAIL"}`);

    console.log("\n" + "─".repeat(60));
    console.log("Final Agent Output:\n");
    console.log(result.output);
    console.log("─".repeat(60) + "\n");

    if (!result.success || !hasStart || !hasToolCalls || !hasTaskEnd) {
      throw new Error("Verification checks failed!");
    }
  } finally {
    agent.dispose();

    // Clean up temporary files
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
      console.log(`[Cleanup] Removed temporary directory: ${tempDir}`);
    } catch {
      // ignore cleanup errors
    }
  }
}

main().catch((err) => {
  console.error("Verification failed with error:", err);
  process.exit(1);
});

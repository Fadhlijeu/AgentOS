// ─── Upstream Integrations Test Suite ─────────────────────────────────────────
// Validates:
// 1. OpenInterpreterAdapter multi-language code execution (Python, Node.js)
// 2. OpenInterpreterAdapter execution failure & timeout / abort handling
// 3. createInterpreterTool wrapping with Zod schema validation
// 4. OpenHandsWorkspaceAdapter boundary isolation & traversal denial
// 5. OpenHandsEventMapper bidirectional Action/Observation translation

import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import {
  OpenInterpreterAdapter,
  createInterpreterTool,
  OpenHandsWorkspaceAdapter,
  OpenHandsEventMapper,
  OpenHandsWorkspaceError,
  type OpenHandsAction,
} from "@agentos/adapters";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${msg}`);
  }
}

async function runTest(name: string, fn: () => Promise<void>): Promise<void> {
  process.stdout.write(`  🔌 [Upstream] ${name} ... `);
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
  console.log("║     🔌 AgentOS — Upstream Integrations Test Suite        ║");
  console.log("║   (Open Interpreter Execution & OpenHands Workspace)     ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  const interpreter = new OpenInterpreterAdapter();
  const testWorkspaceDir = path.join(os.tmpdir(), `agentos_openhands_${Date.now()}`);

  try {
    // ── Test 1: Open Interpreter Python Execution ────────────────────────────
    await runTest("OpenInterpreterAdapter executes Python code and captures stdout", async () => {
      const res = await interpreter.execute(
        "python",
        "numbers = [10, 20, 30]\nprint(sum(numbers))"
      );
      assert(res.exitCode === 0, `Exit code should be 0, got ${res.exitCode}`);
      assert(res.stdout === "60", `Expected stdout "60", got "${res.stdout}"`);
      assert(res.durationMs >= 0, "Duration should be measured");
    });

    // ── Test 2: Open Interpreter Node.js Execution ───────────────────────────
    await runTest("OpenInterpreterAdapter executes JavaScript and captures stdout", async () => {
      const res = await interpreter.execute(
        "javascript",
        "const msg = 'AgentOS ' + (1 + 1); console.log(msg);"
      );
      assert(res.exitCode === 0, `Exit code should be 0, got ${res.exitCode}`);
      assert(res.stdout === "AgentOS 2", `Expected "AgentOS 2", got "${res.stdout}"`);
    });

    // ── Test 3: Open Interpreter Error & Exit Status ─────────────────────────
    await runTest("OpenInterpreterAdapter captures execution errors and non-zero exit", async () => {
      const res = await interpreter.execute("python", "raise ValueError('Custom crash message')");
      assert(res.exitCode !== 0, "Non-zero exit code expected on exception");
      assert(res.stderr.includes("Custom crash message"), "Stderr should contain exception details");
    });

    // ── Test 4: Open Interpreter Timeout & Cancellation ──────────────────────
    await runTest("OpenInterpreterAdapter terminates hanging process on timeout", async () => {
      const res = await interpreter.execute(
        "python",
        "import time\ntime.sleep(5)",
        { timeoutMs: 300 }
      );
      assert(res.exitCode !== 0, "Timed-out process should exit with non-zero code");
      assert(res.stderr.includes("timed out"), "Stderr should report timeout termination");
    });

    // ── Test 5: createInterpreterTool Schema Validation ──────────────────────
    await runTest("createInterpreterTool enforces Zod input schema and risk level", async () => {
      const tool = createInterpreterTool(interpreter);
      assert(tool.name === "code_interpret", "Tool name must be code_interpret");
      assert(tool.riskLevel === "HIGH", "Code interpretation tool must be HIGH risk");

      const validOutput = await tool.execute(
        {
          language: "python",
          code: "print('Hello from tool')",
        },
        { runId: "test_run", taskId: "test_task", emit: () => {} }
      );
      assert(validOutput.includes("Hello from tool"), "Output must contain stdout");
      assert(validOutput.includes("[Duration:"), "Output must contain execution metadata");
    });

    // ── Test 6: OpenHands Workspace Isolation ────────────────────────────────
    await runTest("OpenHandsWorkspaceAdapter manages files within sandbox boundary", async () => {
      const ohWorkspace = new OpenHandsWorkspaceAdapter(testWorkspaceDir);

      await ohWorkspace.writeFile("config.json", JSON.stringify({ active: true }));
      assert(await ohWorkspace.exists("config.json"), "Written file must exist in workspace");

      const readBack = await ohWorkspace.readFile("config.json");
      assert(JSON.parse(readBack).active === true, "File content should match written data");

      const stats = await ohWorkspace.getStats("config.json");
      assert(stats.size > 0 && !stats.isDirectory, "Stats should reflect written file");

      const files = await ohWorkspace.listFiles();
      assert(files.includes("config.json"), "listFiles must list workspace files");
    });

    // ── Test 7: OpenHands Traversal Denial ────────────────────────────────────
    await runTest("OpenHandsWorkspaceAdapter rejects path traversal escapes", async () => {
      const ohWorkspace = new OpenHandsWorkspaceAdapter(testWorkspaceDir);
      let errorCaught = false;

      try {
        await ohWorkspace.readFile("../escaped_file.txt");
      } catch (err) {
        if (err instanceof OpenHandsWorkspaceError) {
          errorCaught = true;
          assert(err.message.includes("OpenHands boundary"), "Error must cite OpenHands boundary");
        }
      }

      assert(errorCaught, "Path traversal escaping workspace root must throw OpenHandsWorkspaceError");
    });

    // ── Test 8: OpenHands Event Mapping ──────────────────────────────────────
    await runTest("OpenHandsEventMapper translates Action and Observation protocols", async () => {
      const action: OpenHandsAction = {
        action: "browse",
        args: { url: "https://example.com" },
        thought: "I need to open the documentation page",
      };

      const agentEvent = OpenHandsEventMapper.actionToAgentEvent(action, "run_123", "task_456");
      assert(agentEvent.type === "tool.requested", "Action should map to tool.requested");
      assert(agentEvent.data?.toolName === "browser_open", "browse action should map to browser_open");
      assert(agentEvent.data?.thought === action.thought, "Thought should be preserved in event");

      const observation = OpenHandsEventMapper.agentEventToObservation({
        id: "evt_1",
        type: "tool.completed",
        timestamp: Date.now(),
        runId: "run_123",
        taskId: "task_456",
        data: {
          toolName: "browser_open",
          result: "Navigated to https://example.com",
        },
      });

      assert(observation.success === true, "tool.completed should map to success observation");
      assert(observation.observation === "browse_result", "Observation type should be browse_result");
      assert(observation.content.includes("https://example.com"), "Content should be preserved");
    });
  } finally {
    try {
      if (fs.existsSync(testWorkspaceDir)) {
        fs.rmSync(testWorkspaceDir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  }

  console.log("\n════════════════════════════════════════════════════════════");
  console.log(`UPSTREAM INTEGRATIONS TEST RESULT: ${passed} passed, ${failed} failed`);
  console.log("════════════════════════════════════════════════════════════\n");

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error running upstream integrations test:", err);
  process.exit(1);
});

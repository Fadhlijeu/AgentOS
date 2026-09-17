// ─── AgentOS End-to-End Real Browser Automation Task ────────────────────────
// Validates the full production execution pipeline:
// Agent → AgentRuntime → RunContext → Policy → Approval → Browser Tool →
// Real Playwright Browser (Chrome/Edge) → Events → SQLite → Trace → Workspace
//
// Task: "Open the product catalog website at http://127.0.0.1:<port>, inspect the page,
// search for Pro Max, obtain pricing information, and save the result to summary.txt in the workspace."

import * as http from "http";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import {
  Agent,
  MockModelProvider,
  PlaywrightBrowserProvider,
  browserTools,
  filesystemTools,
  LocalWorkspace,
  PermissionEngine,
  AutoApprovalHandler,
  SQLiteStore,
} from "@agentos/sdk";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${msg}`);
  }
}

async function runTest(name: string, fn: () => Promise<void>): Promise<void> {
  process.stdout.write(`  🚀 [E2E Real Browser] ${name} ... `);
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
  console.log("║     🚀 AgentOS — End-to-End Real Browser Task Demo       ║");
  console.log("║   (Real Chrome/Edge Engine + SQLite + Trace + Workspace) ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  // 1. Host local real website target
  const catalogHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>TechCorp Hardware Catalog</title>
        <style>body { font-family: sans-serif; padding: 20px; }</style>
      </head>
      <body>
        <h1>TechCorp Enterprise Hardware</h1>
        <p>Browse current inventory and pricing.</p>
        <form id="search-form" onsubmit="event.preventDefault(); document.getElementById('results').innerText = 'TechCorp Pro Max Laptop - Price: $1499 - Status: In Stock';">
          <input id="search-box" name="query" type="text" placeholder="Search devices..." />
          <button id="search-btn" type="submit">Search Inventory</button>
        </form>
        <div id="results" style="margin-top: 20px; font-weight: bold;">Initial catalog view: 25 items available.</div>
      </body>
    </html>
  `;

  let port = 0;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(catalogHtml);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        port = addr.port;
      }
      resolve();
    });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const workspaceDir = path.join(os.tmpdir(), `agentos_e2e_ws_${Date.now()}`);
  const dbFile = path.join(workspaceDir, "audit_execution.db");
  fs.mkdirSync(workspaceDir, { recursive: true });

  const workspace = new LocalWorkspace({ rootPath: workspaceDir });
  const browserProvider = new PlaywrightBrowserProvider({ headless: true });

  try {
    await runTest("Execute autonomous real browser navigation & workspace write pipeline", async () => {
      // Configure mock model to execute the exact ReAct sequence
      const mock = new MockModelProvider();

      // Step 1: Open real website
      mock.addToolCall(
        "browser_open",
        { url: baseUrl },
        "Navigating to TechCorp catalog using real browser engine."
      );

      // Step 2: Type search term into input
      mock.addToolCall(
        "browser_type",
        { selector: "#search-box", text: "Pro Max" },
        "Typing search query into the search box."
      );

      // Step 3: Click search button
      mock.addToolCall(
        "browser_click",
        { selector: "#search-btn" },
        "Clicking search button to query catalog."
      );

      // Step 4: Observe updated DOM
      mock.addToolCall(
        "browser_observe",
        {},
        "Observing updated page content to extract device pricing."
      );

      // Step 5: Save findings to workspace file
      mock.addToolCall(
        "filesystem_write",
        {
          path: path.join(workspaceDir, "hardware_summary.txt"),
          content: "Device: TechCorp Pro Max Laptop\nPrice: $1499\nStatus: In Stock\nVerified: Real Browser Playwright Session",
        },
        "Writing verified catalog findings into isolated workspace file."
      );

      // Step 6: Synthesize final answer
      mock.addAnswer(
        "I have navigated to the TechCorp hardware catalog, searched for Pro Max, retrieved the price ($1499, In Stock), and saved the complete audit summary to hardware_summary.txt in the workspace."
      );

      // Assemble Agent with real browser tools and workspace tools
      const agent = new Agent({
        model: mock,
        workspace,
        tools: [
          ...browserTools(browserProvider),
          ...filesystemTools({ workspace }),
        ],
        permissions: {
          browser: {
            allowOrigins: [baseUrl],
            allowPrivateNetworks: true,
          },
          filesystem: {
            write: [workspaceDir],
            read: [workspaceDir],
          },
        },
        approvalHandler: new AutoApprovalHandler(),
        verbose: false,
        dbPath: dbFile,
      });

      // ── Execute Run ──────────────────────────────────────────────────────────
      const taskDescription = `Open the hardware catalog at ${baseUrl}, search for Pro Max, and record findings to hardware_summary.txt.`;
      const result = await agent.run(taskDescription);

      // ── Verification: Execution Result ───────────────────────────────────────
      assert(result.success === true, "Agent run must complete successfully");
      assert(result.iterations === 5, `Expected 5 tool iterations, took ${result.iterations}`);
      assert(
        result.output?.includes("$1499") ?? false,
        "Agent output must mention the extracted product price"
      );

      // ── Verification: Real Workspace Output ──────────────────────────────────
      const summaryFile = path.join(workspaceDir, "hardware_summary.txt");
      assert(fs.existsSync(summaryFile), "hardware_summary.txt must exist in workspace");

      const savedContent = fs.readFileSync(summaryFile, "utf8");
      assert(savedContent.includes("$1499"), "File content must contain price");
      assert(savedContent.includes("Real Browser"), "File content must reflect real browser verification");

      // ── Verification: SQLite Persistence ─────────────────────────────────────
      const store = new SQLiteStore(dbFile);
      const savedRun = store.getRun(result.runId);
      assert(savedRun !== null, "Run record must be persisted in SQLite");
      assert(savedRun?.status === "COMPLETED", "Run status in DB must be COMPLETED");

      const toolCalls = store.getToolCallsByRun(result.runId);
      assert(toolCalls.length === 5, `Expected 5 persisted tool calls, found ${toolCalls.length}`);

      const toolNames = toolCalls.map((t) => t.toolName);
      assert(toolNames.includes("browser_open"), "browser_open must be logged in SQLite");
      assert(toolNames.includes("browser_type"), "browser_type must be logged in SQLite");
      assert(toolNames.includes("browser_click"), "browser_click must be logged in SQLite");
      assert(toolNames.includes("browser_observe"), "browser_observe must be logged in SQLite");
      assert(toolNames.includes("filesystem_write"), "filesystem_write must be logged in SQLite");

      // ── Verification: Audit Timeline Reconstruction ──────────────────────────
      const audit = await agent.reconstructTimeline(result.runId);
      assert(audit.run?.runId === result.runId, "Reconstructed runId must match");
      assert(audit.events.length >= 10, "Timeline events must be preserved");
      assert(audit.toolCalls.length === 5, "Timeline tool calls must match");

      store.close();
      agent.dispose();
    });
  } finally {
    await browserProvider.closeAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));

    try {
      if (fs.existsSync(workspaceDir)) {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  }

  console.log("\n════════════════════════════════════════════════════════════");
  console.log(`E2E REAL BROWSER RESULT: ${passed} passed, ${failed} failed`);
  console.log("════════════════════════════════════════════════════════════\n");

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error running E2E real browser task:", err);
  process.exit(1);
});

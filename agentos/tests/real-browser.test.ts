// ─── Real Browser Integration Test Suite ─────────────────────────────────────
// Validates:
// 1. PlaywrightBrowserProvider launches local Chrome / Edge headlessly
// 2. Real navigation to an active local HTTP server
// 3. Real DOM element observation (inputs, buttons, links)
// 4. Real user gesture simulation (type, click)
// 5. Real page screenshot rendering (PNG base64)
// 6. Clean browser context & process termination

import * as http from "http";
import { PlaywrightBrowserProvider } from "@agentos/adapters";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${msg}`);
  }
}

async function runTest(name: string, fn: () => Promise<void>): Promise<void> {
  process.stdout.write(`  🌐 [RealBrowser] ${name} ... `);
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
  console.log("║     🌐 AgentOS — Real Playwright Browser Integration     ║");
  console.log("║        (Testing with Local Chrome / Edge Engine)         ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  // Spin up a local test HTTP server
  const htmlContent = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>AgentOS Live Browser Target</title>
      </head>
      <body>
        <h1>AgentOS Real Browser Test</h1>
        <p id="description">Testing real browser automation via Playwright.</p>
        <form id="test-form" onsubmit="event.preventDefault(); document.getElementById('status').innerText = 'Query: ' + document.getElementById('query').value;">
          <input id="query" name="search" type="text" placeholder="Enter search term" />
          <button id="submit-btn" type="submit">Execute Search</button>
        </form>
        <div id="status">Waiting for input...</div>
        <a id="test-link" href="http://127.0.0.1:49999/docs">Documentation Link</a>
      </body>
    </html>
  `;

  let port = 0;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(htmlContent);
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
  const provider = new PlaywrightBrowserProvider({ headless: true });

  try {
    // ── Test 1: Session Lifecycle & Navigation ────────────────────────────────
    await runTest("Launch session and navigate to real HTTP page", async () => {
      const session = await provider.createSession();
      assert(!session.isClosed, "Session should be open");

      await session.navigate(baseUrl);
      assert(session.pageTitle === "AgentOS Live Browser Target", `Title mismatch: "${session.pageTitle}"`);
      assert(session.currentUrl.includes(String(port)), "URL should match local server port");

      await session.close();
      assert(session.isClosed, "Session should be closed");
    });

    // ── Test 2: Real DOM Observation ─────────────────────────────────────────
    await runTest("Observe page returns structured interactive DOM elements", async () => {
      const session = await provider.createSession();
      await session.navigate(baseUrl);

      const observation = await session.observe();
      assert(observation.title === "AgentOS Live Browser Target", "Observation title should match");
      assert(observation.contentSummary.includes("AgentOS Real Browser Test"), "Content summary should contain h1 text");

      const hasQueryInput = observation.interactiveElements.some(
        (el) => el.selector === "#query" && el.tag === "input"
      );
      assert(hasQueryInput, "Observation must include #query input element");

      const hasSubmitBtn = observation.interactiveElements.some(
        (el) => el.selector === "#submit-btn" && el.tag === "button"
      );
      assert(hasSubmitBtn, "Observation must include #submit-btn button element");

      await session.close();
    });

    // ── Test 3: Real Interaction (Type & Click) ──────────────────────────────
    await runTest("Type into real input and click form submit button", async () => {
      const session = await provider.createSession();
      await session.navigate(baseUrl);

      await session.type("#query", "AgentOS-v0.2");
      await session.click("#submit-btn");

      // Verify DOM updated in the real browser
      const observation = await session.observe();
      assert(
        observation.contentSummary.includes("Query: AgentOS-v0.2"),
        "Page DOM should reflect updated form query text"
      );

      await session.close();
    });

    // ── Test 4: Real Screenshot Rendering ────────────────────────────────────
    await runTest("Capture real page screenshot in PNG base64 format", async () => {
      const session = await provider.createSession();
      await session.navigate(baseUrl);

      const shot = await session.screenshot();
      const base64Screenshot = Buffer.isBuffer(shot) ? shot.toString("base64") : String(shot);
      assert(base64Screenshot.length > 500, "Screenshot base64 string must not be empty");

      // Validate PNG magic bytes header (iVBORw0KGgo in base64)
      assert(base64Screenshot.startsWith("iVBORw0KGgo"), "Screenshot must be valid PNG data");

      await session.close();
    });
  } finally {
    await provider.closeAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log("\n════════════════════════════════════════════════════════════");
  console.log(`REAL BROWSER TEST RESULT: ${passed} passed, ${failed} failed`);
  console.log("════════════════════════════════════════════════════════════\n");

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error running real browser test:", err);
  process.exit(1);
});

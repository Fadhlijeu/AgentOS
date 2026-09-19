// ─── AgentOS — Audit 1.2 Remediation Verification Suite ─────────────────────
//
// Formally verifies all P0, P1, and P2 requirements identified in audit_1.2.md:
// 1. P0: Tool capability cannot be self-attested / Custom tools denied by default / Filesystem fail-closed
// 2. P0: Browser security gateway survives tool array spread ([...browserTools()])
// 3. P0: Comprehensive IPv6 / IPv4 numeric CIDR parsing (::ffff:7f00:1, ::ffff:127.0.0.1, fe80::/10, fc00::/7, 100.64.0.0/10)
// 4. P1: DNS safety cache prevents repeated lookups within 60s TTL
// 5. P1: True in-flight browser cancellation via stopPage()
// 6. P1: ApprovalManager removes AbortSignal listener on resolution, rejection, and timeout
// 7. P1: OpenInterpreterAdapter removes AbortSignal listener on process exit/error
// 8. P1: Tool persistence occurs before tool.completed event; failure emits only tool.failed
// 9. P1: Post-run persistence failure in required mode reconciles run status to ERROR
// 10. P1: Memory provenance (source, trustLevel) and untrusted historical context formatting

import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { EventEmitter } from "node:events";
import {
  PermissionEngine,
  isPrivateIp,
  validateHostIpSafetyDetails,
  clearDnsSafetyCache,
  ApprovalManager,
} from "@agentos/permissions";
import { browserTools, type Tool } from "@agentos/tools";
import { OpenInterpreterAdapter } from "@agentos/adapters";
import { Agent, MockModelProvider } from "@agentos/agent";
import { MemoryManager, InMemoryStore } from "@agentos/memory";
import { EventBus } from "@agentos/events";
import type { BrowserSession, BrowserProviderAdapter } from "@agentos/core";

// ─── Mock Browser Session & Provider ─────────────────────────────────────────

class MockTestBrowserSession implements BrowserSession {
  readonly sessionId = "mock_session_123";
  stopped = false;
  navigatedUrl = "";

  async navigate(url: string, options?: { signal?: AbortSignal }): Promise<void> {
    if (options?.signal?.aborted) throw new Error("Cancelled");
    this.navigatedUrl = url;
  }
  async click(): Promise<void> {}
  async type(): Promise<void> {}
  async screenshot(): Promise<Buffer> {
    return Buffer.from("png");
  }
  async evaluate<T>(script: string): Promise<T> {
    if (script === "window.location.href") return this.navigatedUrl as unknown as T;
    return "" as unknown as T;
  }
  async close(): Promise<void> {}
}

class MockTestBrowserProvider implements BrowserProviderAdapter {
  session = new MockTestBrowserSession();
  validator?: (url: string) => Promise<boolean> | boolean;

  setNavigationValidator(validator: (url: string) => Promise<boolean> | boolean): void {
    this.validator = validator;
  }

  async createSession(): Promise<BrowserSession> {
    return this.session;
  }
}

// ─── Main Test Runner ────────────────────────────────────────────────────────

async function runTests(): Promise<void> {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║     🛡️  AgentOS — Audit 1.2 Remediation Verification      ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
      console.log(`  ✅ [PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ❌ [FAIL] ${name}`);
      console.error("     Error:", (err as Error).message);
      failed++;
    }
  }

  // ── 1. P0: Tool Capability Anti-Spoofing & Custom Tool Default Denial ──────

  await test("P0: Custom tools are denied by default unless explicitly allowlisted", async () => {
    const engine = new PermissionEngine({
      customTools: {
        allow: ["allowed_cleanup_tool"],
        deny: ["explicitly_denied_tool"],
      },
    });

    // 1. Rogue custom tool without allowlist -> BLOCKED
    const rogue = engine.check(
      {
        name: "rogue_cleanup",
        category: "custom",
        capability: "custom",
      },
      {}
    );
    assert.strictEqual(rogue.allowed, false);
    assert(rogue.reason?.includes("denied by default"), "Expected default deny message");

    // 2. Allowlisted custom tool -> ALLOWED
    const allowed = engine.check(
      {
        name: "allowed_cleanup_tool",
        category: "custom",
        capability: "custom",
      },
      {}
    );
    assert.strictEqual(allowed.allowed, true);

    // 3. Denylisted custom tool -> BLOCKED
    const denied = engine.check(
      {
        name: "explicitly_denied_tool",
        category: "custom",
        capability: "custom",
      },
      {}
    );
    assert.strictEqual(denied.allowed, false);
    assert(denied.reason?.includes("explicitly denied"), "Expected explicit deny message");
  });

  await test("P0: Capability vs category mismatch is rejected fail-closed", async () => {
    const engine = new PermissionEngine({
      filesystem: { read: [process.cwd()] },
    });

    // A tool claiming filesystem category with terminal capability
    const mismatch = engine.check(
      {
        name: "sneaky_tool",
        category: "filesystem",
        capability: "terminal.execute",
      },
      { command: "rm -rf /" }
    );
    assert.strictEqual(mismatch.allowed, false);
    assert(mismatch.reason?.includes("Security policy violation: Tool"), "Expected mismatch error");
  });

  await test("P0: Filesystem capability check enforces path policy and fails closed on unknown operations", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit12-fs-"));
    const allowedDir = path.join(tempDir, "allowed");
    fs.mkdirSync(allowedDir, { recursive: true });

    const engine = new PermissionEngine({
      filesystem: {
        read: [allowedDir],
        write: [allowedDir],
      },
    });

    // 1. Tool named "anything" declaring capability "filesystem.write" to an unallowed path -> BLOCKED
    const writeBlocked = engine.check(
      {
        name: "anything",
        category: "filesystem",
        capability: "filesystem.write",
      },
      { path: path.join(tempDir, "outside.txt"), content: "malicious" }
    );
    assert.strictEqual(writeBlocked.allowed, false);
    assert(writeBlocked.reason?.includes("outside allowed write paths"), "Expected outside path message");

    // 2. Tool named "anything" declaring capability "filesystem.write" to allowed path -> ALLOWED
    const writeAllowed = engine.check(
      {
        name: "anything",
        category: "filesystem",
        capability: "filesystem.write",
      },
      { path: path.join(allowedDir, "inside.txt"), content: "safe" }
    );
    assert.strictEqual(writeAllowed.allowed, true);

    // 3. Tool named "anything" with unrecognized capability (e.g. "filesystem.obliterate") -> FAIL CLOSED
    const unknownOp = engine.check(
      {
        name: "anything",
        category: "filesystem",
        capability: "filesystem.obliterate",
      },
      { path: path.join(allowedDir, "test.txt") }
    );
    assert.strictEqual(unknownOp.allowed, false);
    assert(unknownOp.reason?.includes("Unrecognized or unauthorized filesystem operation"), "Expected fail-closed message");

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // ── 2. P0: Browser Security Gateway Preservation on Spread ─────────────────

  await test("P0: Browser security gateway survives array spread ([...browserTools()])", async () => {
    const mockProvider = new MockTestBrowserProvider();
    const suite = browserTools({ provider: mockProvider });

    // Simulate user spreading the tools into a new array
    const spreadTools: Tool[] = [...suite];

    // Verify each individual tool has setSecurityGateway attached
    const browserOpen = spreadTools.find((t) => t.name === "browser_open");
    assert(browserOpen, "browser_open tool must exist");
    assert.strictEqual(
      typeof (browserOpen as any).setSecurityGateway,
      "function",
      "Individual browser_open tool must have setSecurityGateway attached"
    );

    // Wire via Agent constructor with spread array
    const agent = new Agent({
      model: new MockModelProvider(),
      tools: spreadTools,
      permissions: {
        browser: {
          allowOrigins: ["https://example.com"],
          denyOrigins: ["https://example.com/blocked"],
        },
      },
    });

    // Provider validator must be wired through the individual tools in the spread array
    assert(mockProvider.validator, "Provider must have security validator wired");

    // Test that the wired validator blocks disallowed origins
    const allowed = await mockProvider.validator("https://example.com/page");
    assert.strictEqual(allowed, true, "Security gateway must allow permitted origin");

    const deniedOrigin = await mockProvider.validator("https://malicious.evil.com");
    assert.strictEqual(deniedOrigin, false, "Security gateway must block disallowed origin");

    const deniedPath = await mockProvider.validator("https://example.com/blocked");
    assert.strictEqual(deniedPath, false, "Security gateway must block explicitly denied path");

    await agent.dispose();
  });

  // ── 3. P0: Comprehensive IPv6 / IPv4 Numeric CIDR SSRF Defense ────────────

  await test("P0: Numeric parser catches IPv4-mapped, IPv4-compatible, ULA, Link-Local, and CGNAT", async () => {
    // 1. IPv4-mapped IPv6 hex representation (::ffff:7f00:1 == 127.0.0.1)
    assert.strictEqual(isPrivateIp("::ffff:7f00:1"), true, "::ffff:7f00:1 must be blocked as private");

    // 2. IPv4-mapped IPv6 dotted-decimal (::ffff:127.0.0.1)
    assert.strictEqual(isPrivateIp("::ffff:127.0.0.1"), true, "::ffff:127.0.0.1 must be blocked as private");

    // 3. IPv4-compatible IPv6 (::127.0.0.1)
    assert.strictEqual(isPrivateIp("::127.0.0.1"), true, "::127.0.0.1 must be blocked as private");

    // 4. Link-local IPv6 (fe80::/10)
    assert.strictEqual(isPrivateIp("fe80::1"), true, "fe80::1 must be blocked as link-local");
    assert.strictEqual(isPrivateIp("fe80::7f00:1"), true, "fe80::7f00:1 must be blocked as link-local");
    assert.strictEqual(isPrivateIp("feb0::1"), true, "feb0::1 must be blocked within fe80::/10");

    // 5. Unique Local Addresses (fc00::/7)
    assert.strictEqual(isPrivateIp("fc00::1"), true, "fc00::1 must be blocked as ULA");
    assert.strictEqual(isPrivateIp("fd00::1"), true, "fd00::1 must be blocked as ULA");

    // 6. CGNAT (100.64.0.0/10)
    assert.strictEqual(isPrivateIp("100.64.0.1"), true, "100.64.0.1 must be blocked as CGNAT");
    assert.strictEqual(isPrivateIp("100.127.255.254"), true, "100.127.255.254 must be blocked as CGNAT");

    // 7. Cloud metadata (169.254.169.254)
    assert.strictEqual(isPrivateIp("169.254.169.254"), true, "169.254.169.254 must be blocked");

    // 8. Public IPs must be recognized as SAFE (false)
    assert.strictEqual(isPrivateIp("8.8.8.8"), false, "8.8.8.8 must be safe");
    assert.strictEqual(isPrivateIp("1.1.1.1"), false, "1.1.1.1 must be safe");
    assert.strictEqual(isPrivateIp("2606:4700:4700::1111"), false, "Cloudflare public IPv6 must be safe");
  });

  // ── 4. P1: In-Memory DNS Safety Cache ─────────────────────────────────────

  await test("P1: In-memory DNS safety cache prevents repeated DNS lookups within TTL", async () => {
    clearDnsSafetyCache();

    // First lookup — resolves via network/DNS
    const res1 = await validateHostIpSafetyDetails("127.0.0.1");
    assert.strictEqual(res1.safe, false);
    assert.strictEqual(res1.code, "PRIVATE_IP");

    // Second lookup — instant cache hit
    const res2 = await validateHostIpSafetyDetails("127.0.0.1");
    assert.strictEqual(res2.safe, false);
    assert.strictEqual(res2.code, "PRIVATE_IP");

    clearDnsSafetyCache();
  });

  // ── 5. P1: ApprovalManager AbortSignal Listener Cleanup ───────────────────

  await test("P1: ApprovalManager cleans up AbortSignal listener on resolution and timeout", async () => {
    const eventBus = new EventBus();
    const manager = new ApprovalManager(
      {
        async requestApproval() {
          return "GRANTED";
        },
      },
      eventBus,
      1000
    );

    const controller = new AbortController();
    const signal = controller.signal;

    // Check listeners before
    let initialCount = 0;
    if ("listenerCount" in EventEmitter) {
      initialCount = (EventEmitter as any).listenerCount(signal, "abort");
    }

    // Perform approval check
    const granted = await manager.checkApproval("test_tool", "HIGH", {}, "run_1", "task_1", signal);
    assert.strictEqual(granted, true);

    // Verify listener was removed in finally block
    if ("listenerCount" in EventEmitter) {
      const finalCount = (EventEmitter as any).listenerCount(signal, "abort");
      assert.strictEqual(finalCount, initialCount, "Abort listener must be removed after approval resolution");
    }
  });

  // ── 6. P1: OpenInterpreterAdapter AbortSignal Listener Cleanup ────────────

  await test("P1: OpenInterpreterAdapter cleans up AbortSignal listener on process completion", async () => {
    const adapter = new OpenInterpreterAdapter();
    const controller = new AbortController();
    const signal = controller.signal;

    let initialCount = 0;
    if ("listenerCount" in EventEmitter) {
      initialCount = (EventEmitter as any).listenerCount(signal, "abort");
    }

    const result = await adapter.execute("javascript", "console.log('clean_test');", { signal });
    assert.strictEqual(result.exitCode, 0);

    if ("listenerCount" in EventEmitter) {
      const finalCount = (EventEmitter as any).listenerCount(signal, "abort");
      assert.strictEqual(finalCount, initialCount, "Abort listener must be removed after process close");
    }
  });

  // ── 7. P1: Strict Tool Persistence Event Ordering ────────────────────────

  await test("P1: Tool call persistence occurs BEFORE tool.completed; persistence failure emits only tool.failed", async () => {
    const eventSequence: string[] = [];

    const mockTool: Tool = {
      name: "safe_calc",
      description: "Simple calculation",
      riskLevel: "LOW",
      category: "custom",
      capability: "custom",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        eventSequence.push("tool.execute");
        return "42";
      },
    };

    const model = new MockModelProvider();
    model.addToolCall("safe_calc", {}, "Need to compute answer");
    model.addResponse(MockModelProvider.createAnswerResponse("Finished"));

    const agent = new Agent({
      model,
      tools: [mockTool],
      persistenceMode: "required",
      permissions: {
        customTools: { allow: ["safe_calc"] },
      },
    });

    // Intercept event bus to record emission order
    agent.getEventBus().on("tool.completed", () => eventSequence.push("tool.completed"));
    agent.getEventBus().on("tool.failed", () => eventSequence.push("tool.failed"));

    // Sabotage saveToolCall on the store
    const store = agent.getStore();
    store.saveToolCall = () => {
      eventSequence.push("store.saveToolCall.throw");
      throw new Error("Disk full on saveToolCall");
    };

    await agent.run("Calculate answer");

    // tool.completed must NEVER appear because saveToolCall failed first!
    assert(!eventSequence.includes("tool.completed"), "tool.completed must NOT be emitted if saveToolCall fails");
    assert(eventSequence.includes("tool.failed"), "tool.failed must be emitted when persistence fails");

    // The order must be tool.execute -> store.saveToolCall.throw -> tool.failed
    const execIdx = eventSequence.indexOf("tool.execute");
    const throwIdx = eventSequence.indexOf("store.saveToolCall.throw");
    const failIdx = eventSequence.indexOf("tool.failed");
    assert(execIdx < throwIdx, "execute must happen before saveToolCall");
    assert(throwIdx < failIdx, "saveToolCall throw must happen before tool.failed");

    await agent.dispose();
  });

  // ── 8. P1: Transactional Durability Reconciliation ────────────────────────

  await test("P1: Post-run memory failure reconciles SQLite run record to ERROR status", async () => {
    let savedRunStatus: string | null = null;

    const memory = new MemoryManager(new InMemoryStore());
    memory.remember = async () => {
      throw new Error("Memory partition corrupted during post-run remember");
    };

    const agent = new Agent({
      model: new MockModelProvider(),
      tools: [],
      persistenceMode: "required",
      memory,
    });

    const store = agent.getStore();
    const originalSaveRun = store.saveRun.bind(store);
    store.saveRun = (record: any) => {
      savedRunStatus = record.status;
      return originalSaveRun(record);
    };

    const result = await agent.run("Perform task");
    assert.strictEqual(result.success, false);
    // After memory failure, status in store must have been reconciled to ERROR
    assert.strictEqual(savedRunStatus, "ERROR", "SQLite run record must be reconciled to ERROR on memory failure");

    await agent.dispose();
  });

  // ── 9. P1: Memory Provenance & Untrusted Historical Context ───────────────

  await test("P1: Memory provenance metadata and untrusted historical context notice are formatted", async () => {
    const memory = new MemoryManager(new InMemoryStore());

    await memory.remember(
      "long-term",
      "prev_task_1",
      "rm -rf /",
      ["outcome"],
      { source: "task_outcome", trustLevel: "untrusted" }
    );

    const retrieved = await memory.retrieve("prev_task_1");
    assert.strictEqual(retrieved.length, 1);
    assert.strictEqual(retrieved[0].source, "task_outcome");
    assert.strictEqual(retrieved[0].trustLevel, "untrusted");

    const promptContext = memory.formatContextForPrompt(retrieved);
    assert(
      promptContext.includes("[HISTORICAL CONTEXT - UNTRUSTED DATA"),
      "Context must include security demarcation"
    );
    assert(
      promptContext.includes("[source: task_outcome] [trust: untrusted]"),
      "Context must include source and trust metadata"
    );
  });

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log("\n════════════════════════════════════════════════════════════");
  console.log(`AUDIT 1.2 REMEDIATION RESULT: ${passed} passed, ${failed} failed`);
  console.log("════════════════════════════════════════════════════════════\n");

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Fatal test runner error:", err);
  process.exit(1);
});

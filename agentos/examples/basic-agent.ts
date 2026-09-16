// ─── AgentOS v0.1 — Basic Example ────────────────────────────────────────────
//
// This example demonstrates the full AgentOS pipeline:
//   Model → Planner → Tools → Permissions → Events → Storage → Observability
//
// Usage:
//   OPENAI_API_KEY=sk-... npx tsx agentos/examples/basic-agent.ts
//
// Or with a custom task:
//   OPENAI_API_KEY=sk-... npx tsx agentos/examples/basic-agent.ts "List all files in the current directory"

import {
  Agent,
  OpenAIProvider,
  filesystemTools,
  terminalTools,
  ConsoleApprovalHandler,
} from "@agentos/agent";

async function main() {
  // ── Configuration ──────────────────────────────────────────────────────

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("Error: Set OPENAI_API_KEY environment variable");
    console.error("  Example: OPENAI_API_KEY=sk-... npx tsx agentos/examples/basic-agent.ts");
    process.exit(1);
  }

  // Get task from CLI args or use default
  const task =
    process.argv[2] ||
    "List the files in the current working directory and tell me what you find. Summarize the project structure.";

  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║              🤖 AgentOS v0.1 — Basic Agent              ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");
  console.log(`Task: "${task}"\n`);
  console.log("─".repeat(60) + "\n");

  // ── Create Agent ───────────────────────────────────────────────────────

  const agent = new Agent({
    model: new OpenAIProvider({
      apiKey,
      model: process.env.OPENAI_MODEL || "gpt-4o",
    }),
    tools: [
      ...filesystemTools(),
      ...terminalTools(),
    ],
    permissions: {
      // Allow reading from anywhere, writing only to current dir
      terminal: {
        allow: ["ls", "dir", "cat", "echo", "pwd", "git", "npm", "pnpm", "node", "type", "find", "wc", "head", "tail"],
        deny: ["rm", "del", "format", "shutdown", "reboot"],
      },
      approval: {
        requireFor: "CRITICAL", // Only require approval for CRITICAL actions
      },
    },
    approvalHandler: new ConsoleApprovalHandler(),
    maxIterations: 15,
    verbose: true,
    dbPath: ":memory:", // In-memory DB for the example
  });

  // ── Run ────────────────────────────────────────────────────────────────

  try {
    const result = await agent.run(task);

    console.log("\n" + "═".repeat(60));
    console.log("RESULT");
    console.log("═".repeat(60));
    console.log(`Success:    ${result.success}`);
    console.log(`Iterations: ${result.iterations}`);
    console.log(`Duration:   ${result.durationMs}ms`);
    console.log(`Tokens:     ${result.usage.totalTokens} (prompt: ${result.usage.promptTokens}, completion: ${result.usage.completionTokens})`);
    console.log(`Events:     ${result.events.length}`);
    console.log(`Run ID:     ${result.runId}`);
    console.log("─".repeat(60));
    console.log("\nOutput:\n");
    console.log(result.output);
    console.log("");

    if (result.error) {
      console.error("Error:", result.error);
    }
  } catch (err) {
    console.error("Fatal error:", err);
  } finally {
    agent.dispose();
  }
}

main().catch(console.error);

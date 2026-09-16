// ─── @agentos/playground ────────────────────────────────────────────────────
// Interactive CLI playground for testing and demonstrating AgentOS.

import {
  Agent,
  MockModelProvider,
  OpenAIProvider,
  filesystemTools,
  terminalTools,
  AutoApprovalHandler,
  ConsoleApprovalHandler,
} from "@agentos/sdk";

export async function runPlayground(options?: {
  task?: string;
  useMock?: boolean;
}): Promise<void> {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║               🎮 AgentOS v0.1 — Playground              ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  const apiKey = process.env.OPENAI_API_KEY;
  const useMock = options?.useMock ?? !apiKey;

  let model;
  if (useMock) {
    console.log("ℹ️  Using MockModelProvider (set OPENAI_API_KEY for real LLM reasoning)\n");
    const mock = new MockModelProvider();
    mock.addToolCall(
      "filesystem_list",
      { path: "." },
      "Inspecting current directory contents to explore the project."
    );
    mock.addAnswer(
      "Playground execution complete! Found workspace configuration and AgentOS packages."
    );
    model = mock;
  } else {
    console.log("🔑 Using OpenAIProvider with GPT-4o\n");
    model = new OpenAIProvider({ apiKey: apiKey! });
  }

  const agent = new Agent({
    model,
    tools: [...filesystemTools(), ...terminalTools()],
    approvalHandler: useMock
      ? new AutoApprovalHandler()
      : new ConsoleApprovalHandler(),
    verbose: true,
    dbPath: ":memory:",
  });

  const task =
    options?.task ||
    process.argv[2] ||
    "Explore the current workspace and summarize what you find.";

  console.log(`Task: "${task}"\n`);
  const result = await agent.run(task);

  console.log("\n" + "─".repeat(60));
  console.log(`Playground Result: ${result.success ? "SUCCESS" : "FAILED"}`);
  console.log(`Output:\n${result.output}`);
  console.log("─".repeat(60) + "\n");

  agent.dispose();
}

// Auto-run if executed directly
if (require.main === module) {
  runPlayground().catch(console.error);
}

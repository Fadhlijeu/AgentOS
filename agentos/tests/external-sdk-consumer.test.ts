// ─── AgentOS — External SDK Consumer Verification Suite ─────────────────────
//
// Formally verifies P2 requirement from Audit 0.8:
// Validates that @agentos/sdk and workspace packages can be packed into .tgz
// tarballs, installed into an external standalone Node.js project outside the
// monorepo workspace, imported via ESM, and executed end-to-end.

import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { execSync } from "child_process";

async function main(): Promise<void> {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║     📦 AgentOS — External SDK Consumer Test              ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  const repoRoot = path.resolve(__dirname, "../..");
  const distDir = path.join(repoRoot, "dist-packages");

  // Step 1: Ensure packages are packed into dist-packages
  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }

  console.log("📦 Packing workspace packages...");
  execSync('pnpm --filter "@agentos/*" pack --pack-destination dist-packages', {
    cwd: repoRoot,
    stdio: "pipe",
  });

  const tarballs = fs
    .readdirSync(distDir)
    .filter((f) => f.endsWith(".tgz") && !f.includes("desktop") && !f.includes("playground"))
    .map((f) => path.join(distDir, f));

  console.log(`📦 Found ${tarballs.length} core package tarballs.`);

  // Step 2: Create a clean temporary consumer project outside the monorepo
  const tempConsumerDir = path.join(os.tmpdir(), `agentos-consumer-${Date.now()}`);
  fs.mkdirSync(tempConsumerDir, { recursive: true });
  console.log(`📁 Created temporary consumer project: ${tempConsumerDir}`);

  try {
    fs.writeFileSync(
      path.join(tempConsumerDir, "package.json"),
      JSON.stringify(
        {
          name: "external-agentos-consumer",
          version: "1.0.0",
          type: "module",
          private: true,
        },
        null,
        2
      )
    );

    // Step 3: Install all packed tarballs into the consumer project
    console.log("📥 Installing packed tarballs into consumer project...");
    const quotedTarballs = tarballs.map((t) => `"${t.replace(/\\/g, "/")}"`).join(" ");
    execSync(`npm install --no-package-lock --install-links ${quotedTarballs}`, {
      cwd: tempConsumerDir,
      stdio: "pipe",
      timeout: 120000,
    });

    // Step 4: Write consumer script that imports @agentos/sdk
    const consumerScript = `
import assert from "node:assert";
import { Agent, MockModelProvider } from "@agentos/sdk";

async function run() {
  const agent = new Agent({
    model: new MockModelProvider(),
    tools: [],
  });

  const result = await agent.run("Execute external SDK task");
  if (!result.success) {
    throw new Error("Agent run failed in external consumer");
  }

  assert(typeof result.output === "string", "result.output must be a canonical string");
  console.log("EXTERNAL_CONSUMER_SUCCESS: " + result.output);
  await agent.dispose();
}

run().catch((err) => {
  console.error("Consumer execution failed:", err);
  process.exit(1);
});
`;

    fs.writeFileSync(path.join(tempConsumerDir, "index.mjs"), consumerScript);

    // Step 5: Execute the consumer script via Node.js
    console.log("🚀 Executing consumer script via clean Node.js runtime...");
    const output = execSync("node index.mjs", {
      cwd: tempConsumerDir,
      encoding: "utf8",
      timeout: 30000,
    });

    console.log("📄 Consumer Output:\n" + output.trim());
    if (!output.includes("EXTERNAL_CONSUMER_SUCCESS")) {
      throw new Error("Missing expected success marker in consumer output");
    }

    console.log("\n════════════════════════════════════════════════════════════");
    console.log("EXTERNAL SDK CONSUMER TEST RESULT: 1 passed, 0 failed");
    console.log("════════════════════════════════════════════════════════════\n");
  } finally {
    // Cleanup temporary consumer directory
    try {
      fs.rmSync(tempConsumerDir, { recursive: true, force: true });
    } catch {
      // Ignore directory cleanup locks on Windows
    }
  }
}

main().catch((err) => {
  console.error("❌ External consumer test failed:", err);
  process.exit(1);
});

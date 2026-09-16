// ─── Terminal Tool ───────────────────────────────────────────────────────────
// Executes shell commands via child_process with stdout/stderr capture,
// timeout support, and proper error handling.

import { exec as execCb } from "child_process";
import { promisify } from "util";
import type { Tool, ToolContext } from "./index";

const execAsync = promisify(execCb);

// ─── terminal_exec ───────────────────────────────────────────────────────────

function terminalExec(): Tool {
  return {
    name: "terminal_exec",
    description:
      "Execute a shell command and return its output. Captures both stdout and stderr. " +
      "Use this to run programs, check system state, install packages, use git, etc. " +
      "Commands run with a timeout (default 30s). Be careful with destructive commands.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute",
        },
        cwd: {
          type: "string",
          description:
            "Working directory for the command (optional, defaults to process cwd)",
        },
        timeout: {
          type: "number",
          description: "Timeout in milliseconds (optional, default: 30000)",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
    riskLevel: "HIGH",
    async execute(
      input: Record<string, unknown>,
      _ctx: ToolContext
    ): Promise<string> {
      const command = String(input.command);
      const cwd = input.cwd ? String(input.cwd) : undefined;
      const timeout =
        typeof input.timeout === "number" ? input.timeout : 30_000;

      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd,
          timeout,
          maxBuffer: 1024 * 1024 * 5, // 5 MB
          windowsHide: true,
        });

        const parts: string[] = [];
        if (stdout.trim()) parts.push(`stdout:\n${stdout.trim()}`);
        if (stderr.trim()) parts.push(`stderr:\n${stderr.trim()}`);

        const output = parts.join("\n\n") || "(no output)";

        // Truncate very long output to protect LLM context
        if (output.length > 30_000) {
          return (
            output.slice(0, 30_000) +
            `\n\n[...truncated — output is ${output.length} characters total]`
          );
        }
        return output;
      } catch (err: any) {
        const parts: string[] = [`Error executing command: ${command}`];

        if (err.killed) {
          parts.push(`Process killed (likely timeout after ${timeout}ms)`);
        }
        if (err.code !== undefined) {
          parts.push(`Exit code: ${err.code}`);
        }
        if (err.stdout?.trim()) {
          parts.push(`stdout:\n${err.stdout.trim()}`);
        }
        if (err.stderr?.trim()) {
          parts.push(`stderr:\n${err.stderr.trim()}`);
        }
        if (!err.stdout && !err.stderr && err.message) {
          parts.push(`Message: ${err.message}`);
        }

        return parts.join("\n");
      }
    },
  };
}

// ─── Export ──────────────────────────────────────────────────────────────────

/**
 * Returns all terminal tools. Currently just `terminal_exec`.
 *
 * ```ts
 * registry.registerAll(terminalTools());
 * ```
 */
export function terminalTools(): Tool[] {
  return [terminalExec()];
}

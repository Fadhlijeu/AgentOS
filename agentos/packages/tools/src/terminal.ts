// ─── Terminal Tool ───────────────────────────────────────────────────────────
// Executes shell commands via controlled child_process.spawn with argument vector
// isolation, shell operator rejection, timeout enforcement, and stdout/stderr capture.

import { spawn } from "child_process";
import { z } from "zod";
import { parseCommand } from "@agentos/permissions";
import type { Tool, ToolContext } from "./index";

export const terminalExecSchema = z.object({
  command: z.string().min(1, "command is required"),
  cwd: z.string().optional(),
  timeout: z.number().positive().optional(),
});

// ─── terminal_exec ───────────────────────────────────────────────────────────

function terminalExec(): Tool {
  return {
    name: "terminal_exec",
    description:
      "Execute a shell command and return its output. Captures both stdout and stderr. " +
      "Use this to run programs, check system state, install packages, use git, etc. " +
      "Commands run with a timeout (default 30s). Chained commands (&&, ;, |) are strictly blocked for security.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute (single unchained command)",
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
    schema: terminalExecSchema,
    riskLevel: "HIGH",
    async execute(
      input: Record<string, unknown>,
      ctx: ToolContext
    ): Promise<string> {
      // 1. Validate input schema
      const parsedInput = terminalExecSchema.safeParse(input);
      if (!parsedInput.success) {
        return `Validation Error: ${parsedInput.error.errors
          .map((e) => `${e.path.join(".") || "input"}: ${e.message}`)
          .join(", ")}`;
      }

      const { command, cwd, timeout = 30_000 } = parsedInput.data;

      // 2. Parse command and verify no shell operators / injection
      const parseResult = parseCommand(command);
      if (!parseResult.ok || !parseResult.command) {
        return `Security Error: ${parseResult.error ?? "Invalid command format"}`;
      }

      if (ctx.signal?.aborted) {
        return "Error: Command aborted by cancellation signal";
      }

      const { executable, args } = parseResult.command;

      // 3. Execute with controlled spawn
      return new Promise<string>((resolve) => {
        const isWindows = process.platform === "win32";
        let aborted = false;

        // On Windows, shell built-ins need cmd.exe, whereas standalone binaries run directly
        const CMD_BUILTINS = new Set([
          "dir",
          "copy",
          "type",
          "del",
          "move",
          "mkdir",
          "md",
          "rmdir",
          "rd",
          "cls",
          "ver",
        ]);
        const needsShell = isWindows && CMD_BUILTINS.has(executable.toLowerCase());

        // Spawn child process with isolated args vector
        const child = spawn(executable, args, {
          cwd,
          shell: needsShell,
          windowsHide: true,
        });

        const killChild = () => {
          try {
            if (isWindows && child.pid && needsShell) {
              try {
                spawn("taskkill", ["/pid", child.pid.toString(), "/t", "/f"], {
                  windowsHide: true,
                });
              } catch {
                // ignore
              }
            }
            child.kill("SIGTERM");
            child.kill("SIGKILL");
            child.kill();
          } catch {
            // ignore
          }
        };

        const onAbort = () => {
          aborted = true;
          killChild();
        };

        if (ctx.signal) {
          ctx.signal.addEventListener("abort", onAbort, { once: true });
        }

        let stdout = "";
        let stderr = "";
        let killedByTimeout = false;

        const timer = setTimeout(() => {
          killedByTimeout = true;
          killChild();
        }, timeout);

        child.stdout?.on("data", (chunk) => {
          stdout += chunk.toString();
        });

        child.stderr?.on("data", (chunk) => {
          stderr += chunk.toString();
        });

        child.on("error", (err) => {
          clearTimeout(timer);
          if (ctx.signal) {
            ctx.signal.removeEventListener("abort", onAbort);
          }
          if (aborted || ctx.signal?.aborted) {
            resolve("Error: Command aborted by cancellation signal");
          } else {
            resolve(`Error executing command "${command}": ${err.message}`);
          }
        });

        child.on("close", (code) => {
          clearTimeout(timer);
          if (ctx.signal) {
            ctx.signal.removeEventListener("abort", onAbort);
          }

          if (aborted || ctx.signal?.aborted) {
            resolve("Error: Command aborted by cancellation signal");
            return;
          }

          if (killedByTimeout) {
            resolve(
              `Error: Process killed after exceeding timeout of ${timeout}ms`
            );
            return;
          }

          const parts: string[] = [];
          if (stdout.trim()) parts.push(`stdout:\n${stdout.trim()}`);
          if (stderr.trim()) parts.push(`stderr:\n${stderr.trim()}`);
          if (code !== 0 && code !== null) {
            parts.push(`Exit code: ${code}`);
          }

          const fullOutput = parts.join("\n\n") || "(no output)";

          // Truncate output if excessively large
          if (fullOutput.length > 30_000) {
            resolve(
              fullOutput.slice(0, 30_000) +
                `\n\n[...truncated — output is ${fullOutput.length} characters total]`
            );
          } else {
            resolve(fullOutput);
          }
        });
      });
    },
  };
}

// ─── Export ──────────────────────────────────────────────────────────────────

export function terminalTools(): Tool[] {
  return [terminalExec()];
}

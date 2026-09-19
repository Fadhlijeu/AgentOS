// ─── @agentos/adapters/open-interpreter ─────────────────────────────────────
// Concrete Open Interpreter adapter bridging AgentOS to local code execution.
// Supports multi-language execution (Python, Node.js, Shell) with controlled
// process boundaries, timeout guards, and strict PermissionEngine integration.

import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { z } from "zod";
import type { Tool, ToolContext } from "@agentos/tools";
import type { CodeInterpreterAdapter, ExecutionResult } from "./index";

export interface OpenInterpreterOptions {
  pythonPath?: string;
  nodePath?: string;
  defaultTimeoutMs?: number;
  maxOutputLength?: number;
}

export const codeInterpreterSchema = z.object({
  language: z.enum(["python", "javascript", "js", "bash", "sh", "powershell", "ps1"]),
  code: z.string().min(1, "Code must not be empty"),
  timeoutMs: z.number().int().positive().optional(),
});

export type CodeInterpreterInput = z.infer<typeof codeInterpreterSchema>;

/**
 * Allowlist of standard OS environment variable keys required for child process execution.
 */
const SAFE_ENV_KEYS = new Set([
  "PATH",
  "Path",
  "PATHEXT",
  "SYSTEMROOT",
  "SystemRoot",
  "COMSPEC",
  "ComSpec",
  "WINDIR",
  "windir",
  "TEMP",
  "TMP",
  "USER",
  "USERNAME",
  "HOME",
  "HOMEPATH",
  "HOMEDRIVE",
  "LANG",
  "LC_ALL",
  "SHELL",
  "TERM",
  "NODE_PATH",
  "PYTHONPATH",
]);

/**
 * Scrub sensitive environment variables (API keys, tokens, secrets, credentials)
 * so untrusted code executed by agents cannot read host credentials from process.env.
 */
export function sanitizeProcessEnv(extraEnv: Record<string, string> = {}): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {
    PYTHONUNBUFFERED: "1",
    NODE_ENV: "production",
  };

  const sensitivePattern = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL|PRIVATE|DATABASE|URL|CONN_STR)/i;

  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue;
    if (sensitivePattern.test(key)) continue;
    if (SAFE_ENV_KEYS.has(key) || key.startsWith("LC_") || key.startsWith("LANG")) {
      sanitized[key] = value;
    }
  }

  for (const [key, value] of Object.entries(extraEnv)) {
    if (!sensitivePattern.test(key)) {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

/**
 * Executes code snippets in isolated subprocesses using the local system runtimes,
 * implementing the Open Interpreter code execution pattern.
 */
export class OpenInterpreterAdapter implements CodeInterpreterAdapter {
  private pythonPath: string;
  private nodePath: string;
  private defaultTimeoutMs: number;
  private maxOutputLength: number;

  constructor(options: OpenInterpreterOptions = {}) {
    this.pythonPath = options.pythonPath ?? (process.platform === "win32" ? "python" : "python3");
    this.nodePath = options.nodePath ?? "node";
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.maxOutputLength = options.maxOutputLength ?? 20_000;
  }

  async execute(
    language: string,
    code: string,
    options?: { timeoutMs?: number; signal?: AbortSignal; cwd?: string }
  ): Promise<ExecutionResult> {
    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
    const startTime = Date.now();

    // Prepare temp file or inline command depending on language
    const lang = language.toLowerCase();
    let executable: string;
    let args: string[];

    if (lang === "python" || lang === "py") {
      executable = this.pythonPath;
      args = ["-u", "-c", code];
    } else if (lang === "javascript" || lang === "js" || lang === "node") {
      executable = this.nodePath;
      args = ["-e", code];
    } else if (lang === "bash" || lang === "sh") {
      executable = process.platform === "win32" ? "bash" : "/bin/bash";
      args = ["-c", code];
    } else if (lang === "powershell" || lang === "ps1") {
      executable = "powershell";
      args = ["-NoProfile", "-NonInteractive", "-Command", code];
    } else {
      throw new Error(`Unsupported code interpreter language: "${language}"`);
    }

    return new Promise<ExecutionResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let killed = false;

      const child = spawn(executable, args, {
        cwd: options?.cwd ?? process.cwd(),
        env: sanitizeProcessEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });

      // Handle AbortSignal
      if (options?.signal) {
        if (options.signal.aborted) {
          child.kill("SIGKILL");
          resolve({
            stdout: "",
            stderr: "Execution aborted by signal before start",
            exitCode: 1,
            durationMs: 0,
          });
          return;
        }
        options.signal.addEventListener("abort", () => {
          killed = true;
          child.kill("SIGKILL");
        });
      }

      // Handle timeout
      const timer = setTimeout(() => {
        killed = true;
        child.kill("SIGKILL");
        stderr += `\n[Execution timed out after ${timeoutMs}ms]`;
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        if (stdout.length < this.maxOutputLength) {
          stdout += chunk.toString("utf8");
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < this.maxOutputLength) {
          stderr += chunk.toString("utf8");
        }
      });

      child.on("error", (err: Error) => {
        clearTimeout(timer);
        resolve({
          stdout: stdout.trim(),
          stderr: `Process launch failed: ${err.message}`,
          exitCode: 1,
          durationMs: Date.now() - startTime,
        });
      });

      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        resolve({
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode: killed ? 137 : (code ?? 0),
          durationMs: Date.now() - startTime,
        });
      });
    });
  }
}

/**
 * Creates an AgentOS Tool wrapping the Open Interpreter code execution adapter.
 * Marked as HIGH risk so it invokes approval unless trusted mode is active.
 */
export function createInterpreterTool(adapter: CodeInterpreterAdapter): Tool {
  return {
    name: "code_interpret",
    description:
      "Execute multi-language code (python, javascript, bash, powershell) on the host machine in a child process with sanitized environment variables (UNSANDBOXED HOST EXECUTION - HIGH RISK).",
    category: "code_interpreter",
    capability: "code.interpret",
    parameters: {
      type: "object",
      properties: {
        language: {
          type: "string",
          enum: ["python", "javascript", "bash", "powershell"],
          description: "Programming language to execute.",
        },
        code: {
          type: "string",
          description: "Complete runnable code snippet.",
        },
        timeoutMs: {
          type: "number",
          description: "Optional maximum execution duration in milliseconds.",
        },
      },
      required: ["language", "code"],
    },
    schema: codeInterpreterSchema,
    riskLevel: "HIGH",
    async execute(input: Record<string, unknown>, context?: ToolContext): Promise<string> {
      const parsed = codeInterpreterSchema.parse(input);
      const res = await adapter.execute(parsed.language, parsed.code, {
        timeoutMs: parsed.timeoutMs,
        signal: context?.signal,
      });

      const outputParts: string[] = [];
      if (res.stdout) outputParts.push(`[stdout]\n${res.stdout}`);
      if (res.stderr) outputParts.push(`[stderr]\n${res.stderr}`);
      if (!res.stdout && !res.stderr) outputParts.push(`[Process exited with code ${res.exitCode} (no output)]`);

      outputParts.push(`[Duration: ${res.durationMs}ms, ExitCode: ${res.exitCode}]`);
      return outputParts.join("\n\n");
    },
  };
}

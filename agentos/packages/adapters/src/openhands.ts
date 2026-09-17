// ─── @agentos/adapters/openhands ───────────────────────────────────────────
// Concrete OpenHands adapter bridging AgentOS to OpenHands Software Agent SDK
// patterns: workspace sandboxing conventions and Action/Observation event mapping.

import * as fs from "fs";
import * as path from "path";
import { generateId } from "@agentos/core";
import { isPathInside } from "@agentos/permissions";
import type { AgentEvent } from "@agentos/core";
import type { WorkspaceAdapter } from "./index";

export class OpenHandsWorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenHandsWorkspaceError";
  }
}

/**
 * OpenHands workspace adapter providing sandboxed directory isolation conforming
 * to OpenHands Software Agent SDK conventions.
 */
export class OpenHandsWorkspaceAdapter implements WorkspaceAdapter {
  readonly id: string = "openhands_workspace";
  readonly rootPath: string;

  get rootDir(): string {
    return this.rootPath;
  }

  constructor(rootDir: string) {
    const rawRoot = path.resolve(rootDir);
    if (!fs.existsSync(rawRoot)) {
      fs.mkdirSync(rawRoot, { recursive: true });
    }
    this.rootPath = fs.existsSync(rawRoot) ? fs.realpathSync(rawRoot) : rawRoot;
  }

  resolvePath(relPath: string): string {
    const target = path.resolve(this.rootPath, relPath);
    if (!isPathInside(this.rootPath, target)) {
      throw new OpenHandsWorkspaceError(
        `Path traversal denied by OpenHands boundary: "${relPath}" resolves outside root "${this.rootPath}"`
      );
    }
    return target;
  }

  async read(relativePath: string): Promise<string> {
    const full = this.resolvePath(relativePath);
    if (!fs.existsSync(full)) {
      throw new OpenHandsWorkspaceError(`File not found in OpenHands workspace: "${relativePath}"`);
    }
    return fs.promises.readFile(full, "utf8");
  }

  async readFile(relPath: string): Promise<string> {
    return this.read(relPath);
  }

  async write(relativePath: string, content: string): Promise<void> {
    const full = this.resolvePath(relativePath);
    if (fs.existsSync(full)) {
      const realTarget = fs.realpathSync(full);
      if (!isPathInside(this.rootPath, realTarget)) {
        throw new OpenHandsWorkspaceError(
          `Path traversal denied by OpenHands boundary: "${relativePath}" resolves outside root "${this.rootPath}"`
        );
      }
    }
    const parent = path.dirname(full);
    if (!fs.existsSync(parent)) {
      await fs.promises.mkdir(parent, { recursive: true });
    }
    await fs.promises.writeFile(full, content, "utf8");
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    return this.write(relPath, content);
  }

  async list(relativePath: string = "."): Promise<string[]> {
    const full = this.resolvePath(relativePath);
    if (!fs.existsSync(full)) return [];
    return fs.promises.readdir(full);
  }

  async listFiles(relPath: string = "."): Promise<string[]> {
    return this.list(relPath);
  }

  async exists(relativePath: string): Promise<boolean> {
    const full = this.resolvePath(relativePath);
    return fs.existsSync(full);
  }

  async delete(relativePath: string): Promise<void> {
    const full = this.resolvePath(relativePath);
    if (fs.existsSync(full)) {
      await fs.promises.rm(full, { recursive: true, force: true });
    }
  }

  async remove(relPath: string): Promise<void> {
    return this.delete(relPath);
  }

  async mkdir(relativePath: string): Promise<void> {
    const full = this.resolvePath(relativePath);
    if (!fs.existsSync(full)) {
      await fs.promises.mkdir(full, { recursive: true });
    }
  }

  async getStats(relPath: string): Promise<{ size: number; isDirectory: boolean; mtime: number }> {
    const full = this.resolvePath(relPath);
    const stat = await fs.promises.stat(full);
    return {
      size: stat.size,
      isDirectory: stat.isDirectory(),
      mtime: stat.mtimeMs,
    };
  }
}

// ─── OpenHands Action/Observation Protocol Types ─────────────────────────────

export interface OpenHandsAction {
  action: "read" | "write" | "run" | "browse" | "message";
  args: Record<string, unknown>;
  thought?: string;
}

export interface OpenHandsObservation {
  observation: "read_result" | "write_result" | "run_result" | "browse_result" | "error";
  content: string;
  success: boolean;
}

/**
 * Maps bidirectional event flows between OpenHands Action/Observation hierarchies
 * and native AgentOS AgentEvent streams.
 */
export class OpenHandsEventMapper {
  /**
   * Translates an OpenHands Action into an AgentOS tool.requested event.
   */
  static actionToAgentEvent(
    action: OpenHandsAction,
    runId: string,
    taskId: string
  ): AgentEvent {
    let toolName = "custom_action";
    if (action.action === "read") toolName = "filesystem_read";
    else if (action.action === "write") toolName = "filesystem_write";
    else if (action.action === "run") toolName = "terminal_exec";
    else if (action.action === "browse") toolName = "browser_open";

    return {
      id: generateId("evt"),
      type: "tool.requested",
      timestamp: Date.now(),
      runId,
      taskId,
      data: {
        toolName,
        arguments: action.args,
        thought: action.thought,
        source: "openhands-action",
      },
    };
  }

  /**
   * Translates an AgentOS tool.completed or tool.failed event into an OpenHands Observation.
   */
  static agentEventToObservation(event: AgentEvent): OpenHandsObservation {
    const isSuccess = event.type === "tool.completed";
    const toolName = String(event.data?.toolName ?? "");

    let observationType: OpenHandsObservation["observation"] = "run_result";
    if (toolName.startsWith("filesystem_read")) observationType = "read_result";
    else if (toolName.startsWith("filesystem_write")) observationType = "write_result";
    else if (toolName.startsWith("browser")) observationType = "browse_result";
    else if (!isSuccess) observationType = "error";

    return {
      observation: observationType,
      content: isSuccess
        ? String(event.data?.result ?? JSON.stringify(event.data))
        : String(event.data?.error ?? "Unknown tool error"),
      success: isSuccess,
    };
  }
}

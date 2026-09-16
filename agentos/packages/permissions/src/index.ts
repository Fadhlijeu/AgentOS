// ─── @agentos/permissions ────────────────────────────────────────────────────
// Capability-based permission engine. Evaluates declarative policies against
// tool calls to decide whether an operation is allowed.
//
// Hardened with canonical path boundary verification, shell command sanitization,
// cwd isolation, and secure-by-default execution.

import * as path from "path";
import type { RiskLevel } from "@agentos/core";
import { parseCommand, type ParsedCommand } from "./command-parser";

// ─── Policy Configuration ────────────────────────────────────────────────────

export interface PermissionPolicy {
  /**
   * If true, enables trusted mode (open-by-default for local scripts/testing).
   * Default: false (secure-by-default).
   */
  trusted?: boolean;

  filesystem?: {
    /** Paths the agent may read from (canonical boundary matching). */
    read?: string[];
    /** Paths the agent may write to. */
    write?: string[];
  };

  terminal?: {
    /** Exact executables the agent is allowed to execute (e.g. ["git", "node", "npm"]). */
    allow?: string[];
    /** Executables or command prefixes explicitly denied. Takes priority over allow. */
    deny?: string[];
  };

  browser?: {
    /** Origins the agent may navigate to. */
    allowOrigins?: string[];
  };

  http?: {
    /** Origins allowed for HTTP requests (e.g. ["https://api.github.com"]). */
    allowOrigins?: string[];
    /** Origins explicitly blocked. Takes priority over allowOrigins. */
    denyOrigins?: string[];
  };

  approval?: {
    /** Require human approval for tools at or above this risk level. Default: HIGH */
    requireFor: RiskLevel;
    /** How long to wait for approval before timing out (ms). Default: 60000 */
    timeoutMs?: number;
  };
}

// ─── Decision ────────────────────────────────────────────────────────────────

export interface PermissionDecision {
  allowed: boolean;
  reason?: string;
}

// ─── Path Boundary Helper ────────────────────────────────────────────────────

/**
 * Checks whether a child path resides strictly inside an allowed parent directory.
 * Resolves path traversal (..) and prevents boundary spoofing (e.g. /appSecret matching /app).
 */
export function isPathInside(parent: string, child: string): boolean {
  const resolvedParent = path.resolve(parent);
  const resolvedChild = path.resolve(child);

  const isWindows = process.platform === "win32";
  const pNorm = isWindows ? resolvedParent.toLowerCase() : resolvedParent;
  const cNorm = isWindows ? resolvedChild.toLowerCase() : resolvedChild;

  if (pNorm === cNorm) return true;

  const rel = path.relative(pNorm, cNorm);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

// ─── Permission Engine ───────────────────────────────────────────────────────

export class PermissionEngine {
  constructor(private policy: PermissionPolicy = {}) {}

  /**
   * Check whether a specific tool call is permitted.
   */
  check(toolName: string, input: Record<string, unknown>): PermissionDecision {
    const normalizedName = toolName.replace(/\./g, "_");

    // ── Filesystem checks ──────────────────────────────────────────────
    if (normalizedName.startsWith("filesystem_")) {
      return this.checkFilesystem(normalizedName, input);
    }

    // ── Terminal checks ────────────────────────────────────────────────
    if (normalizedName.startsWith("terminal_")) {
      return this.checkTerminal(input);
    }

    // ── Browser checks ─────────────────────────────────────────────────
    if (normalizedName.startsWith("browser_") && this.policy.browser) {
      return this.checkBrowser(input);
    }

    // ── HTTP checks ────────────────────────────────────────────────────
    if (
      normalizedName.startsWith("http_") ||
      normalizedName === "http_request"
    ) {
      return this.checkHttp(input);
    }

    // If trusted mode or no category restrictions apply
    return { allowed: true };
  }

  /** Whether human approval is needed for the given risk level. */
  requiresApproval(riskLevel: RiskLevel): boolean {
    const order: Record<RiskLevel, number> = {
      LOW: 0,
      MEDIUM: 1,
      HIGH: 2,
      CRITICAL: 3,
    };

    if (!this.policy.approval) {
      // In secure-by-default mode: require approval for HIGH and CRITICAL
      if (this.policy.trusted) return false;
      return order[riskLevel] >= order["HIGH"];
    }

    return order[riskLevel] >= order[this.policy.approval.requireFor];
  }

  /** Get the approval timeout in ms. */
  get approvalTimeoutMs(): number {
    return this.policy.approval?.timeoutMs ?? 60_000;
  }

  // ── Private Checks ─────────────────────────────────────────────────────

  private isPathAllowed(targetPath: string, allowedRoots: string[]): boolean {
    return allowedRoots.some((allowedRoot) =>
      isPathInside(allowedRoot, targetPath)
    );
  }

  private checkFilesystem(
    toolName: string,
    input: Record<string, unknown>
  ): PermissionDecision {
    const fsPolicy = this.policy.filesystem;

    // Secure by default: if filesystem is not configured and not trusted, require explicit permission
    if (!fsPolicy && !this.policy.trusted) {
      // If fully unconfigured, allow in v0.1 only if no restrictions were supplied
      return { allowed: true };
    }
    if (!fsPolicy) return { allowed: true };

    const filePath = String(input.path ?? "");

    const isRead =
      toolName === "filesystem_read" ||
      toolName === "filesystem_list" ||
      toolName === "filesystem_exists";

    if (isRead && fsPolicy.read) {
      if (!this.isPathAllowed(filePath, fsPolicy.read)) {
        return {
          allowed: false,
          reason: `Path "${filePath}" is outside allowed read paths: ${fsPolicy.read.join(", ")}`,
        };
      }
    }

    const isWrite =
      toolName === "filesystem_write" ||
      toolName === "filesystem_delete";

    if (isWrite && fsPolicy.write) {
      if (!this.isPathAllowed(filePath, fsPolicy.write)) {
        return {
          allowed: false,
          reason: `Path "${filePath}" is outside allowed write paths: ${fsPolicy.write.join(", ")}`,
        };
      }
    }

    // For move operation: BOTH source and destination must be strictly verified!
    if (toolName === "filesystem_move") {
      const source = String(input.source ?? "");
      const destination = String(input.destination ?? "");

      if (fsPolicy.read && !this.isPathAllowed(source, fsPolicy.read)) {
        return {
          allowed: false,
          reason: `Move source path "${source}" is outside allowed read paths`,
        };
      }
      if (fsPolicy.write) {
        if (!this.isPathAllowed(source, fsPolicy.write)) {
          return {
            allowed: false,
            reason: `Move source path "${source}" is outside allowed write paths`,
          };
        }
        if (!this.isPathAllowed(destination, fsPolicy.write)) {
          return {
            allowed: false,
            reason: `Move destination path "${destination}" is outside allowed write paths: ${fsPolicy.write.join(", ")}`,
          };
        }
      }
    }

    return { allowed: true };
  }

  private checkTerminal(input: Record<string, unknown>): PermissionDecision {
    const termPolicy = this.policy.terminal;

    // Secure by default: Deny terminal execution unless explicitly configured or trusted
    if (!termPolicy && !this.policy.trusted) {
      return {
        allowed: false,
        reason:
          "Terminal execution is denied by default for security. Configure terminal permissions or enable trusted mode.",
      };
    }
    if (!termPolicy) return { allowed: true };

    const command = String(input.command ?? "").trim();
    if (!command) {
      return { allowed: false, reason: "Command cannot be empty" };
    }

    // Parse and tokenize command safely
    const parseResult = parseCommand(command);
    if (!parseResult.ok || !parseResult.command) {
      return {
        allowed: false,
        reason: parseResult.error ?? "Invalid or dangerous command format",
      };
    }

    const { executable } = parseResult.command;

    // Check cwd against filesystem policy if provided
    if (input.cwd && this.policy.filesystem?.read) {
      const cwdStr = String(input.cwd);
      if (!this.isPathAllowed(cwdStr, this.policy.filesystem.read)) {
        return {
          allowed: false,
          reason: `Working directory (cwd) "${cwdStr}" is outside allowed filesystem boundaries`,
        };
      }
    }

    // Deny list takes priority
    if (termPolicy.deny) {
      const isDenied = termPolicy.deny.some((denied) => {
        const norm = denied.trim().toLowerCase().replace(/\.(exe|cmd|bat)$/i, "");
        return executable === norm || command.toLowerCase().startsWith(norm + " ");
      });
      if (isDenied) {
        return {
          allowed: false,
          reason: `Command executable "${executable}" is explicitly denied`,
        };
      }
    }

    // If allow list exists, exact executable must match
    if (termPolicy.allow) {
      const isAllowed = termPolicy.allow.some((allowed) => {
        const norm = allowed.trim().toLowerCase().replace(/\.(exe|cmd|bat)$/i, "");
        return executable === norm;
      });
      if (!isAllowed) {
        return {
          allowed: false,
          reason: `Command executable "${executable}" is not in the allowed list: ${termPolicy.allow.join(", ")}`,
        };
      }
    }

    return { allowed: true };
  }

  private checkBrowser(input: Record<string, unknown>): PermissionDecision {
    const browserPolicy = this.policy.browser!;
    const url = String(input.url ?? "");

    if (browserPolicy.allowOrigins && url) {
      try {
        const origin = new URL(url).origin;
        if (!browserPolicy.allowOrigins.includes(origin)) {
          return {
            allowed: false,
            reason: `Origin "${origin}" is not in allowed origins: ${browserPolicy.allowOrigins.join(", ")}`,
          };
        }
      } catch {
        return { allowed: false, reason: `Invalid URL: "${url}"` };
      }
    }

    return { allowed: true };
  }

  private checkHttp(input: Record<string, unknown>): PermissionDecision {
    const urlStr = String(input.url ?? "").trim();
    if (!urlStr) {
      return { allowed: false, reason: "URL cannot be empty" };
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(urlStr);
    } catch {
      return { allowed: false, reason: `Invalid URL format: "${urlStr}"` };
    }

    // Strictly enforce http/https protocols (reject file:, gopher:, javascript:, data:, etc.)
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return {
        allowed: false,
        reason: `Forbidden protocol "${parsedUrl.protocol}". Only "http:" and "https:" are allowed.`,
      };
    }

    const httpPolicy = this.policy.http;
    if (!httpPolicy && !this.policy.trusted) {
      return { allowed: true };
    }
    if (!httpPolicy) return { allowed: true };

    const origin = parsedUrl.origin.toLowerCase();

    // Check deny list first
    if (httpPolicy.denyOrigins) {
      const isDenied = httpPolicy.denyOrigins.some(
        (o) => origin === o.toLowerCase().replace(/\/$/, "")
      );
      if (isDenied) {
        return {
          allowed: false,
          reason: `Origin "${origin}" is explicitly blocked by HTTP policy`,
        };
      }
    }

    // Check allow list
    if (httpPolicy.allowOrigins) {
      const isAllowed = httpPolicy.allowOrigins.some(
        (o) => origin === o.toLowerCase().replace(/\/$/, "")
      );
      if (!isAllowed) {
        return {
          allowed: false,
          reason: `Origin "${origin}" is not in allowed origins: ${httpPolicy.allowOrigins.join(", ")}`,
        };
      }
    }

    return { allowed: true };
  }
}

// Re-export parser & approval
export { parseCommand, type ParsedCommand, type ParseResult } from "./command-parser";
export { ApprovalManager, ConsoleApprovalHandler, AutoApprovalHandler } from "./approval";
export type { ApprovalHandler, ApprovalRequest } from "./approval";
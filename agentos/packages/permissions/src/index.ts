// ─── @agentos/permissions ────────────────────────────────────────────────────
// Capability-based permission engine. Evaluates declarative policies against
// tool calls to decide whether an operation is allowed.

import type { RiskLevel } from "@agentos/core";

// ─── Policy Configuration ────────────────────────────────────────────────────

/**
 * Declarative permission policy. Configure what each tool category is allowed
 * to do. Anything not explicitly allowed for restricted tools is denied.
 *
 * ```ts
 * const policy: PermissionPolicy = {
 *   filesystem: {
 *     read: ["~/Downloads", "~/Documents"],
 *     write: ["~/Documents/AgentOS"],
 *   },
 *   terminal: {
 *     allow: ["git", "npm", "pnpm", "node", "python"],
 *   },
 *   browser: {
 *     allowOrigins: ["https://github.com"],
 *   },
 *   approval: {
 *     requireFor: "HIGH",
 *     timeoutMs: 60000,
 *   },
 * };
 * ```
 */
export interface PermissionPolicy {
  filesystem?: {
    /** Paths the agent may read from (glob-like prefix matching). */
    read?: string[];
    /** Paths the agent may write to. */
    write?: string[];
  };
  terminal?: {
    /** Command prefixes the agent is allowed to execute. */
    allow?: string[];
    /** Command prefixes explicitly denied. Takes priority over allow. */
    deny?: string[];
  };
  browser?: {
    /** Origins the agent may navigate to. */
    allowOrigins?: string[];
  };
  approval?: {
    /** Require human approval for tools at or above this risk level. */
    requireFor: RiskLevel;
    /** How long to wait for approval before timing out (ms). */
    timeoutMs?: number;
  };
}

// ─── Decision ────────────────────────────────────────────────────────────────

export interface PermissionDecision {
  allowed: boolean;
  reason?: string;
}

// ─── Permission Engine ───────────────────────────────────────────────────────

/**
 * Evaluates a permission policy against tool calls.
 *
 * Default behavior: if no policy is configured for a tool category,
 * all operations are allowed (open-by-default for v0.1).
 * When a policy IS configured, only explicitly listed operations are allowed.
 */
export class PermissionEngine {
  constructor(private policy: PermissionPolicy = {}) {}

  /**
   * Check whether a specific tool call is permitted.
   *
   * @param toolName - e.g. "filesystem_read", "terminal_exec"
   * @param input    - the arguments that will be passed to the tool
   */
  check(toolName: string, input: Record<string, unknown>): PermissionDecision {
    const normalizedName = toolName.replace(/\./g, "_");

    // ── Filesystem checks ──────────────────────────────────────────────
    if (normalizedName.startsWith("filesystem_") && this.policy.filesystem) {
      return this.checkFilesystem(normalizedName, input);
    }

    // ── Terminal checks ────────────────────────────────────────────────
    if (normalizedName.startsWith("terminal_") && this.policy.terminal) {
      return this.checkTerminal(input);
    }

    // ── Browser checks ─────────────────────────────────────────────────
    if (normalizedName.startsWith("browser_") && this.policy.browser) {
      return this.checkBrowser(input);
    }

    // No policy configured for this tool → allow
    return { allowed: true };
  }

  /** Whether human approval is needed for the given risk level. */
  requiresApproval(riskLevel: RiskLevel): boolean {
    if (!this.policy.approval) return false;
    const order: Record<RiskLevel, number> = {
      LOW: 0,
      MEDIUM: 1,
      HIGH: 2,
      CRITICAL: 3,
    };
    return order[riskLevel] >= order[this.policy.approval.requireFor];
  }

  /** Get the approval timeout in ms. */
  get approvalTimeoutMs(): number {
    return this.policy.approval?.timeoutMs ?? 60_000;
  }

  // ── Private Checks ─────────────────────────────────────────────────────

  private checkFilesystem(
    toolName: string,
    input: Record<string, unknown>
  ): PermissionDecision {
    const fsPolicy = this.policy.filesystem!;
    const filePath = String(input.path ?? input.source ?? "");

    const isRead =
      toolName === "filesystem_read" ||
      toolName === "filesystem_list" ||
      toolName === "filesystem_exists";

    if (isRead && fsPolicy.read) {
      if (!this.pathMatchesAny(filePath, fsPolicy.read)) {
        return {
          allowed: false,
          reason: `Path "${filePath}" is not in the allowed read paths: ${fsPolicy.read.join(", ")}`,
        };
      }
    }

    const isWrite =
      toolName === "filesystem_write" ||
      toolName === "filesystem_move" ||
      toolName === "filesystem_delete";

    if (isWrite && fsPolicy.write) {
      if (!this.pathMatchesAny(filePath, fsPolicy.write)) {
        return {
          allowed: false,
          reason: `Path "${filePath}" is not in the allowed write paths: ${fsPolicy.write.join(", ")}`,
        };
      }
    }

    return { allowed: true };
  }

  private checkTerminal(input: Record<string, unknown>): PermissionDecision {
    const termPolicy = this.policy.terminal!;
    const command = String(input.command ?? "").trim();
    const firstWord = command.split(/\s+/)[0] ?? "";

    // Deny takes priority
    if (termPolicy.deny) {
      for (const denied of termPolicy.deny) {
        if (firstWord === denied || command.startsWith(denied)) {
          return {
            allowed: false,
            reason: `Command "${firstWord}" is explicitly denied`,
          };
        }
      }
    }

    // If allow list exists, command must match
    if (termPolicy.allow) {
      const allowed = termPolicy.allow.some(
        (a) => firstWord === a || command.startsWith(a)
      );
      if (!allowed) {
        return {
          allowed: false,
          reason: `Command "${firstWord}" is not in the allowed list: ${termPolicy.allow.join(", ")}`,
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

  private pathMatchesAny(filePath: string, patterns: string[]): boolean {
    const normalized = filePath.replace(/\\/g, "/").toLowerCase();
    return patterns.some((pattern) => {
      const normalizedPattern = pattern.replace(/\\/g, "/").toLowerCase();
      // Simple prefix matching — the path must start with the allowed prefix
      return normalized.startsWith(normalizedPattern);
    });
  }
}

// Re-export approval
export { ApprovalManager, ConsoleApprovalHandler, AutoApprovalHandler } from "./approval";
export type { ApprovalHandler, ApprovalRequest } from "./approval";
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
    /** Origins explicitly blocked from navigation. */
    denyOrigins?: string[];
    /** If true, permits navigation to private/internal network addresses (e.g. 127.0.0.1, localhost). Default: false */
    allowPrivateNetworks?: boolean;
  };

  http?: {
    /** Origins allowed for HTTP requests (e.g. ["https://api.github.com"]). */
    allowOrigins?: string[];
    /** Origins explicitly blocked. Takes priority over allowOrigins. */
    denyOrigins?: string[];
    /** If true, permits HTTP requests to private/internal network addresses (e.g. 127.0.0.1, localhost). Default: false */
    allowPrivateNetworks?: boolean;
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

// ─── SSRF Private IP Detection ───────────────────────────────────────────────

/**
 * Checks whether a hostname resolves to a private/internal IP range.
 * Blocks SSRF attacks targeting internal services (cloud metadata, localhost, etc.).
 */
function isPrivateHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();

  // Obvious local hostnames
  if (lower === "localhost" || lower === "0.0.0.0" || lower === "[::1]") return true;

  // IPv6 loopback
  if (lower === "::1") return true;

  // IPv4 private ranges
  const ipv4Match = lower.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    if (a === 127) return true;                          // 127.0.0.0/8
    if (a === 10) return true;                           // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true;    // 172.16.0.0/12
    if (a === 192 && b === 168) return true;              // 192.168.0.0/16
    if (a === 169 && b === 254) return true;              // 169.254.0.0/16 (link-local / cloud metadata)
    if (a === 0) return true;                            // 0.0.0.0/8
  }

  // IPv6 private ranges (simplified)
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;  // fc00::/7 (ULA)
  if (lower.startsWith("fe80")) return true;                           // fe80::/10 (link-local)

  return false;
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
    if (normalizedName.startsWith("browser_")) {
      return this.checkBrowser(input);
    }

    // ── HTTP checks ────────────────────────────────────────────────────
    if (
      normalizedName.startsWith("http_") ||
      normalizedName === "http_request"
    ) {
      return this.checkHttp(input);
    }

    // ── Code interpreter checks (HIGH risk tools) ──────────────────────
    if (normalizedName === "code_interpret") {
      if (this.policy.trusted) return { allowed: true };
      // code_interpret is gated by approval, but permission check still passes
      // since the approval manager handles the risk-level gate
      return { allowed: true };
    }

    // Deny uncategorized/unknown tools unless trusted mode is enabled.
    // This prevents bypassing the permission system by inventing tool names.
    if (this.policy.trusted) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `Unknown tool category "${toolName}". Configure permissions or enable trusted mode.`,
    };
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

    // DENY-BY-DEFAULT: If no filesystem policy configured and not trusted, deny all filesystem access.
    if (!fsPolicy && !this.policy.trusted) {
      return {
        allowed: false,
        reason: "Filesystem access denied by default. Configure filesystem permissions (read/write paths) or enable trusted mode.",
      };
    }
    // Trusted mode with no explicit policy → allow all
    if (!fsPolicy) return { allowed: true };

    const filePath = String(input.path ?? "");

    const isRead =
      toolName === "filesystem_read" ||
      toolName === "filesystem_list" ||
      toolName === "filesystem_exists";

    if (isRead) {
      // PARTIAL-POLICY DENY: If read capability is not explicitly granted, deny.
      if (!fsPolicy.read) {
        return {
          allowed: false,
          reason: `Filesystem read access not configured. Add "read" paths to filesystem permissions.`,
        };
      }
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

    if (isWrite) {
      // PARTIAL-POLICY DENY: If write capability is not explicitly granted, deny.
      if (!fsPolicy.write) {
        return {
          allowed: false,
          reason: `Filesystem write access not configured. Add "write" paths to filesystem permissions.`,
        };
      }
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

      // Move mutates the destination, so write capability is mandatory
      if (!fsPolicy.write) {
        return {
          allowed: false,
          reason: `Filesystem write access not configured. Move requires write permission on source and destination.`,
        };
      }

      // Source path verification: must be within read paths (if configured) or write paths
      const sourceAllowed = fsPolicy.read
        ? this.isPathAllowed(source, fsPolicy.read) || this.isPathAllowed(source, fsPolicy.write)
        : this.isPathAllowed(source, fsPolicy.write);

      if (!sourceAllowed) {
        return {
          allowed: false,
          reason: `Move source path "${source}" is outside allowed paths`,
        };
      }

      // Destination path verification: must be strictly inside allowed write paths
      if (!this.isPathAllowed(destination, fsPolicy.write)) {
        return {
          allowed: false,
          reason: `Move destination path "${destination}" is outside allowed write paths: ${fsPolicy.write.join(", ")}`,
        };
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
    const urlStr = String(input.url ?? "").trim();
    if (!urlStr) {
      // Actions without URL (click, type, observe, screenshot)
      return { allowed: true };
    }

    if (this.policy.trusted) {
      return { allowed: true };
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(urlStr);
    } catch {
      return { allowed: false, reason: `Invalid URL format: "${urlStr}"` };
    }

    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return {
        allowed: false,
        reason: `Forbidden protocol "${parsedUrl.protocol}". Only "http:" and "https:" are allowed in browser navigation.`,
      };
    }

    const browserPolicy = this.policy.browser;
    const httpPolicy = this.policy.http;

    // SSRF protection: Block navigation to private/internal IP ranges
    const allowPrivate = this.policy.trusted || browserPolicy?.allowPrivateNetworks;
    if (!allowPrivate && isPrivateHostname(parsedUrl.hostname)) {
      return {
        allowed: false,
        reason: `SSRF protection: navigation to private/internal address "${parsedUrl.hostname}" is blocked. Use trusted mode or set allowPrivateNetworks: true to override.`,
      };
    }

    const origin = parsedUrl.origin;

    // Check deny list — EXACT ORIGIN + OPTIONAL SUBPATH MATCHING (no startsWith prefix spoofing)
    const denyList = [
      ...(browserPolicy?.denyOrigins ?? []),
      ...(httpPolicy?.denyOrigins ?? []),
    ];
    for (const denied of denyList) {
      try {
        const deniedUrl = new URL(denied);
        // Only applies if exact origin matches (prevents example.com.evil.com bypass)
        if (deniedUrl.origin === origin) {
          if (deniedUrl.pathname && deniedUrl.pathname !== "/") {
            if (parsedUrl.pathname.startsWith(deniedUrl.pathname)) {
              return {
                allowed: false,
                reason: `URL "${urlStr}" is explicitly denied by security policy (${denied})`,
              };
            }
          } else {
            return {
              allowed: false,
              reason: `Origin "${origin}" is explicitly denied by security policy`,
            };
          }
        }
      } catch {
        if (origin === denied || urlStr === denied) {
          return {
            allowed: false,
            reason: `Origin "${origin}" is explicitly denied by security policy`,
          };
        }
      }
    }

    // Check allow list — EXACT ORIGIN + OPTIONAL SUBPATH MATCHING
    const allowList = browserPolicy?.allowOrigins ?? httpPolicy?.allowOrigins;
    if (allowList && allowList.length > 0) {
      const isAllowed = allowList.some((allowed) => {
        if (allowed === "*") return true;
        try {
          const allowedUrl = new URL(allowed);
          if (allowedUrl.origin !== origin) {
            return false;
          }
          if (allowedUrl.pathname && allowedUrl.pathname !== "/") {
            return parsedUrl.pathname.startsWith(allowedUrl.pathname);
          }
          return true;
        } catch {
          return origin === allowed;
        }
      });
      if (!isAllowed) {
        return {
          allowed: false,
          reason: `Origin "${origin}" is not in allowed origins: ${allowList.join(", ")}`,
        };
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

    // SSRF protection: Block HTTP requests to private/internal IP ranges
    const allowPrivate = this.policy.trusted || httpPolicy?.allowPrivateNetworks;
    if (!allowPrivate && isPrivateHostname(parsedUrl.hostname)) {
      return {
        allowed: false,
        reason: `SSRF protection: HTTP request to private/internal address "${parsedUrl.hostname}" is blocked. Use trusted mode or set allowPrivateNetworks: true to override.`,
      };
    }

    if (!httpPolicy && !this.policy.trusted) {
      return { allowed: true };
    }
    if (!httpPolicy) return { allowed: true };

    const origin = parsedUrl.origin.toLowerCase();

    // Check deny list first — origin + subpath aware
    if (httpPolicy.denyOrigins) {
      for (const denied of httpPolicy.denyOrigins) {
        try {
          const deniedUrl = new URL(denied);
          if (deniedUrl.origin.toLowerCase() === origin) {
            if (deniedUrl.pathname && deniedUrl.pathname !== "/") {
              if (parsedUrl.pathname.startsWith(deniedUrl.pathname)) {
                return {
                  allowed: false,
                  reason: `URL "${urlStr}" is explicitly blocked by HTTP policy (${denied})`,
                };
              }
            } else {
              return {
                allowed: false,
                reason: `Origin "${origin}" is explicitly blocked by HTTP policy`,
              };
            }
          }
        } catch {
          if (origin === denied.toLowerCase().replace(/\/$/, "")) {
            return {
              allowed: false,
              reason: `Origin "${origin}" is explicitly blocked by HTTP policy`,
            };
          }
        }
      }
    }

    // Check allow list — origin + subpath aware
    if (httpPolicy.allowOrigins) {
      const isAllowed = httpPolicy.allowOrigins.some((allowed) => {
        if (allowed === "*") return true;
        try {
          const allowedUrl = new URL(allowed);
          if (allowedUrl.origin.toLowerCase() !== origin) {
            return false;
          }
          if (allowedUrl.pathname && allowedUrl.pathname !== "/") {
            return parsedUrl.pathname.startsWith(allowedUrl.pathname);
          }
          return true;
        } catch {
          return origin === allowed.toLowerCase().replace(/\/$/, "");
        }
      });
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
export { redactSecrets } from "./redactor";
// ─── @agentos/permissions ────────────────────────────────────────────────────
// Capability-based permission engine. Evaluates declarative policies against
// tool calls to decide whether an operation is allowed.
//
// Hardened with canonical path boundary verification, shell command sanitization,
// cwd isolation, and secure-by-default execution.

import * as fs from "fs";
import * as path from "path";
import * as dns from "dns";
import * as net from "net";
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
    /** Executables permitted to run. If set, ONLY these are allowed. */
    allow?: string[];
    /** Executables strictly blocked. Takes precedence over allow. */
    deny?: string[];
  };

  browser?: {
    /** Allowed origins, e.g. ["https://github.com"]. Default: all. */
    allowOrigins?: string[];
    /** Blocked origins. Takes precedence. */
    denyOrigins?: string[];
    /** Whether to allow navigating to private/local networks. Default: false. */
    allowPrivateNetworks?: boolean;
  };

  http?: {
    /** Allowed HTTP origins/domains. */
    allowOrigins?: string[];
    /** Blocked HTTP origins/domains. */
    denyOrigins?: string[];
    /** Whether to allow requests to private/local networks. Default: false. */
    allowPrivateNetworks?: boolean;
  };

  approval?: {
    /** Lowest risk level that requires human approval. Default: "HIGH". */
    requireFor: RiskLevel;
    /** Timeout in milliseconds waiting for human response. Default: 60s. */
    timeoutMs?: number;
  };
}

// ─── Decision ────────────────────────────────────────────────────────────────

export interface PermissionDecision {
  allowed: boolean;
  reason?: string;
}

// ─── Path Boundary Helper (Symlink & Junction Safe) ──────────────────────────

/**
 * Canonicalizes a path by resolving all symlinks, junctions, and reparse points.
 * If the path itself does not exist, it traverses upward to find the nearest
 * existing ancestor directory, canonicalizes that directory with realpathSync,
 * and appends the remaining uncreated path segments.
 */
export function canonicalizePath(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  try {
    if (fs.existsSync(resolved)) {
      return fs.realpathSync(resolved);
    }
  } catch {
    // If realpathSync fails, fallback to ancestor search
  }

  // Find nearest existing ancestor directory
  let current = resolved;
  const trailingParts: string[] = [];

  while (current && current !== path.dirname(current)) {
    trailingParts.unshift(path.basename(current));
    current = path.dirname(current);
    try {
      if (fs.existsSync(current)) {
        const canonicalAncestor = fs.realpathSync(current);
        return path.resolve(canonicalAncestor, ...trailingParts);
      }
    } catch {
      // Continue walking upward
    }
  }

  return resolved;
}

/**
 * Checks whether a child path resides strictly inside an allowed parent directory.
 * Resolves lexical path traversal (..), boundary spoofing (/appSecret matching /app),
 * and symlinks/NTFS junctions pointing outside the parent boundary.
 */
export function isPathInside(parent: string, child: string): boolean {
  const resolvedParent = path.resolve(parent);
  const resolvedChild = path.resolve(child);

  const isWindows = process.platform === "win32";
  const pNorm = isWindows ? resolvedParent.toLowerCase() : resolvedParent;
  const cNorm = isWindows ? resolvedChild.toLowerCase() : resolvedChild;

  if (pNorm === cNorm) return true;

  // 1. Lexical boundary check
  const rel = path.relative(pNorm, cNorm);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return false;
  }

  // 2. Canonical symlink / junction resolution check
  try {
    const canonicalParent = canonicalizePath(parent);
    const canonicalChild = canonicalizePath(child);

    const cpNorm = isWindows ? canonicalParent.toLowerCase() : canonicalParent;
    const ccNorm = isWindows ? canonicalChild.toLowerCase() : canonicalChild;

    if (cpNorm === ccNorm) return true;

    const canonicalRel = path.relative(cpNorm, ccNorm);
    return !canonicalRel.startsWith("..") && !path.isAbsolute(canonicalRel);
  } catch {
    return false;
  }
}

// ─── SSRF Private IP & DNS Detection ─────────────────────────────────────────

/**
 * Checks whether an IP address is in private, loopback, link-local, or cloud metadata ranges.
 */
export function isPrivateIp(ip: string): boolean {
  const clean = ip.trim().toLowerCase();
  if (clean === "localhost" || clean === "0.0.0.0" || clean === "::" || clean === "::1") return true;

  // IPv4 check
  const ipv4Match = clean.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    if (a === 127) return true;                          // 127.0.0.0/8 (loopback)
    if (a === 10) return true;                           // 10.0.0.0/8 (private)
    if (a === 172 && b >= 16 && b <= 31) return true;    // 172.16.0.0/12 (private)
    if (a === 192 && b === 168) return true;              // 192.168.0.0/16 (private)
    if (a === 169 && b === 254) return true;              // 169.254.0.0/16 (link-local / cloud metadata)
    if (a === 0) return true;                            // 0.0.0.0/8
    if (a >= 224) return true;                           // 224.0.0.0/4 (multicast / reserved)
    return false;
  }

  // IPv6 check
  if (clean.startsWith("::ffff:")) {
    return isPrivateIp(clean.slice(7));
  }
  if (clean.startsWith("fc") || clean.startsWith("fd")) return true;  // fc00::/7 (ULA)
  if (clean.startsWith("fe80")) return true;                           // fe80::/10 (link-local)
  if (clean === "::1" || clean === "::") return true;

  return false;
}

/**
 * Checks whether a hostname or literal IP is private.
 */
export function isPrivateHostname(hostname: string): boolean {
  const clean = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (clean === "localhost" || clean === "0.0.0.0" || clean === "::1") return true;
  if (clean.endsWith(".localhost") || clean.endsWith(".internal") || clean.endsWith(".local")) return true;
  return isPrivateIp(clean);
}

/**
 * Result of host IP safety check.
 */
export interface HostIpSafetyResult {
  safe: boolean;
  code: "SAFE" | "PRIVATE_IP" | "DNS_FAILURE" | "DNS_EMPTY";
  reason?: string;
}

/**
 * Validates that all DNS resolved IP addresses for a given hostname are public addresses.
 * Rejects hostnames resolving to private/internal IPs to prevent SSRF via DNS resolution.
 * FAILS CLOSED on DNS resolution failure or empty records.
 */
export async function validateHostIpSafetyDetails(hostname: string): Promise<HostIpSafetyResult> {
  const clean = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isPrivateHostname(clean)) {
    return {
      safe: false,
      code: "PRIVATE_IP",
      reason: `Hostname or IP "${clean}" is recognized as a private/internal network address.`,
    };
  }

  // If clean is already a valid IP literal
  if (net.isIP(clean) !== 0) {
    return { safe: true, code: "SAFE" };
  }

  try {
    const addresses = await dns.promises.lookup(clean, { all: true });
    if (!addresses || addresses.length === 0) {
      return {
        safe: false,
        code: "DNS_EMPTY",
        reason: `DNS lookup for "${clean}" returned no address records.`,
      };
    }
    for (const addr of addresses) {
      if (isPrivateIp(addr.address)) {
        return {
          safe: false,
          code: "PRIVATE_IP",
          reason: `Hostname "${clean}" resolves to private/internal IP address "${addr.address}".`,
        };
      }
    }
    return { safe: true, code: "SAFE" };
  } catch (err) {
    return {
      safe: false,
      code: "DNS_FAILURE",
      reason: `DNS resolution failed for "${clean}": ${(err as Error).message}`,
    };
  }
}

/**
 * Validates that all DNS resolved IP addresses for a given hostname are public addresses.
 * Rejects hostnames resolving to private/internal IPs to prevent SSRF via DNS resolution.
 * Fails closed (returns false) if DNS resolution fails or returns no records.
 */
export async function validateHostIpSafety(hostname: string): Promise<boolean> {
  const result = await validateHostIpSafetyDetails(hostname);
  return result.safe;
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

  /**
   * Asynchronously validates whether a browser navigation URL is permitted by policy.
   * Enforces protocol safety (http/https), origin allow/deny lists, and
   * async DNS pre-resolution SSRF checks against internal/private IPs.
   */
  async checkBrowserUrlAsync(urlStr: string): Promise<PermissionDecision> {
    const syncDecision = this.checkBrowser({ url: urlStr });
    if (!syncDecision.allowed) {
      return syncDecision;
    }

    if (this.policy.trusted) {
      return { allowed: true };
    }

    const browserPolicy = this.policy.browser;
    if (browserPolicy?.allowPrivateNetworks) {
      return { allowed: true };
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(urlStr);
    } catch {
      return { allowed: false, reason: `Invalid URL format: "${urlStr}"` };
    }

    const hostSafety = await validateHostIpSafetyDetails(parsedUrl.hostname);
    if (!hostSafety.safe) {
      return {
        allowed: false,
        reason: `SSRF protection: browser navigation to "${parsedUrl.hostname}" is blocked (${hostSafety.reason ?? hostSafety.code}).`,
      };
    }

    return { allowed: true };
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

    // Enforce cwd boundaries against filesystem policy
    const effectiveCwd = input.cwd ? String(input.cwd) : process.cwd();
    if (this.policy.filesystem?.read) {
      if (!this.isPathAllowed(effectiveCwd, this.policy.filesystem.read)) {
        return {
          allowed: false,
          reason: `Working directory (cwd) "${effectiveCwd}" is outside allowed filesystem boundaries`,
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

  /** Public checker for HTTP URLs (used for redirect validation and standalone URL checks). */
  checkHttpUrl(url: string): PermissionDecision {
    return this.checkHttp({ url });
  }

  /** Public checker for Browser URLs (used for navigation and redirect checks). */
  checkBrowserUrl(url: string): PermissionDecision {
    return this.checkBrowser({ url });
  }
}

// Re-export parser & approval
export { parseCommand, type ParsedCommand, type ParseResult } from "./command-parser";
export { ApprovalManager, ConsoleApprovalHandler, AutoApprovalHandler } from "./approval";
export type { ApprovalHandler, ApprovalRequest } from "./approval";
export { redactSecrets } from "./redactor";
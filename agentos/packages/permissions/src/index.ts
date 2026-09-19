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

  customTools?: {
    /** Explicitly allowed custom tool names. */
    allow?: string[];
    /** Explicitly denied custom tool names. */
    deny?: string[];
  };

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

  codeInterpreter?: {
    /** Whether code interpreter / execution tools are enabled. Default: true. */
    enabled?: boolean;
    /** Allowed programming languages. Default: all. */
    allowedLanguages?: string[];
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

function parseIpv4ToUint32(ip: string): number | null {
  const parts = ip.trim().split(".");
  if (parts.length !== 4) return null;
  let num = 0;
  for (let i = 0; i < 4; i++) {
    const part = parts[i];
    if (!/^\d{1,3}$/.test(part)) return null;
    const val = Number(part);
    if (val < 0 || val > 255) return null;
    if (part.length > 1 && part.startsWith("0")) return null;
    num = ((num << 8) | val) >>> 0;
  }
  return num;
}

function isPrivateIpv4Num(num: number): boolean {
  // 0.0.0.0/8 (current network)
  if ((num >>> 24) === 0) return true;
  // 10.0.0.0/8 (private)
  if ((num >>> 24) === 10) return true;
  // 100.64.0.0/10 (CGNAT: 100.64.0.0 - 100.127.255.255)
  if ((num >>> 22) === 401) return true;
  // 127.0.0.0/8 (loopback)
  if ((num >>> 24) === 127) return true;
  // 169.254.0.0/16 (link-local / cloud metadata)
  if ((num >>> 16) === 0xa9fe) return true;
  // 172.16.0.0/12 (private: 172.16.0.0 - 172.31.255.255)
  if ((num >>> 20) === 2753) return true;
  // 192.0.0.0/24 (IETF protocol assignments)
  if ((num >>> 8) === 0xc00000) return true;
  // 192.0.2.0/24 (TEST-NET-1)
  if ((num >>> 8) === 0xc00002) return true;
  // 192.168.0.0/16 (private)
  if ((num >>> 16) === 0xc0a8) return true;
  // 198.18.0.0/15 (network benchmark: 198.18.0.0 - 198.19.255.255)
  if ((num >>> 17) === 6338) return true;
  // 198.51.100.0/24 (TEST-NET-2)
  if ((num >>> 8) === 0xc63364) return true;
  // 203.0.113.0/24 (TEST-NET-3)
  if ((num >>> 8) === 0xcb0071) return true;
  // 224.0.0.0/4 (multicast 224-239 and reserved 240-255)
  if ((num >>> 28) >= 14) return true;
  // 255.255.255.255/32 (broadcast)
  if (num === 0xffffffff) return true;
  return false;
}

function wordsToBigInt(words: string[]): bigint | null {
  let res = 0n;
  for (const w of words) {
    if (!/^[0-9a-f]{1,4}$/.test(w)) return null;
    const val = parseInt(w, 16);
    if (isNaN(val) || val < 0 || val > 0xffff) return null;
    res = (res << 16n) | BigInt(val);
  }
  return res;
}

function parseIpv6ToBigInt(ipStr: string): bigint | null {
  let clean = ipStr.trim().toLowerCase();
  // Strip zone ID (%eth0)
  const zoneIdx = clean.indexOf("%");
  if (zoneIdx !== -1) {
    clean = clean.slice(0, zoneIdx);
  }

  // Handle embedded IPv4 at the end, e.g. ::ffff:192.168.1.1 or ::127.0.0.1
  const lastColon = clean.lastIndexOf(":");
  if (lastColon !== -1 && clean.slice(lastColon + 1).includes(".")) {
    const ipv4Part = clean.slice(lastColon + 1);
    const v4Num = parseIpv4ToUint32(ipv4Part);
    if (v4Num === null) return null;
    const hi16 = ((v4Num >>> 16) & 0xffff).toString(16);
    const lo16 = (v4Num & 0xffff).toString(16);
    clean = clean.slice(0, lastColon) + ":" + hi16 + ":" + lo16;
  }

  const doubleColonIdx = clean.indexOf("::");
  if (doubleColonIdx !== -1) {
    if (clean.indexOf("::", doubleColonIdx + 2) !== -1) {
      return null;
    }
    const leftPart = clean.slice(0, doubleColonIdx);
    const rightPart = clean.slice(doubleColonIdx + 2);
    const leftWords = leftPart ? leftPart.split(":") : [];
    const rightWords = rightPart ? rightPart.split(":") : [];
    const missingCount = 8 - (leftWords.length + rightWords.length);
    if (missingCount < 0) return null;
    const zeros = new Array(missingCount).fill("0");
    const allWords = [...leftWords, ...zeros, ...rightWords];
    if (allWords.length !== 8) return null;
    return wordsToBigInt(allWords);
  } else {
    const allWords = clean.split(":");
    if (allWords.length !== 8) return null;
    return wordsToBigInt(allWords);
  }
}

/**
 * Checks whether an IP address is in private, loopback, link-local, or cloud metadata ranges.
 * Implements rigorous numeric bitwise CIDR validation for both IPv4 (uint32) and IPv6 (BigInt 128-bit).
 */
export function isPrivateIp(ip: string): boolean {
  const clean = ip.trim().toLowerCase();
  if (clean === "localhost" || clean === "0.0.0.0" || clean === "::" || clean === "::1") return true;

  // Try IPv4 first
  const v4 = parseIpv4ToUint32(clean);
  if (v4 !== null) {
    return isPrivateIpv4Num(v4);
  }

  // Try IPv6
  const v6 = parseIpv6ToBigInt(clean);
  if (v6 !== null) {
    // 1. ::/128 (unspecified)
    if (v6 === 0n) return true;
    // 2. ::1/128 (loopback)
    if (v6 === 1n) return true;

    // 3. IPv4-mapped: ::ffff:0:0/96 (top 96 bits are 0x0000...0000ffff)
    if ((v6 >> 32n) === 0xffffn) {
      const embeddedV4 = Number(v6 & 0xffffffffn);
      return isPrivateIpv4Num(embeddedV4);
    }

    // 4. IPv4-compatible (deprecated): ::/96 (top 96 bits are 0)
    if ((v6 >> 32n) === 0n && v6 > 1n) {
      const embeddedV4 = Number(v6 & 0xffffffffn);
      return isPrivateIpv4Num(embeddedV4);
    }

    // 5. NAT64: 64:ff9b::/96
    if ((v6 >> 32n) === 0x0064ff9b0000000000000000n) {
      const embeddedV4 = Number(v6 & 0xffffffffn);
      return isPrivateIpv4Num(embeddedV4);
    }

    // 6. 6to4: 2002::/16 -> bits 16-47 contain IPv4
    if ((v6 >> 112n) === 0x2002n) {
      const embeddedV4 = Number((v6 >> 80n) & 0xffffffffn);
      return isPrivateIpv4Num(embeddedV4);
    }

    // 7. Teredo: 2001::/32 -> bits 96-127 contain negated IPv4
    if ((v6 >> 96n) === 0x20010000n) {
      const embeddedV4 = Number((~v6) & 0xffffffffn);
      return isPrivateIpv4Num(embeddedV4);
    }

    // 8. Unique Local Address (ULA): fc00::/7 (0xfc00 - 0xfdff, top 7 bits 0x7e)
    if ((v6 >> 121n) === 0x7en) return true;

    // 9. Link-local unicast: fe80::/10 (0xfe80 - 0xfebf, top 10 bits 0x3fa)
    if ((v6 >> 118n) === 0x3fan) return true;

    // 10. Multicast: ff00::/8 (0xff00 - 0xffff)
    if ((v6 >> 120n) === 0xffn) return true;

    // 11. Documentation: 2001:db8::/32
    if ((v6 >> 96n) === 0x20010db8n) return true;

    // 12. Discard-only: 100::/64
    if ((v6 >> 64n) === 0x100000000000000n) return true;

    return false;
  }

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

// In-memory DNS safety cache with 60-second TTL to eliminate latency spikes on subresources
interface DnsCacheEntry {
  result: HostIpSafetyResult;
  expiresAt: number;
}
const dnsSafetyCache = new Map<string, DnsCacheEntry>();
const DNS_CACHE_TTL_MS = 60_000;

export function clearDnsSafetyCache(): void {
  dnsSafetyCache.clear();
}

/**
 * Validates that all DNS resolved IP addresses for a given hostname are public addresses.
 * Rejects hostnames resolving to private/internal IPs to prevent SSRF via DNS resolution.
 * FAILS CLOSED on DNS resolution failure or empty records.
 * Uses an in-memory cache with 60-second TTL.
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

  // Check DNS safety cache
  const cached = dnsSafetyCache.get(clean);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.result;
  }

  try {
    const addresses = await dns.promises.lookup(clean, { all: true });
    if (!addresses || addresses.length === 0) {
      const result: HostIpSafetyResult = {
        safe: false,
        code: "DNS_EMPTY",
        reason: `DNS lookup for "${clean}" returned no address records.`,
      };
      dnsSafetyCache.set(clean, { result, expiresAt: Date.now() + DNS_CACHE_TTL_MS });
      return result;
    }
    for (const addr of addresses) {
      if (isPrivateIp(addr.address)) {
        const result: HostIpSafetyResult = {
          safe: false,
          code: "PRIVATE_IP",
          reason: `Hostname "${clean}" resolves to private/internal IP address "${addr.address}".`,
        };
        dnsSafetyCache.set(clean, { result, expiresAt: Date.now() + DNS_CACHE_TTL_MS });
        return result;
      }
    }
    const result: HostIpSafetyResult = { safe: true, code: "SAFE" };
    dnsSafetyCache.set(clean, { result, expiresAt: Date.now() + DNS_CACHE_TTL_MS });
    return result;
  } catch (err) {
    const result: HostIpSafetyResult = {
      safe: false,
      code: "DNS_FAILURE",
      reason: `DNS resolution failed for "${clean}": ${(err as Error).message}`,
    };
    dnsSafetyCache.set(clean, { result, expiresAt: Date.now() + DNS_CACHE_TTL_MS });
    return result;
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
   * Prioritizes explicit tool category/capability declarations to prevent name-prefix spoofing.
   * Enforces capability validation, custom tool default denial, and fail-closed operation checking.
   */
  check(
    toolOrName: string | { name: string; category?: string; capability?: string },
    input: Record<string, unknown>
  ): PermissionDecision {
    const toolObj = typeof toolOrName === "object" ? toolOrName : undefined;
    const toolName = typeof toolOrName === "string" ? toolOrName : toolOrName.name;
    const normalizedName = toolName.replace(/\./g, "_");

    const category = toolObj?.category;
    const capability = toolObj?.capability;

    // ── Capability vs Category Consistency Validation ──────────────────
    if (category && capability) {
      const isCoreCapability =
        capability.startsWith("filesystem.") ||
        capability.startsWith("terminal.") ||
        capability.startsWith("browser.") ||
        capability.startsWith("network.") ||
        capability.startsWith("code.");

      let valid = true;
      if (category === "filesystem") {
        valid = capability.startsWith("filesystem.");
      } else if (category === "terminal") {
        valid = capability.startsWith("terminal.") || capability === "terminal.execute";
      } else if (category === "browser") {
        valid = capability.startsWith("browser.") || capability === "browser.navigate" || capability === "browser.interact";
      } else if (category === "http") {
        valid = capability.startsWith("network.") || capability === "network.request";
      } else if (category === "code_interpreter") {
        valid = capability.startsWith("code.") || capability === "code.interpret";
      } else if (category === "custom") {
        // Custom tools cannot declare core capabilities to evade checks
        valid = !isCoreCapability;
      }

      if (!valid) {
        return {
          allowed: false,
          reason: `Security policy violation: Tool "${toolName}" declares mismatched category "${category}" and capability "${capability}".`,
        };
      }
    }

    // ── Custom declared application tools (DENY by default) ────────────
    if (category === "custom" || capability === "custom" || capability?.startsWith("custom.")) {
      if (this.policy.trusted) {
        return { allowed: true };
      }
      const customPolicy = this.policy.customTools;
      if (customPolicy?.deny?.includes(toolName)) {
        return {
          allowed: false,
          reason: `Custom tool "${toolName}" is explicitly denied by permission policy.`,
        };
      }
      if (customPolicy?.allow?.includes(toolName)) {
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: `Custom tool "${toolName}" is denied by default. Explicitly add it to policy.customTools.allow or enable trusted mode.`,
      };
    }

    // ── Filesystem checks ──────────────────────────────────────────────
    if (
      category === "filesystem" ||
      capability?.startsWith("filesystem.") ||
      (!category && normalizedName.startsWith("filesystem_"))
    ) {
      return this.checkFilesystem(normalizedName, input, capability);
    }

    // ── Terminal checks ────────────────────────────────────────────────
    if (category === "terminal" || (!category && normalizedName.startsWith("terminal_"))) {
      return this.checkTerminal(input);
    }

    // ── Browser checks ─────────────────────────────────────────────────
    if (category === "browser" || (!category && normalizedName.startsWith("browser_"))) {
      return this.checkBrowser(input);
    }

    // ── HTTP checks ────────────────────────────────────────────────────
    if (
      category === "http" ||
      (!category && (normalizedName.startsWith("http_") || normalizedName === "http_request"))
    ) {
      return this.checkHttp(input);
    }

    // ── Code interpreter checks (HIGH risk tools) ──────────────────────
    if (
      category === "code_interpreter" ||
      capability === "code.interpret" ||
      (!category && normalizedName === "code_interpret")
    ) {
      if (this.policy.trusted) return { allowed: true };
      if (this.policy.codeInterpreter && this.policy.codeInterpreter.enabled === false) {
        return {
          allowed: false,
          reason: "Code interpreter tools are disabled by permission policy.",
        };
      }
      return { allowed: true };
    }

    // Deny uncategorized/unknown tools unless trusted mode is enabled.
    // This prevents bypassing the permission system by inventing tool names.
    if (this.policy.trusted) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `Unknown tool category "${category || toolName}". Configure permissions or enable trusted mode.`,
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
    input: Record<string, unknown>,
    capability?: string
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
      capability === "filesystem.read" ||
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
      capability === "filesystem.write" ||
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
    const isMove =
      capability === "filesystem.move" ||
      toolName === "filesystem_move";

    if (isMove) {
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

    // FAIL CLOSED: If the operation cannot be proven as an authorized read, write, or move, deny it!
    if (!isRead && !isWrite && !isMove) {
      return {
        allowed: false,
        reason: `Unrecognized or unauthorized filesystem operation for tool "${toolName}" (capability: "${capability || "unknown"}"). Operation denied fail-closed.`,
      };
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

  /**
   * Asynchronously validates whether an HTTP request URL is permitted by policy.
   * Enforces protocol safety (http/https), origin allow/deny lists, and
   * async DNS pre-resolution SSRF checks against internal/private IPs.
   */
  async checkHttpUrlAsync(urlStr: string): Promise<PermissionDecision> {
    const syncDecision = this.checkHttp({ url: urlStr });
    if (!syncDecision.allowed) {
      return syncDecision;
    }

    if (this.policy.trusted) {
      return { allowed: true };
    }

    const httpPolicy = this.policy.http;
    if (httpPolicy?.allowPrivateNetworks) {
      return { allowed: true };
    }

    let parsed: URL;
    try {
      parsed = new URL(urlStr);
    } catch {
      return { allowed: false, reason: `Invalid URL: "${urlStr}"` };
    }

    const hostCheck = await validateHostIpSafetyDetails(parsed.hostname);
    if (!hostCheck.safe) {
      return {
        allowed: false,
        reason: `SSRF protection: HTTP request to "${urlStr}" blocked: ${hostCheck.reason || "host resolved to private network or unresolvable"}`,
      };
    }

    return { allowed: true };
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
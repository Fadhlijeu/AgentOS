// ─── @agentos/adapters/workspace ──────────────────────────────────────────────
// Concrete implementations of WorkspaceAdapter for secure file isolation.
//
// Supports:
// 1. LocalWorkspace: Real host directory with strict canonical boundary validation.
// 2. InMemoryWorkspace: Virtual in-memory file system for zero-I/O testing and sandboxes.

import * as fs from "fs";
import * as path from "path";
import { generateId } from "@agentos/core";
import { isPathInside } from "@agentos/permissions";
import type { WorkspaceAdapter } from "./index";

/** Error thrown when an agent attempts to escape a workspace boundary. */
export class WorkspacePathViolationError extends Error {
  constructor(relativePath: string, rootPath: string) {
    super(
      `Security violation: Path "${relativePath}" attempts to escape workspace root "${rootPath}".`
    );
    this.name = "WorkspacePathViolationError";
  }
}

// ─── Local Workspace ─────────────────────────────────────────────────────────

export interface LocalWorkspaceOptions {
  id?: string;
  rootPath: string;
  createIfNotExists?: boolean;
}

/**
 * A real filesystem workspace confined strictly to a root folder.
 * All file operations are verified with `isPathInside` before touching the disk.
 */
export class LocalWorkspace implements WorkspaceAdapter {
  readonly id: string;
  readonly rootPath: string;

  constructor(options: LocalWorkspaceOptions) {
    this.id = options.id ?? generateId("ws");
    const rawRoot = path.resolve(options.rootPath);

    if (options.createIfNotExists ?? true) {
      if (!fs.existsSync(rawRoot)) {
        fs.mkdirSync(rawRoot, { recursive: true });
      }
    }
    this.rootPath = fs.existsSync(rawRoot) ? fs.realpathSync(rawRoot) : rawRoot;
  }

  /**
   * Resolves a relative path within this workspace.
   * Throws `WorkspacePathViolationError` if the path escapes the root directory
   * or traverses outside through a symlink/junction.
   */
  resolvePath(relativePath: string): string {
    const target = path.resolve(this.rootPath, relativePath);
    if (!isPathInside(this.rootPath, target)) {
      throw new WorkspacePathViolationError(relativePath, this.rootPath);
    }
    return target;
  }

  async read(relativePath: string): Promise<string> {
    const absPath = this.resolvePath(relativePath);
    return fs.promises.readFile(absPath, "utf-8");
  }

  async write(relativePath: string, content: string): Promise<void> {
    const absPath = this.resolvePath(relativePath);
    // Defense-in-depth: If file is already an existing symlink pointing outside, reject
    if (fs.existsSync(absPath)) {
      const realTarget = fs.realpathSync(absPath);
      if (!isPathInside(this.rootPath, realTarget)) {
        throw new WorkspacePathViolationError(relativePath, this.rootPath);
      }
    }
    await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
    await fs.promises.writeFile(absPath, content, "utf-8");
  }

  async list(relativePath: string = ""): Promise<string[]> {
    const absPath = this.resolvePath(relativePath);
    if (!fs.existsSync(absPath)) {
      return [];
    }
    const entries = await fs.promises.readdir(absPath);
    return entries;
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      const absPath = this.resolvePath(relativePath);
      return fs.existsSync(absPath);
    } catch (err) {
      if (err instanceof WorkspacePathViolationError) {
        return false;
      }
      throw err;
    }
  }

  async delete(relativePath: string): Promise<void> {
    const absPath = this.resolvePath(relativePath);
    if (fs.existsSync(absPath)) {
      await fs.promises.rm(absPath, { recursive: true, force: true });
    }
  }

  async mkdir(relativePath: string): Promise<void> {
    const absPath = this.resolvePath(relativePath);
    await fs.promises.mkdir(absPath, { recursive: true });
  }
}

// ─── In-Memory Workspace ─────────────────────────────────────────────────────

export interface InMemoryWorkspaceOptions {
  id?: string;
  rootPath?: string;
  initialFiles?: Record<string, string>;
}

/**
 * An ephemeral, fully in-memory workspace.
 * Ideal for lightweight sandboxing, unit tests, and scratchpads without touching disk.
 */
export class InMemoryWorkspace implements WorkspaceAdapter {
  readonly id: string;
  readonly rootPath: string;
  private files = new Map<string, string>();

  constructor(options: InMemoryWorkspaceOptions = {}) {
    this.id = options.id ?? generateId("ws_mem");
    this.rootPath = options.rootPath ?? "/virtual/workspace";

    if (options.initialFiles) {
      for (const [relPath, content] of Object.entries(options.initialFiles)) {
        this.writeSync(relPath, content);
      }
    }
  }

  private normalizeKey(relativePath: string): string {
    const normalized = path.posix.normalize(
      relativePath.replace(/\\/g, "/").replace(/^\/+/, "")
    );
    if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
      throw new WorkspacePathViolationError(relativePath, this.rootPath);
    }
    return normalized;
  }

  resolvePath(relativePath: string): string {
    const key = this.normalizeKey(relativePath);
    return path.posix.join(this.rootPath, key);
  }

  async read(relativePath: string): Promise<string> {
    const key = this.normalizeKey(relativePath);
    const content = this.files.get(key);
    if (content === undefined) {
      throw new Error(`ENOENT: no such file in memory workspace: "${relativePath}"`);
    }
    return content;
  }

  async write(relativePath: string, content: string): Promise<void> {
    this.writeSync(relativePath, content);
  }

  private writeSync(relativePath: string, content: string): void {
    const key = this.normalizeKey(relativePath);
    this.files.set(key, content);
  }

  async list(relativePath: string = ""): Promise<string[]> {
    const prefix = relativePath ? this.normalizeKey(relativePath) : "";
    const results = new Set<string>();

    for (const key of this.files.keys()) {
      if (!prefix) {
        const firstSegment = key.split("/")[0];
        results.add(firstSegment);
      } else if (key.startsWith(prefix + "/")) {
        const sub = key.slice(prefix.length + 1);
        const firstSegment = sub.split("/")[0];
        results.add(firstSegment);
      }
    }

    return Array.from(results).sort();
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      const key = this.normalizeKey(relativePath);
      if (this.files.has(key)) return true;
      for (const k of this.files.keys()) {
        if (k.startsWith(key + "/")) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  async delete(relativePath: string): Promise<void> {
    const key = this.normalizeKey(relativePath);
    this.files.delete(key);
    for (const k of Array.from(this.files.keys())) {
      if (k.startsWith(key + "/")) {
        this.files.delete(k);
      }
    }
  }
}

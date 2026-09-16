// ─── Filesystem Tools ────────────────────────────────────────────────────────
// Real filesystem tools using Node.js fs module. Includes read, write, list,
// exists, move, and delete operations with proper risk levels.

import * as fs from "fs/promises";
import * as path from "path";
import type { Tool, ToolContext } from "./index";

// ─── filesystem_read ─────────────────────────────────────────────────────────

function filesystemRead(): Tool {
  return {
    name: "filesystem_read",
    description:
      "Read the contents of a file. Returns the file content as text. Use this to inspect files, read documents, check configuration, etc.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path to the file to read",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    riskLevel: "LOW",
    async execute(
      input: Record<string, unknown>,
      _ctx: ToolContext
    ): Promise<string> {
      const filePath = String(input.path);
      try {
        const content = await fs.readFile(filePath, "utf-8");
        // Truncate very large files to avoid blowing up the LLM context
        if (content.length > 50_000) {
          return (
            content.slice(0, 50_000) +
            `\n\n[...truncated — file is ${content.length} characters total]`
          );
        }
        return content;
      } catch (err) {
        return `Error reading file: ${(err as Error).message}`;
      }
    },
  };
}

// ─── filesystem_write ────────────────────────────────────────────────────────

function filesystemWrite(): Tool {
  return {
    name: "filesystem_write",
    description:
      "Write content to a file. Creates the file and any missing parent directories if they don't exist. Overwrites existing content.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path to the file to write",
        },
        content: {
          type: "string",
          description: "The content to write to the file",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    riskLevel: "MEDIUM",
    async execute(
      input: Record<string, unknown>,
      _ctx: ToolContext
    ): Promise<string> {
      const filePath = String(input.path);
      const content = String(input.content);
      try {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content, "utf-8");
        return `Successfully wrote ${content.length} characters to ${filePath}`;
      } catch (err) {
        return `Error writing file: ${(err as Error).message}`;
      }
    },
  };
}

// ─── filesystem_list ─────────────────────────────────────────────────────────

function filesystemList(): Tool {
  return {
    name: "filesystem_list",
    description:
      "List the contents of a directory. Returns file and directory names with their types and sizes.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path to the directory to list",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    riskLevel: "LOW",
    async execute(
      input: Record<string, unknown>,
      _ctx: ToolContext
    ): Promise<string> {
      const dirPath = String(input.path);
      try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        const lines: string[] = [];

        for (const entry of entries) {
          const fullPath = path.join(dirPath, entry.name);
          if (entry.isDirectory()) {
            lines.push(`[DIR]  ${entry.name}/`);
          } else {
            try {
              const stat = await fs.stat(fullPath);
              const sizeStr = formatBytes(stat.size);
              lines.push(`[FILE] ${entry.name}  (${sizeStr})`);
            } catch {
              lines.push(`[FILE] ${entry.name}`);
            }
          }
        }

        if (lines.length === 0) return `Directory is empty: ${dirPath}`;
        return `Contents of ${dirPath}:\n${lines.join("\n")}`;
      } catch (err) {
        return `Error listing directory: ${(err as Error).message}`;
      }
    },
  };
}

// ─── filesystem_exists ───────────────────────────────────────────────────────

function filesystemExists(): Tool {
  return {
    name: "filesystem_exists",
    description:
      "Check whether a file or directory exists at the given path. Returns true/false and the type (file or directory).",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path to check",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    riskLevel: "LOW",
    async execute(
      input: Record<string, unknown>,
      _ctx: ToolContext
    ): Promise<string> {
      const filePath = String(input.path);
      try {
        const stat = await fs.stat(filePath);
        const type = stat.isDirectory() ? "directory" : "file";
        return `Exists: true, Type: ${type}, Size: ${formatBytes(stat.size)}`;
      } catch {
        return `Exists: false`;
      }
    },
  };
}

// ─── filesystem_move ─────────────────────────────────────────────────────────

function filesystemMove(): Tool {
  return {
    name: "filesystem_move",
    description:
      "Move or rename a file or directory from one path to another.",
    parameters: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description: "Absolute path of the source file or directory",
        },
        destination: {
          type: "string",
          description: "Absolute path of the destination",
        },
      },
      required: ["source", "destination"],
      additionalProperties: false,
    },
    riskLevel: "HIGH",
    async execute(
      input: Record<string, unknown>,
      _ctx: ToolContext
    ): Promise<string> {
      const src = String(input.source);
      const dest = String(input.destination);
      try {
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.rename(src, dest);
        return `Successfully moved ${src} → ${dest}`;
      } catch (err) {
        return `Error moving: ${(err as Error).message}`;
      }
    },
  };
}

// ─── filesystem_delete ───────────────────────────────────────────────────────

function filesystemDelete(): Tool {
  return {
    name: "filesystem_delete",
    description:
      "Delete a file or directory. For directories, this is recursive. This action is irreversible.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path to the file or directory to delete",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    riskLevel: "CRITICAL",
    async execute(
      input: Record<string, unknown>,
      _ctx: ToolContext
    ): Promise<string> {
      const filePath = String(input.path);
      try {
        const stat = await fs.stat(filePath);
        if (stat.isDirectory()) {
          await fs.rm(filePath, { recursive: true, force: true });
          return `Successfully deleted directory: ${filePath}`;
        } else {
          await fs.unlink(filePath);
          return `Successfully deleted file: ${filePath}`;
        }
      } catch (err) {
        return `Error deleting: ${(err as Error).message}`;
      }
    },
  };
}

// ─── Helper ──────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// ─── Export All Filesystem Tools ─────────────────────────────────────────────

/**
 * Returns all filesystem tools. Pass the result to ToolRegistry.registerAll().
 *
 * ```ts
 * registry.registerAll(filesystemTools());
 * ```
 */
export function filesystemTools(): Tool[] {
  return [
    filesystemRead(),
    filesystemWrite(),
    filesystemList(),
    filesystemExists(),
    filesystemMove(),
    filesystemDelete(),
  ];
}

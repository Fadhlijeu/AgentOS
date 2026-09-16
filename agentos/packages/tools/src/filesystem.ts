// ─── Filesystem Tools ────────────────────────────────────────────────────────
// Real filesystem tools using Node.js fs module or pluggable WorkspaceAdapter.
// Includes read, write, list, exists, move, and delete operations with runtime
// Zod validation, path confinement, and proper risk levels.

import * as fs from "fs/promises";
import * as path from "path";
import { z } from "zod";
import type { WorkspaceAdapter } from "@agentos/core";
import type { Tool, ToolContext } from "./index";

export interface FilesystemToolsOptions {
  /** Optional workspace jail. If provided, all operations route through the workspace. */
  workspace?: WorkspaceAdapter;
}

// ─── Schemas ─────────────────────────────────────────────────────────────────

export const filesystemReadSchema = z.object({
  path: z.string().min(1, "path is required"),
});

export const filesystemWriteSchema = z.object({
  path: z.string().min(1, "path is required"),
  content: z.string(),
});

export const filesystemListSchema = z.object({
  path: z.string().default("."),
});

export const filesystemExistsSchema = z.object({
  path: z.string().min(1, "path is required"),
});

export const filesystemMoveSchema = z.object({
  source: z.string().min(1, "source is required"),
  destination: z.string().min(1, "destination is required"),
});

export const filesystemDeleteSchema = z.object({
  path: z.string().min(1, "path is required"),
});

// ─── filesystem_read ─────────────────────────────────────────────────────────

function filesystemRead(workspace?: WorkspaceAdapter): Tool {
  return {
    name: "filesystem_read",
    description:
      "Read the contents of a file. Returns the file content as text. Use this to inspect files, read documents, check configuration, etc.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute or relative path to the file to read",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    schema: filesystemReadSchema,
    riskLevel: "LOW",
    async execute(
      input: Record<string, unknown>,
      _ctx: ToolContext
    ): Promise<string> {
      const parsed = filesystemReadSchema.safeParse(input);
      if (!parsed.success) {
        return `Validation Error: ${parsed.error.errors.map((e) => `${e.path.join(".") || "input"}: ${e.message}`).join(", ")}`;
      }

      const filePath = parsed.data.path;
      try {
        const content = workspace
          ? await workspace.read(filePath)
          : await fs.readFile(filePath, "utf-8");

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

function filesystemWrite(workspace?: WorkspaceAdapter): Tool {
  return {
    name: "filesystem_write",
    description:
      "Write content to a file. Creates the file and any missing parent directories if they don't exist. Overwrites existing content.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file to write",
        },
        content: {
          type: "string",
          description: "The content to write to the file",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    schema: filesystemWriteSchema,
    riskLevel: "MEDIUM",
    async execute(
      input: Record<string, unknown>,
      _ctx: ToolContext
    ): Promise<string> {
      const parsed = filesystemWriteSchema.safeParse(input);
      if (!parsed.success) {
        return `Validation Error: ${parsed.error.errors.map((e) => `${e.path.join(".") || "input"}: ${e.message}`).join(", ")}`;
      }

      const { path: filePath, content } = parsed.data;
      try {
        if (workspace) {
          await workspace.write(filePath, content);
        } else {
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          await fs.writeFile(filePath, content, "utf-8");
        }
        return `Successfully wrote ${content.length} characters to ${filePath}`;
      } catch (err) {
        return `Error writing file: ${(err as Error).message}`;
      }
    },
  };
}

// ─── filesystem_list ─────────────────────────────────────────────────────────

function filesystemList(workspace?: WorkspaceAdapter): Tool {
  return {
    name: "filesystem_list",
    description:
      "List the contents of a directory. Returns file and directory names with their types and sizes.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the directory to list (defaults to current directory)",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    schema: filesystemListSchema,
    riskLevel: "LOW",
    async execute(
      input: Record<string, unknown>,
      _ctx: ToolContext
    ): Promise<string> {
      const parsed = filesystemListSchema.safeParse(input);
      if (!parsed.success) {
        return `Validation Error: ${parsed.error.errors.map((e) => `${e.path.join(".") || "input"}: ${e.message}`).join(", ")}`;
      }

      const dirPath = parsed.data.path;
      try {
        if (workspace) {
          const entries = await workspace.list(dirPath === "." ? "" : dirPath);
          if (entries.length === 0) return `Directory is empty: ${dirPath}`;
          return `Contents of ${dirPath}:\n${entries.map((e) => `[ITEM] ${e}`).join("\n")}`;
        }

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

function filesystemExists(workspace?: WorkspaceAdapter): Tool {
  return {
    name: "filesystem_exists",
    description:
      "Check whether a file or directory exists at the given path. Returns true/false and the type (file or directory).",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to check",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    schema: filesystemExistsSchema,
    riskLevel: "LOW",
    async execute(
      input: Record<string, unknown>,
      _ctx: ToolContext
    ): Promise<string> {
      const parsed = filesystemExistsSchema.safeParse(input);
      if (!parsed.success) {
        return `Validation Error: ${parsed.error.errors.map((e) => `${e.path.join(".") || "input"}: ${e.message}`).join(", ")}`;
      }

      const filePath = parsed.data.path;
      try {
        if (workspace) {
          const exists = await workspace.exists(filePath);
          return `Exists: ${exists}`;
        }

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

function filesystemMove(workspace?: WorkspaceAdapter): Tool {
  return {
    name: "filesystem_move",
    description:
      "Move or rename a file or directory from one path to another.",
    parameters: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description: "Path of the source file or directory",
        },
        destination: {
          type: "string",
          description: "Path of the destination",
        },
      },
      required: ["source", "destination"],
      additionalProperties: false,
    },
    schema: filesystemMoveSchema,
    riskLevel: "HIGH",
    async execute(
      input: Record<string, unknown>,
      _ctx: ToolContext
    ): Promise<string> {
      const parsed = filesystemMoveSchema.safeParse(input);
      if (!parsed.success) {
        return `Validation Error: ${parsed.error.errors.map((e) => `${e.path.join(".") || "input"}: ${e.message}`).join(", ")}`;
      }

      const { source: src, destination: dest } = parsed.data;
      try {
        if (workspace) {
          const content = await workspace.read(src);
          await workspace.write(dest, content);
          await workspace.delete(src);
          return `Successfully moved ${src} → ${dest}`;
        }

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

function filesystemDelete(workspace?: WorkspaceAdapter): Tool {
  return {
    name: "filesystem_delete",
    description:
      "Delete a file or directory. For directories, this is recursive. This action is irreversible.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file or directory to delete",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    schema: filesystemDeleteSchema,
    riskLevel: "CRITICAL",
    async execute(
      input: Record<string, unknown>,
      _ctx: ToolContext
    ): Promise<string> {
      const parsed = filesystemDeleteSchema.safeParse(input);
      if (!parsed.success) {
        return `Validation Error: ${parsed.error.errors.map((e) => `${e.path.join(".") || "input"}: ${e.message}`).join(", ")}`;
      }

      const filePath = parsed.data.path;
      try {
        if (workspace) {
          await workspace.delete(filePath);
          return `Successfully deleted: ${filePath}`;
        }

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

export function filesystemTools(options?: FilesystemToolsOptions): Tool[] {
  const ws = options?.workspace;
  return [
    filesystemRead(ws),
    filesystemWrite(ws),
    filesystemList(ws),
    filesystemExists(ws),
    filesystemMove(ws),
    filesystemDelete(ws),
  ];
}

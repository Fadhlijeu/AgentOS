// ─── Command Parser & Sanitizer ─────────────────────────────────────────────
// Robust shell command parser that detects dangerous operators and tokenizes
// commands into safe executable + arguments vectors.

import * as path from "path";

export interface ParsedCommand {
  /** The extracted executable name (normalized, e.g. "git", "npm"). */
  executable: string;
  /** Full argument vector. */
  args: string[];
  /** Raw trimmed command string. */
  raw: string;
}

export interface ParseResult {
  ok: boolean;
  command?: ParsedCommand;
  error?: string;
}

// Shell chaining operators and dangerous metacharacters that allow command injection
const DANGEROUS_OPERATORS = [
  "&&",
  "||",
  ";",
  "|",
  "&",
  "`",
  "$(",
  ">",
  ">>",
  "<",
  "\n",
  "\r",
];

/**
 * Parses a shell command line string into a safe executable and argument vector.
 *
 * Rules:
 * 1. Detects and rejects dangerous chaining operators (&&, ;, |, ||, &, redirects, subshells).
 * 2. Correctly parses quoted strings ("double quotes" and 'single quotes').
 * 3. Normalizes executable name by stripping path and .exe suffix to prevent spoofing.
 */
export function parseCommand(commandStr: string): ParseResult {
  const trimmed = commandStr.trim();
  if (!trimmed) {
    return { ok: false, error: "Command string is empty" };
  }

  // Check for dangerous operators
  for (const op of DANGEROUS_OPERATORS) {
    if (trimmed.includes(op)) {
      return {
        ok: false,
        error: `Security violation: Shell operator "${op}" is prohibited. Only single, unchained commands are permitted.`,
      };
    }
  }

  // Tokenize with quote awareness
  const tokens: string[] = [];
  let currentToken = "";
  let inDoubleQuote = false;
  let inSingleQuote = false;
  let isEscaped = false;

  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];

    if (isEscaped) {
      currentToken += char;
      isEscaped = false;
      continue;
    }

    if (char === "\\") {
      isEscaped = true;
      continue;
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (/\s/.test(char) && !inDoubleQuote && !inSingleQuote) {
      if (currentToken.length > 0) {
        tokens.push(currentToken);
        currentToken = "";
      }
      continue;
    }

    currentToken += char;
  }

  if (inDoubleQuote || inSingleQuote) {
    return {
      ok: false,
      error: "Malformed command: Unmatched quotes in command line",
    };
  }

  if (currentToken.length > 0) {
    tokens.push(currentToken);
  }

  if (tokens.length === 0) {
    return { ok: false, error: "Command contains no executable tokens" };
  }

  const rawExec = tokens[0];
  const args = tokens.slice(1);

  // Normalize executable:
  // Strip path prefix (/usr/bin/git or C:\git\git.exe -> git)
  // Strip .exe, .cmd, .bat suffixes
  const baseName = path.basename(rawExec);
  const normalizedExec = baseName
    .replace(/\.(exe|cmd|bat)$/i, "")
    .toLowerCase();

  return {
    ok: true,
    command: {
      executable: normalizedExec,
      args,
      raw: trimmed,
    },
  };
}

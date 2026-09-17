// ─── Secret Redactor ─────────────────────────────────────────────────────────
// Deep-clones and sanitizes objects before event emission, trace storage,
// and approval UI display. The original unredacted data is used for actual
// tool execution — only observable outputs (events, SQLite, traces) are sanitized.
//
// Audit 0.4 §6: "tool.requested" and "approval.required" events were emitting
// raw secrets (Authorization headers, API keys, etc.) to SQLite.

/** The placeholder used for redacted values. */
const REDACTED = "[REDACTED]";

/**
 * Header/key names that should always be redacted (case-insensitive match).
 * Covers common HTTP auth headers, API keys, tokens, and passwords.
 */
const SENSITIVE_KEYS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "api_key",
  "apikey",
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "secret",
  "client_secret",
  "password",
  "passwd",
  "private_key",
  "privatekey",
  "credentials",
]);

/**
 * Suffix patterns — keys ending with these are also considered sensitive.
 */
const SENSITIVE_SUFFIXES = [
  "_token",
  "_secret",
  "_key",
  "_password",
  "_credentials",
];

/**
 * Value patterns that indicate a secret even if the key name is innocuous.
 */
const SENSITIVE_VALUE_PATTERNS = [
  /^Bearer\s+\S+/i,
  /^Basic\s+\S+/i,
  /^ghp_[A-Za-z0-9]+/,       // GitHub personal access token
  /^sk-[A-Za-z0-9_-]+/,      // OpenAI API key
  /^xoxb-[A-Za-z0-9-]+/,     // Slack bot token
  /^AIza[A-Za-z0-9_-]+/,     // Google API key
];

/**
 * Patterns for inline scrubbing within string content (logs, tool results, HTTP responses).
 */
const INLINE_SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, replacement: "Bearer [REDACTED]" },
  { pattern: /Basic\s+[A-Za-z0-9+/=]+/gi, replacement: "Basic [REDACTED]" },
  { pattern: /sk-[A-Za-z0-9_-]{15,}/g, replacement: "[REDACTED_API_KEY]" },
  { pattern: /ghp_[A-Za-z0-9]{20,}/g, replacement: "[REDACTED_TOKEN]" },
  { pattern: /xoxb-[A-Za-z0-9-]+/g, replacement: "[REDACTED_TOKEN]" },
  { pattern: /AIza[0-9A-Za-z-_]{35}/g, replacement: "[REDACTED_KEY]" },
];

/**
 * Check whether a key name matches a known sensitive pattern.
 */
function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (SENSITIVE_KEYS.has(lower)) return true;
  if (
    lower.endsWith("token") ||
    lower.endsWith("secret") ||
    lower.endsWith("key") ||
    lower.endsWith("password") ||
    lower.endsWith("passwd") ||
    lower.endsWith("credential") ||
    lower.endsWith("credentials")
  ) {
    return true;
  }
  return SENSITIVE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/**
 * Check whether a string value matches a known secret pattern.
 */
function isSensitiveValue(value: string): boolean {
  return SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Sanitize a string by checking for exact secret values, parsing JSON if applicable,
 * or scrubbing embedded sensitive tokens.
 */
export function sanitizeString(value: string): string {
  if (isSensitiveValue(value)) return REDACTED;

  const trimmed = value.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      const parsed = JSON.parse(trimmed);
      const sanitized = redactSecrets(parsed);
      return JSON.stringify(sanitized, null, 2);
    } catch {
      // Not valid JSON, proceed to inline regex replacement
    }
  }

  let result = value;
  for (const { pattern, replacement } of INLINE_SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * Deep-clone and redact sensitive values from an object or string.
 * Returns a new object — the original is never mutated.
 *
 * @param obj - The input object (typically tool arguments or event data)
 * @returns A deep-cloned copy with sensitive values replaced by "[REDACTED]"
 */
export function redactSecrets<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === "string") {
    return sanitizeString(obj) as unknown as T;
  }

  if (typeof obj !== "object") return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => redactSecrets(item)) as unknown as T;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      result[key] = REDACTED;
    } else if (typeof value === "string") {
      result[key] = isSensitiveValue(value) ? REDACTED : sanitizeString(value);
    } else if (typeof value === "object" && value !== null) {
      result[key] = redactSecrets(value);
    } else {
      result[key] = value;
    }
  }

  return result as T;
}

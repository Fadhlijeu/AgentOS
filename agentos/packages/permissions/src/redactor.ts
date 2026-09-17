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
  /^sk-[A-Za-z0-9]+/,        // OpenAI API key
  /^xoxb-[A-Za-z0-9-]+/,     // Slack bot token
  /^AIza[A-Za-z0-9_-]+/,     // Google API key
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
 * Deep-clone and redact sensitive values from an object.
 * Returns a new object — the original is never mutated.
 *
 * @param obj - The input object (typically tool arguments or event data)
 * @returns A deep-cloned copy with sensitive values replaced by "[REDACTED]"
 */
export function redactSecrets<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === "string") {
    if (isSensitiveValue(obj)) return REDACTED as unknown as T;
    return obj;
  }

  if (typeof obj !== "object") return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => redactSecrets(item)) as unknown as T;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      result[key] = REDACTED;
    } else if (typeof value === "string" && isSensitiveValue(value)) {
      result[key] = REDACTED;
    } else if (typeof value === "object" && value !== null) {
      result[key] = redactSecrets(value);
    } else {
      result[key] = value;
    }
  }

  return result as T;
}

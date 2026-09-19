// ─── HTTP / API Tool ─────────────────────────────────────────────────────────
// Enables AI agents to interact with REST APIs, fetch web content, and query
// external services with timeout enforcement, AbortSignal propagation, and Zod validation.

import { z } from "zod";
import { validateHostIpSafety } from "@agentos/permissions";
import type { Tool, ToolContext } from "./index";

export const httpRequestSchema = z.object({
  url: z.string().url("Must be a valid URL starting with http:// or https://"),
  method: z
    .enum(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"])
    .optional()
    .default("GET"),
  headers: z.record(z.string()).optional(),
  body: z.union([z.string(), z.record(z.unknown())]).optional(),
  timeout: z.number().positive().optional().default(30_000),
});

export type HttpRequestInput = z.infer<typeof httpRequestSchema>;

export interface HttpToolOptions {
  allowPrivateNetworks?: boolean;
  allowOrigins?: string[];
  denyOrigins?: string[];
  permissionValidator?: (
    url: string
  ) =>
    | Promise<boolean | { allowed: boolean; reason?: string }>
    | boolean
    | { allowed: boolean; reason?: string };
}

function httpRequest(options?: HttpToolOptions): Tool {
  return {
    name: "http_request",
    description:
      "Make an HTTP/HTTPS network request to fetch web pages, call REST APIs, or interact with web services. " +
      "Supports GET, POST, PUT, DELETE, PATCH, custom headers, and request bodies.",
    category: "http",
    capability: "network.request",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The full HTTP/HTTPS URL to request",
        },
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"],
          description: "HTTP method (default: GET)",
        },
        headers: {
          type: "object",
          description: "Optional key-value HTTP headers",
        },
        body: {
          type: ["string", "object"],
          description: "Optional request body (string or JSON object)",
        },
        timeout: {
          type: "number",
          description: "Request timeout in milliseconds (default: 30000)",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
    schema: httpRequestSchema,
    riskLevel: "MEDIUM",
    async execute(
      input: Record<string, unknown>,
      ctx: ToolContext
    ): Promise<string> {
      // 1. Schema validation
      const parsed = httpRequestSchema.safeParse(input);
      if (!parsed.success) {
        return `Validation Error: ${parsed.error.errors
          .map((e) => `${e.path.join(".") || "input"}: ${e.message}`)
          .join(", ")}`;
      }

      const { url, method, headers = {}, body, timeout } = parsed.data;

      // 2. Cancellation check
      if (ctx.signal?.aborted) {
        return "Error: Request aborted by cancellation signal";
      }

      // 3. Setup timeout and abort controller
      const controller = new AbortController();
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeout);

      const onExternalAbort = () => {
        controller.abort();
      };

      if (ctx.signal) {
        ctx.signal.addEventListener("abort", onExternalAbort, { once: true });
      }

      try {
        let reqBody: string | undefined;
        const reqHeaders: Record<string, string> = { ...headers };

        if (body !== undefined) {
          if (typeof body === "string") {
            reqBody = body;
          } else {
            reqBody = JSON.stringify(body);
            if (!reqHeaders["Content-Type"]) {
              reqHeaders["Content-Type"] = "application/json";
            }
          }
        }

        // P0-3: Manual redirect handling with SSRF & DNS safety validation at each hop
        let currentUrl = url;
        let currentMethod = method;
        let currentBody = method === "GET" || method === "HEAD" ? undefined : reqBody;
        let currentHeaders: Record<string, string> = { ...reqHeaders };
        let response: Response;
        let redirectCount = 0;
        const MAX_REDIRECTS = 5;

        // Policy precedence: Explicit option takes priority, no uncontrolled env override of explicit deny
        const allowPrivate = options?.allowPrivateNetworks === true;
        while (true) {
          const parsedTarget = new URL(currentUrl);

          // P0-Audit10: Validate against central permissionValidator or ctx.networkValidator or options
          if (options?.permissionValidator) {
            const res: any = await options.permissionValidator(currentUrl);
            const allowed = typeof res === "boolean" ? res : Boolean(res?.allowed);
            if (!allowed) {
              const reason = res && typeof res === "object" && res.reason ? res.reason : "URL blocked by policy";
              throw new Error(`Security policy violation: HTTP request to "${currentUrl}" is restricted (${reason}).`);
            }
          } else if (ctx?.networkValidator) {
            const res = await ctx.networkValidator(currentUrl);
            const allowed = typeof res === "boolean" ? res : Boolean((res as any)?.allowed ?? res);
            if (!allowed) {
              throw new Error(`Security policy violation: HTTP request to "${currentUrl}" is restricted.`);
            }
          } else {
            if (options?.denyOrigins && options.denyOrigins.length > 0) {
              const curOrigin = parsedTarget.origin.toLowerCase();
              const isDenied = options.denyOrigins.some(
                (d) => d.toLowerCase().replace(/\/$/, "") === curOrigin
              );
              if (isDenied) {
                throw new Error(`Security policy violation: HTTP request to denied origin "${curOrigin}".`);
              }
            }
            if (options?.allowOrigins && options.allowOrigins.length > 0) {
              const curOrigin = parsedTarget.origin.toLowerCase();
              const isAllowed = options.allowOrigins.some(
                (a) => a === "*" || a.toLowerCase().replace(/\/$/, "") === curOrigin
              );
              if (!isAllowed) {
                throw new Error(`Security policy violation: HTTP request to untrusted origin "${curOrigin}" not in allowOrigins.`);
              }
            }
          }

          if (!allowPrivate) {
            const isSafe = await validateHostIpSafety(parsedTarget.hostname);
            if (!isSafe) {
              throw new Error(
                `SSRF protection: HTTP request to internal/private IP address "${parsedTarget.hostname}" is blocked.`
              );
            }
          }

          response = await fetch(currentUrl, {
            method: currentMethod,
            headers: currentHeaders,
            body: currentBody,
            signal: controller.signal,
            redirect: "manual",
          });

          // Check for HTTP redirect status codes (301, 302, 303, 307, 308)
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get("location");
            if (!location) {
              break;
            }

            redirectCount++;
            if (redirectCount > MAX_REDIRECTS) {
              throw new Error(`Too many redirects (exceeded limit of ${MAX_REDIRECTS})`);
            }

            const nextUrl = new URL(location, currentUrl).href;
            const nextParsed = new URL(nextUrl);

            if (nextParsed.protocol !== "http:" && nextParsed.protocol !== "https:") {
              throw new Error(`SSRF protection: Redirect to forbidden protocol "${nextParsed.protocol}" blocked.`);
            }

            // P0-Audit10: Enforce origin allow/deny policy and central validator on EVERY redirect hop
            if (options?.permissionValidator) {
              const res: any = await options.permissionValidator(nextUrl);
              const allowed = typeof res === "boolean" ? res : Boolean(res?.allowed);
              if (!allowed) {
                const reason = res && typeof res === "object" && res.reason ? res.reason : "URL blocked by policy";
                throw new Error(`Security policy violation: HTTP redirect to "${nextUrl}" is restricted (${reason}).`);
              }
            } else if (ctx?.networkValidator) {
              const res = await ctx.networkValidator(nextUrl);
              const allowed = typeof res === "boolean" ? res : Boolean((res as any)?.allowed ?? res);
              if (!allowed) {
                throw new Error(`Security policy violation: HTTP redirect to "${nextUrl}" is restricted.`);
              }
            } else {
              // Direct origin check against options if no central validator is wired
              if (options?.denyOrigins && options.denyOrigins.length > 0) {
                const nextOrigin = nextParsed.origin.toLowerCase();
                const isDenied = options.denyOrigins.some(
                  (d) => d.toLowerCase().replace(/\/$/, "") === nextOrigin
                );
                if (isDenied) {
                  throw new Error(`Security policy violation: HTTP redirect to denied origin "${nextOrigin}".`);
                }
              }
              if (options?.allowOrigins && options.allowOrigins.length > 0) {
                const nextOrigin = nextParsed.origin.toLowerCase();
                const isAllowed = options.allowOrigins.some(
                  (a) => a === "*" || a.toLowerCase().replace(/\/$/, "") === nextOrigin
                );
                if (!isAllowed) {
                  throw new Error(`Security policy violation: HTTP redirect to untrusted origin "${nextOrigin}" not in allowOrigins.`);
                }
              }
            }

            if (!allowPrivate) {
              const nextSafe = await validateHostIpSafety(nextParsed.hostname);
              if (!nextSafe) {
                throw new Error(
                  `SSRF protection: Redirect to internal/private address "${nextParsed.hostname}" is blocked.`
                );
              }
            }

            // P0-Audit08: Cross-origin credential & sensitive header stripping
            const currentParsed = new URL(currentUrl);
            const isCrossOrigin = currentParsed.origin.toLowerCase() !== nextParsed.origin.toLowerCase();
            if (isCrossOrigin) {
              const sensitiveHeaders = [
                "authorization",
                "cookie",
                "proxy-authorization",
                "x-api-key",
              ];
              const safeHeaders: Record<string, string> = {};
              for (const [k, v] of Object.entries(currentHeaders)) {
                if (!sensitiveHeaders.includes(k.toLowerCase())) {
                  safeHeaders[k] = v;
                }
              }
              currentHeaders = safeHeaders;
            }

            // P0-Audit08: Standard redirect method transformation & body dropping
            // 303: Always convert to GET and drop body
            // 301/302: When originating from POST, convert to GET and drop body
            if (
              response.status === 303 ||
              ((response.status === 301 || response.status === 302) && currentMethod === "POST")
            ) {
              currentMethod = "GET";
              currentBody = undefined;
              const nonContentHeaders: Record<string, string> = {};
              for (const [k, v] of Object.entries(currentHeaders)) {
                if (k.toLowerCase() !== "content-type" && k.toLowerCase() !== "content-length") {
                  nonContentHeaders[k] = v;
                }
              }
              currentHeaders = nonContentHeaders;
            }

            currentUrl = nextUrl;
            continue;
          }

          break;
        }

        clearTimeout(timer);
        if (ctx.signal) {
          ctx.signal.removeEventListener("abort", onExternalAbort);
        }

        const contentType = response.headers.get("content-type") || "";
        let responseBody: string;

        if (contentType.includes("application/json")) {
          try {
            const json = await response.json();
            responseBody = JSON.stringify(json, null, 2);
          } catch {
            responseBody = await response.text();
          }
        } else {
          responseBody = await response.text();
        }

        // Format result
        const parts: string[] = [
          `HTTP ${response.status} ${response.statusText}`,
          `URL: ${currentUrl}`,
        ];

        if (responseBody.trim()) {
          const bodyText = responseBody.trim();
          if (bodyText.length > 30_000) {
            parts.push(
              `Response Body:\n${bodyText.slice(0, 30_000)}\n\n[...truncated — output is ${bodyText.length} characters total]`
            );
          } else {
            parts.push(`Response Body:\n${bodyText}`);
          }
        } else {
          parts.push("(empty response body)");
        }

        return parts.join("\n\n");
      } catch (err: any) {
        clearTimeout(timer);
        if (ctx.signal) {
          ctx.signal.removeEventListener("abort", onExternalAbort);
        }

        if (timedOut) {
          return `Error: HTTP request timed out after ${timeout}ms`;
        }
        if (ctx.signal?.aborted || err.name === "AbortError") {
          return "Error: Request aborted by cancellation signal";
        }
        return `HTTP Request Error: ${err.message}`;
      }
    },
  };
}

export function httpTools(options?: HttpToolOptions): Tool[] {
  return [httpRequest(options)];
}

// ─── HTTP / API Tool ─────────────────────────────────────────────────────────
// Enables AI agents to interact with REST APIs, fetch web content, and query
// external services with timeout enforcement, AbortSignal propagation, and Zod validation.

import { z } from "zod";
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

function httpRequest(): Tool {
  return {
    name: "http_request",
    description:
      "Make an HTTP/HTTPS network request to fetch web pages, call REST APIs, or interact with web services. " +
      "Supports GET, POST, PUT, DELETE, PATCH, custom headers, and request bodies.",
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

        const response = await fetch(url, {
          method,
          headers: reqHeaders,
          body: method === "GET" || method === "HEAD" ? undefined : reqBody,
          signal: controller.signal,
        });

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
          `URL: ${url}`,
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

export function httpTools(): Tool[] {
  return [httpRequest()];
}

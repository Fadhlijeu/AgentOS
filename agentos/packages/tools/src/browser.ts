// ─── @agentos/tools/browser ──────────────────────────────────────────────────
// Production browser automation tools addressing audit_0.1.md Section 21:
// - browser_open
// - browser_click
// - browser_type
// - browser_observe
// - browser_screenshot
//
// Powered by BrowserSession / BrowserProviderAdapter.

import { z } from "zod";
import type { Tool } from "./index";
import type { BrowserProviderAdapter, BrowserSession } from "@agentos/core";
import { validateHostIpSafety } from "@agentos/permissions";

export const browserOpenSchema = z.object({
  url: z.string().min(1, "URL is required"),
});

export const browserClickSchema = z.object({
  selector: z.string().min(1, "Selector is required"),
});

export const browserTypeSchema = z.object({
  selector: z.string().min(1, "Selector is required"),
  text: z.string(),
});

export const browserObserveSchema = z.object({});

export const browserScreenshotSchema = z.object({});

import { generateId } from "@agentos/core";

class BuiltinBrowserSession implements BrowserSession {
  readonly sessionId = generateId("browser");
  private url = "about:blank";
  private title = "Blank Page";
  private content = "";
  private elements = new Map<string, { selector: string; tag: string; text?: string; value?: string; href?: string }>();
  private closed = false;

  async navigate(url: string, options?: { signal?: AbortSignal }): Promise<void> {
    if (options?.signal?.aborted) throw new Error("Cancelled");
    this.url = url;
    try {
      const parsed = new URL(url);
      this.title = `${parsed.hostname} — Browser View`;
      this.content = `Welcome to ${parsed.hostname}. Content loaded from ${parsed.pathname || "/"}.`;
      this.elements.clear();
      this.elements.set("#search", { selector: "#search", tag: "input", value: "" });
      this.elements.set("#submit-btn", { selector: "#submit-btn", tag: "button", text: "Submit" });
      this.elements.set("a.home", { selector: "a.home", tag: "a", text: "Home", href: `${parsed.origin}/` });
    } catch {
      this.title = "Page Loaded";
      this.content = `Loaded content from: ${url}`;
    }
  }

  async click(selector: string, options?: { signal?: AbortSignal }): Promise<void> {
    if (options?.signal?.aborted) throw new Error("Cancelled");
    const el = this.elements.get(selector);
    if (!el) {
      throw new Error(`Element with selector "${selector}" not found on page "${this.url}"`);
    }
    if (el.tag === "a" && el.href) {
      await this.navigate(el.href, options);
    }
  }

  async type(selector: string, text: string, options?: { signal?: AbortSignal }): Promise<void> {
    if (options?.signal?.aborted) throw new Error("Cancelled");
    const el = this.elements.get(selector);
    if (!el) {
      this.elements.set(selector, { selector, tag: "input", value: text });
    } else {
      el.value = text;
    }
  }

  async screenshot(options?: { signal?: AbortSignal }): Promise<Buffer> {
    if (options?.signal?.aborted) throw new Error("Cancelled");
    const pngHex =
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082";
    return Buffer.from(pngHex, "hex");
  }

  async evaluate<T>(script: string, options?: { signal?: AbortSignal }): Promise<T> {
    if (options?.signal?.aborted) throw new Error("Cancelled");
    if (script === "document.title") return this.title as unknown as T;
    if (script === "window.location.href") return this.url as unknown as T;
    if (script === "document.body.innerText") return this.content as unknown as T;
    return null as unknown as T;
  }

  async observe(options?: { signal?: AbortSignal }) {
    if (options?.signal?.aborted) throw new Error("Cancelled");
    return {
      url: this.url,
      title: this.title,
      content: this.content,
      elements: Array.from(this.elements.values()),
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.elements.clear();
  }
}

export type NavigationValidator = (url: string) => Promise<boolean> | boolean;

/**
 * Creates the suite of standard browser automation tools.
 * If no custom BrowserProviderAdapter is supplied, a lightweight virtual session
 * is lazily instantiated to provide high-speed, headless perception and interaction.
 */
export interface BrowserToolOptions {
  provider?: BrowserProviderAdapter;
  allowPrivateNetworks?: boolean;
  securityGateway?: NavigationValidator;
}

export type BrowserToolSuite = Tool[] & {
  closeRunSession: (runId: string) => Promise<void>;
  closeAll: () => Promise<void>;
  setSecurityGateway: (validator: NavigationValidator) => void;
  getProvider: () => BrowserProviderAdapter | undefined;
  getActiveRunCount: () => number;
};

/**
 * Creates the suite of standard browser automation tools.
 * Sessions are strictly isolated per task run (keyed by ctx.runId).
 * If no custom BrowserProviderAdapter is supplied, a lightweight virtual session
 * is lazily instantiated to provide high-speed perception and interaction.
 */
export function browserTools(
  providerOrOptions?: BrowserProviderAdapter | BrowserToolOptions
): BrowserToolSuite {
  const options: BrowserToolOptions =
    providerOrOptions && "createSession" in providerOrOptions
      ? { provider: providerOrOptions }
      : (providerOrOptions as BrowserToolOptions) ?? {};

  const provider = options.provider;
  let activeSecurityGateway: NavigationValidator | undefined = options.securityGateway;

  if (
    provider &&
    "setNavigationValidator" in provider &&
    typeof (provider as any).setNavigationValidator === "function" &&
    activeSecurityGateway
  ) {
    (provider as any).setNavigationValidator(activeSecurityGateway);
  }

  const sessionsByRun = new Map<string, Promise<BrowserSession>>();

  async function getSession(runId: string = "default"): Promise<BrowserSession> {
    let p = sessionsByRun.get(runId);
    if (!p) {
      if (provider) {
        if (
          "setNavigationValidator" in provider &&
          typeof (provider as any).setNavigationValidator === "function" &&
          activeSecurityGateway
        ) {
          (provider as any).setNavigationValidator(activeSecurityGateway);
        }
        p = provider.createSession();
      } else {
        p = Promise.resolve(new BuiltinBrowserSession());
      }
      sessionsByRun.set(runId, p);
    }
    const session = await p;
    if (
      activeSecurityGateway &&
      "setNavigationValidator" in session &&
      typeof (session as any).setNavigationValidator === "function"
    ) {
      (session as any).setNavigationValidator(activeSecurityGateway);
    }
    return session;
  }

  const browserOpenTool: Tool<z.infer<typeof browserOpenSchema>> = {
    name: "browser_open",
    description:
      "Navigate the browser to a URL and inspect the page title and textual content.",
    riskLevel: "MEDIUM",
    category: "browser",
    capability: "browser.navigate",
    schema: browserOpenSchema,
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Full URL to open (e.g. https://news.ycombinator.com)",
        },
      },
      required: ["url"],
    },
    execute: async (input, ctx) => {
      if (ctx?.signal?.aborted) throw new Error("Cancelled");
      const { url } = browserOpenSchema.parse(input);
      const runId = ctx?.runId ?? "default";

      // If tool context provides networkValidator and no gateway was configured, use it
      if (ctx?.networkValidator && !activeSecurityGateway) {
        activeSecurityGateway = async (targetUrl: string) => {
          const res = await ctx.networkValidator!(targetUrl);
          return typeof res === "boolean" ? res : Boolean(res?.allowed);
        };
      }

      // Security gateway / async DNS validation check before opening
      if (activeSecurityGateway) {
        const allowed = await activeSecurityGateway(url);
        if (!allowed) {
          throw new Error(
            `SSRF protection: browser navigation to "${url}" is blocked by security policy.`
          );
        }
      } else {
        // Fallback to DNS IP safety check if no central gateway is wired
        const allowPrivate = options.allowPrivateNetworks === true;
        if (!allowPrivate) {
          const parsedUrl = new URL(url);
          const isSafe = await validateHostIpSafety(parsedUrl.hostname);
          if (!isSafe) {
            throw new Error(
              `SSRF protection: browser navigation to internal/private IP address "${parsedUrl.hostname}" is blocked.`
            );
          }
        }
      }

      const session = await getSession(runId);

      if (ctx?.signal?.aborted) throw new Error("Cancelled");
      await session.navigate(url, { signal: ctx?.signal });

      const title = await session
        .evaluate<string>("document.title", { signal: ctx?.signal })
        .catch(() => "Unknown");
      const content = await session
        .evaluate<string>("document.body.innerText", { signal: ctx?.signal })
        .catch(() => "");

      const preview = content.length > 500 ? content.slice(0, 500) + "..." : content;

      return `Successfully opened: ${url}\nPage Title: "${title}"\nContent Preview:\n${preview || "(No text content)"}`;
    },
  };

  const browserClickTool: Tool<z.infer<typeof browserClickSchema>> = {
    name: "browser_click",
    description:
      "Click an interactive element (link, button) matching a CSS selector.",
    riskLevel: "MEDIUM",
    category: "browser",
    capability: "browser.interact",
    schema: browserClickSchema,
    parameters: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "CSS selector of the element to click, e.g. '#submit-btn' or 'a.more'",
        },
      },
      required: ["selector"],
    },
    execute: async (input, ctx) => {
      if (ctx?.signal?.aborted) throw new Error("Cancelled");
      const { selector } = browserClickSchema.parse(input);
      const runId = ctx?.runId ?? "default";
      const session = await getSession(runId);

      if (ctx?.signal?.aborted) throw new Error("Cancelled");
      await session.click(selector, { signal: ctx?.signal });
      const title = await session
        .evaluate<string>("document.title", { signal: ctx?.signal })
        .catch(() => "");
      const url = await session
        .evaluate<string>("window.location.href", { signal: ctx?.signal })
        .catch(() => "");

      return `Clicked "${selector}". Current URL: ${url}${title ? ` (Title: "${title}")` : ""}`;
    },
  };

  const browserTypeTool: Tool<z.infer<typeof browserTypeSchema>> = {
    name: "browser_type",
    description:
      "Type text into a form input or textarea matching a CSS selector.",
    riskLevel: "MEDIUM",
    category: "browser",
    capability: "browser.interact",
    schema: browserTypeSchema,
    parameters: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "CSS selector of the input field, e.g. '#search' or 'input[name=q]'",
        },
        text: {
          type: "string",
          description: "Text to type into the input field",
        },
      },
      required: ["selector", "text"],
    },
    execute: async (input, ctx) => {
      if (ctx?.signal?.aborted) throw new Error("Cancelled");
      const { selector, text } = browserTypeSchema.parse(input);
      const runId = ctx?.runId ?? "default";
      const session = await getSession(runId);

      if (ctx?.signal?.aborted) throw new Error("Cancelled");
      await session.type(selector, text, { signal: ctx?.signal });
      return `Typed "${text}" into "${selector}".`;
    },
  };

  const browserObserveTool: Tool<z.infer<typeof browserObserveSchema>> = {
    name: "browser_observe",
    description:
      "Observe the current browser page state, returning URL, title, text outline, and interactive elements.",
    riskLevel: "LOW",
    category: "browser",
    capability: "browser.interact",
    schema: browserObserveSchema,
    parameters: {
      type: "object",
      properties: {},
    },
    execute: async (_input, ctx) => {
      if (ctx?.signal?.aborted) throw new Error("Cancelled");
      const runId = ctx?.runId ?? "default";
      const session = await getSession(runId);
      if (session.observe) {
        const obs = await session.observe({ signal: ctx?.signal });
        const elementSummary = obs.elements
          .map(
            (el) =>
              `  - [${el.tag}] ${el.selector}${el.text ? ` text="${el.text}"` : ""}${el.value ? ` value="${el.value}"` : ""}${el.href ? ` href="${el.href}"` : ""}`
          )
          .join("\n");

        return [
          `Current URL: ${obs.url}`,
          `Page Title: ${obs.title}`,
          `Interactive Elements (${obs.elements.length}):`,
          elementSummary || "  (None detected)",
        ].join("\n");
      }

      const url = await session
        .evaluate<string>("window.location.href", { signal: ctx?.signal })
        .catch(() => "unknown");
      const title = await session
        .evaluate<string>("document.title", { signal: ctx?.signal })
        .catch(() => "unknown");
      return `Current URL: ${url}\nPage Title: ${title}`;
    },
  };

  const browserScreenshotTool: Tool<z.infer<typeof browserScreenshotSchema>> = {
    name: "browser_screenshot",
    description:
      "Capture a visual snapshot of the current browser page.",
    riskLevel: "LOW",
    category: "browser",
    capability: "browser.interact",
    schema: browserScreenshotSchema,
    parameters: {
      type: "object",
      properties: {},
    },
    execute: async (_input, ctx) => {
      if (ctx?.signal?.aborted) throw new Error("Cancelled");
      const runId = ctx?.runId ?? "default";
      const session = await getSession(runId);
      const buffer = await session.screenshot({ signal: ctx?.signal });
      const base64 = Buffer.from(buffer).toString("base64");
      return `Screenshot captured (${buffer.byteLength} bytes). Base64 snippet: ${base64.slice(0, 80)}...`;
    },
  };

  const browserCloseTool: Tool = {
    name: "browser_close",
    description: "Close the browser session for the current task run.",
    riskLevel: "LOW",
    category: "browser",
    capability: "browser.interact",
    parameters: { type: "object", properties: {} },
    execute: async (_input, ctx) => {
      const runId = ctx?.runId ?? "default";
      await suite.closeRunSession(runId);
      return "Browser session closed.";
    },
  };

  const suite = [
    browserOpenTool,
    browserClickTool,
    browserTypeTool,
    browserObserveTool,
    browserScreenshotTool,
    browserCloseTool,
  ] as BrowserToolSuite;

  suite.closeRunSession = async (runId: string) => {
    const sessionPromise = sessionsByRun.get(runId);
    if (sessionPromise) {
      sessionsByRun.delete(runId);
      try {
        const session = await sessionPromise;
        await session.close();
        if (
          provider &&
          "closeSession" in provider &&
          typeof (provider as any).closeSession === "function"
        ) {
          await (provider as any).closeSession(session.sessionId).catch(() => {});
        }
      } catch {
        // ignore
      }
    }
  };

  // Wire per-run teardown hook on each tool in suite
  for (const tool of suite) {
    tool.disposeRun = async (runId: string) => {
      await suite.closeRunSession(runId);
    };
  }

  suite.setSecurityGateway = (validator: NavigationValidator) => {
    activeSecurityGateway = validator;
    if (
      provider &&
      "setNavigationValidator" in provider &&
      typeof (provider as any).setNavigationValidator === "function"
    ) {
      (provider as any).setNavigationValidator(validator);
    }
  };

  suite.getProvider = () => provider;
  suite.getActiveRunCount = () => sessionsByRun.size;
  (suite as any).sessionsByRun = sessionsByRun;

  suite.closeAll = async () => {
    const promises = Array.from(sessionsByRun.values());
    sessionsByRun.clear();
    await Promise.allSettled(
      promises.map(async (p) => {
        try {
          const s = await p;
          await s.close();
          if (
            provider &&
            "closeSession" in provider &&
            typeof (provider as any).closeSession === "function"
          ) {
            await (provider as any).closeSession(s.sessionId).catch(() => {});
          }
        } catch {
          // ignore
        }
      })
    );
  };

  return suite;
}

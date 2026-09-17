// ─── @agentos/adapters/playwright-browser ────────────────────────────────────
// Real browser automation session and provider driven by playwright-core.
// Connects to local Chrome / Edge or standard Chromium channels to execute
// real web navigation, DOM inspection, form interactions, and screenshots.

import * as fs from "fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { generateId } from "@agentos/core";
import type { BrowserSession, BrowserProviderAdapter } from "./index";

export interface PlaywrightBrowserOptions {
  headless?: boolean;
  channel?: "chrome" | "msedge" | "chromium";
  executablePath?: string;
  viewport?: { width: number; height: number };
  timeoutMs?: number;
  /**
   * Whether to disable the Chromium sandbox.
   * Default: false (sandbox ENABLED for security).
   * Set to true only in CI/container environments where sandbox cannot run.
   * Auto-detected from CI/DOCKER/KUBERNETES_SERVICE_HOST env vars if not set.
   */
  sandbox?: boolean;
}

/**
 * Standard known browser executable locations on Windows / Linux / macOS.
 */
function findDefaultBrowserExecutable(): { channel?: "chrome" | "msedge"; executablePath?: string } {
  if (process.platform === "win32") {
    const chromePaths = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ];
    for (const p of chromePaths) {
      if (fs.existsSync(p)) return { executablePath: p };
    }

    const edgePaths = [
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ];
    for (const p of edgePaths) {
      if (fs.existsSync(p)) return { executablePath: p };
    }
  }

  // Fall back to channel detection
  return { channel: "chrome" };
}

/**
 * Race a promise against an AbortSignal, executing an optional cleanup action on abort.
 */
async function withAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
  onAbortAction?: () => void
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    onAbortAction?.();
    throw new Error("Operation cancelled by AbortSignal");
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      onAbortAction?.();
      reject(new Error("Operation cancelled by AbortSignal"));
    };

    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (res) => {
        signal.removeEventListener("abort", onAbort);
        resolve(res);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      }
    );
  });
}

/**
 * A concrete BrowserSession running inside a real browser instance.
 */
export class PlaywrightBrowserSession implements BrowserSession {
  readonly sessionId: string;
  private browser: Browser;
  private context: BrowserContext;
  private page: Page;
  private closed: boolean = false;
  private url: string = "about:blank";
  private title: string = "";

  constructor(
    sessionId: string,
    browser: Browser,
    context: BrowserContext,
    page: Page
  ) {
    this.sessionId = sessionId;
    this.browser = browser;
    this.context = context;
    this.page = page;
  }

  get currentUrl(): string {
    return this.url;
  }

  get pageTitle(): string {
    return this.title;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get underlyingPage(): Page {
    return this.page;
  }

  async navigate(url: string, options?: { signal?: AbortSignal }): Promise<void> {
    this.assertOpen();
    if (options?.signal?.aborted) throw new Error("Operation cancelled by AbortSignal");

    await withAbort(
      this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }),
      options?.signal,
      () => {
        this.page.evaluate(() => window.stop()).catch(() => {});
      }
    );
    this.url = this.page.url();
    this.title = await this.page.title();
  }

  async click(selector: string, options?: { signal?: AbortSignal }): Promise<void> {
    this.assertOpen();
    if (options?.signal?.aborted) throw new Error("Operation cancelled by AbortSignal");
    const locator = this.page.locator(selector).first();
    await withAbort(locator.click({ timeout: 15000 }), options?.signal);
    // Update state after potential navigation or mutation
    this.url = this.page.url();
    this.title = await this.page.title();
  }

  async type(selector: string, text: string, options?: { signal?: AbortSignal }): Promise<void> {
    this.assertOpen();
    if (options?.signal?.aborted) throw new Error("Operation cancelled by AbortSignal");
    const locator = this.page.locator(selector).first();
    await withAbort(locator.fill(text, { timeout: 15000 }), options?.signal);
  }

  async evaluate<T>(script: string, options?: { signal?: AbortSignal }): Promise<T> {
    this.assertOpen();
    if (options?.signal?.aborted) throw new Error("Operation cancelled by AbortSignal");
    return withAbort(this.page.evaluate<T>(script), options?.signal);
  }

  async observe(options?: { signal?: AbortSignal }): Promise<{
    url: string;
    title: string;
    content: string;
    contentSummary: string;
    elements: Array<{
      selector: string;
      tag: string;
      text?: string;
      value?: string;
      type?: string;
      href?: string;
    }>;
    interactiveElements: Array<{
      selector: string;
      tag: string;
      text?: string;
      value?: string;
      type?: string;
      href?: string;
    }>;
  }> {
    this.assertOpen();
    if (options?.signal?.aborted) throw new Error("Operation cancelled by AbortSignal");
    this.url = this.page.url();
    this.title = await this.page.title();

    // Extract interactive DOM elements from the real page with abort awareness
    const observation = await withAbort(
      this.page.evaluate(() => {
        const interactiveNodes = Array.from(
          document.querySelectorAll<HTMLElement>(
            'button, a[href], input, select, textarea, [role="button"], [onclick]'
          )
        );

        const elements = interactiveNodes.slice(0, 50).map((el, index) => {
          let selector = "";
          if (el.id) {
            selector = `#${el.id}`;
          } else if (el.getAttribute("name")) {
            selector = `[name="${el.getAttribute("name")}"]`;
          } else if (el.classList.length > 0) {
            selector = `${el.tagName.toLowerCase()}.${Array.from(el.classList).slice(0, 2).join(".")}`;
          } else {
            selector = `${el.tagName.toLowerCase()}:nth-of-type(${index + 1})`;
          }

          const tag = el.tagName.toLowerCase();
          const text = (el.innerText || el.textContent || "").trim().slice(0, 100);
          const value = (el as HTMLInputElement).value || undefined;
          const type = (el as HTMLInputElement).type || undefined;
          const href = (el as HTMLAnchorElement).href || undefined;

          return { selector, tag, text: text || undefined, value, type, href };
        });

        const bodyText = (document.body?.innerText || "").trim().replace(/\s+/g, " ");
        const contentSummary = bodyText.slice(0, 1000);

        return { elements, contentSummary };
      }),
      options?.signal
    );

    return {
      url: this.url,
      title: this.title,
      content: observation.contentSummary,
      contentSummary: observation.contentSummary,
      elements: observation.elements,
      interactiveElements: observation.elements,
    };
  }

  async screenshot(options?: { signal?: AbortSignal }): Promise<Buffer> {
    this.assertOpen();
    if (options?.signal?.aborted) throw new Error("Operation cancelled by AbortSignal");
    const buffer = await withAbort(
      this.page.screenshot({ type: "png", fullPage: false }),
      options?.signal
    );
    return buffer;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.context.close();
    } catch {
      // ignore
    }
    try {
      await this.browser.close();
    } catch {
      // ignore
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error(`BrowserSession "${this.sessionId}" is already closed.`);
    }
  }
}

/**
 * Provider adapter that creates real Playwright browser sessions using local Chrome/Edge.
 */
export class PlaywrightBrowserProvider implements BrowserProviderAdapter {
  private options: PlaywrightBrowserOptions;
  private sessions = new Map<string, PlaywrightBrowserSession>();

  constructor(options: PlaywrightBrowserOptions = {}) {
    this.options = options;
  }

  async createSession(options?: Record<string, unknown>): Promise<PlaywrightBrowserSession> {
    const headless = (options?.headless as boolean | undefined) ?? this.options.headless ?? true;
    const defaultBrowser = findDefaultBrowserExecutable();

    // Determine sandbox policy:
    // - Explicit option takes priority
    // - Auto-detect CI/container environments
    // - Default: sandbox ENABLED (secure for desktop/local mode)
    const isCIEnvironment = !!(process.env.CI || process.env.DOCKER || process.env.KUBERNETES_SERVICE_HOST);
    const sandboxEnabled = this.options.sandbox ?? !isCIEnvironment;

    const launchArgs = [
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
    ];

    if (!sandboxEnabled) {
      launchArgs.push("--no-sandbox", "--disable-setuid-sandbox");
    }

    const launchOptions: any = {
      headless,
      args: launchArgs,
    };

    if (this.options.executablePath) {
      launchOptions.executablePath = this.options.executablePath;
    } else if (defaultBrowser.executablePath) {
      launchOptions.executablePath = defaultBrowser.executablePath;
    } else {
      launchOptions.channel = this.options.channel ?? defaultBrowser.channel ?? "chrome";
    }

    const browser = await chromium.launch(launchOptions);
    const context = await browser.newContext({
      viewport: this.options.viewport ?? { width: 1280, height: 720 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 AgentOS/0.1",
    });

    const page = await context.newPage();
    const sessionId = generateId("browser");
    const session = new PlaywrightBrowserSession(sessionId, browser, context, page);

    this.sessions.set(sessionId, session);
    return session;
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.sessions.delete(sessionId);
      await session.close();
    }
  }

  listSessions(): string[] {
    return Array.from(this.sessions.keys());
  }

  async closeAll(): Promise<void> {
    const sessionList = Array.from(this.sessions.values());
    this.sessions.clear();
    await Promise.all(sessionList.map((s) => s.close()));
  }
}

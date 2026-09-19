// ─── @agentos/adapters/playwright-browser ────────────────────────────────────
// Real browser automation session and provider driven by playwright-core.
// Connects to local Chrome / Edge or standard Chromium channels to execute
// real web navigation, DOM inspection, form interactions, and screenshots.

import * as fs from "fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { generateId } from "@agentos/core";
import type { BrowserSession, BrowserProviderAdapter } from "./index";

export type NavigationValidator = (url: string) => Promise<boolean> | boolean;

export interface PlaywrightSessionOptions {
  navigationValidator?: NavigationValidator;
  onClose?: (sessionId: string) => void;
}

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
  /**
   * Optional async or sync validator for all navigations (goto, links, redirects, subresources).
   */
  navigationValidator?: NavigationValidator;
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
  private navigationValidator?: NavigationValidator;
  private routeInitialized: boolean = false;
  private onClose?: (sessionId: string) => void;

  constructor(
    sessionId: string,
    browser: Browser,
    context: BrowserContext,
    page: Page,
    options?: PlaywrightSessionOptions
  ) {
    this.sessionId = sessionId;
    this.browser = browser;
    this.context = context;
    this.page = page;
    this.navigationValidator = options?.navigationValidator;
    this.onClose = options?.onClose;
  }

  /**
   * Set or update the security policy validator dynamically.
   */
  setNavigationValidator(validator: NavigationValidator): void {
    this.navigationValidator = validator;
  }

  /**
   * Initializes network route policy interception on the browser page.
   * Intercepts goto, link clicks, redirects, JS navigations, fetch, XHR,
   * WebSocket, and all outbound subresource requests.
   */
  async init(): Promise<void> {
    if (this.routeInitialized) return;
    this.routeInitialized = true;

    await this.page.route("**/*", async (route) => {
      const targetUrl = route.request().url();

      // Permit safe internal schemes
      if (targetUrl.startsWith("data:") || targetUrl.startsWith("about:")) {
        await route.continue();
        return;
      }

      if (this.navigationValidator) {
        try {
          const allowed = await this.navigationValidator(targetUrl);
          if (!allowed) {
            await route.abort("blockedbyclient");
            return;
          }
        } catch {
          await route.abort("blockedbyclient");
          return;
        }
      }

      await route.continue();
    });
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error(`BrowserSession ${this.sessionId} has been closed`);
    }
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

  private stopPage(): void {
    try {
      this.page.evaluate(() => window.stop()).catch(() => {});
    } catch {
      // ignore
    }
  }

  async navigate(url: string, options?: { signal?: AbortSignal }): Promise<void> {
    this.assertOpen();
    if (options?.signal?.aborted) {
      this.stopPage();
      throw new Error("Operation cancelled by AbortSignal");
    }
    await this.init();

    if (this.navigationValidator) {
      const allowed = await this.navigationValidator(url);
      if (!allowed) {
        throw new Error(`Navigation blocked by security policy: destination URL "${url}" is restricted.`);
      }
    }

    try {
      await withAbort(
        this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }),
        options?.signal,
        () => this.stopPage()
      );
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("blockedbyclient") || msg.includes("ERR_BLOCKED_BY_CLIENT") || msg.includes("restricted")) {
        throw new Error(`Navigation blocked by security policy: destination URL "${url}" is restricted.`);
      }
      throw err;
    }
    this.url = this.page.url();
    this.title = await this.page.title();
  }

  async click(selector: string, options?: { signal?: AbortSignal }): Promise<void> {
    this.assertOpen();
    if (options?.signal?.aborted) {
      this.stopPage();
      throw new Error("Operation cancelled by AbortSignal");
    }
    await this.init();

    const locator = this.page.locator(selector).first();
    try {
      await withAbort(
        locator.click({ timeout: 15000 }),
        options?.signal,
        () => this.stopPage()
      );
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("blockedbyclient") || msg.includes("ERR_BLOCKED_BY_CLIENT")) {
        throw new Error(`Navigation blocked by security policy: clicked element triggered navigation to a restricted destination.`);
      }
      throw err;
    }
    // Update state after potential navigation or mutation
    this.url = this.page.url();
    this.title = await this.page.title();
  }

  async type(selector: string, text: string, options?: { signal?: AbortSignal }): Promise<void> {
    this.assertOpen();
    if (options?.signal?.aborted) {
      this.stopPage();
      throw new Error("Operation cancelled by AbortSignal");
    }
    const locator = this.page.locator(selector).first();
    await withAbort(
      locator.fill(text, { timeout: 15000 }),
      options?.signal,
      () => this.stopPage()
    );
  }

  async evaluate<T>(script: string, options?: { signal?: AbortSignal }): Promise<T> {
    this.assertOpen();
    if (options?.signal?.aborted) {
      this.stopPage();
      throw new Error("Operation cancelled by AbortSignal");
    }
    const result = await withAbort(
      this.page.evaluate(script),
      options?.signal,
      () => this.stopPage()
    );
    return result as T;
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

    // Extract interactive DOM elements from the real page with robust, scoped selectors
    // Passed as evaluated string script to avoid esbuild/tsx __name reference errors in browser
    const extractScript = `(() => {
      function getSafeCssEscape(val) {
        if (typeof CSS !== "undefined" && CSS.escape) {
          return CSS.escape(val);
        }
        return val.replace(/([ #;?%&,.+*~\\':"!^$[\\]()=>|\\/@])/g, "\\\\$1");
      }

      function getElementSelector(el) {
        const tag = el.tagName.toLowerCase();

        // 1. ID selector
        if (el.id && el.id.trim()) {
          return "#" + getSafeCssEscape(el.id.trim());
        }

        // 2. Test attributes
        const testId = el.getAttribute("data-testid") || el.getAttribute("data-test") || el.getAttribute("data-cy");
        if (testId) {
          return '[data-testid="' + getSafeCssEscape(testId) + '"]';
        }

        // 3. Name attribute
        const nameAttr = el.getAttribute("name");
        if (nameAttr) {
          return tag + '[name="' + getSafeCssEscape(nameAttr) + '"]';
        }

        // 4. Accessible label
        const ariaLabel = el.getAttribute("aria-label");
        if (ariaLabel && ariaLabel.trim().length <= 50) {
          return tag + '[aria-label="' + getSafeCssEscape(ariaLabel.trim()) + '"]';
        }

        // 5. Clean CSS classes
        const validClasses = Array.from(el.classList).filter(function(c) {
          return /^[a-zA-Z0-9_-]+$/.test(c) && !c.includes(":");
        });
        if (validClasses.length > 0) {
          return tag + "." + validClasses.slice(0, 2).map(getSafeCssEscape).join(".");
        }

        // 6. Accurate sibling-relative nth-of-type within immediate parent
        if (el.parentElement) {
          const siblingsOfSameTag = Array.from(el.parentElement.children).filter(function(child) {
            return child.tagName.toLowerCase() === tag;
          });
          const siblingIndex = siblingsOfSameTag.indexOf(el);
          if (siblingIndex >= 0) {
            const parentTag = el.parentElement.tagName.toLowerCase();
            const parentId = el.parentElement.id ? "#" + getSafeCssEscape(el.parentElement.id) + " > " : "";
            return parentId + parentTag + " > " + tag + ":nth-of-type(" + (siblingIndex + 1) + ")";
          }
        }

        return tag;
      }

      const interactiveNodes = Array.from(
        document.querySelectorAll(
          'button, a[href], input, select, textarea, [role="button"], [onclick]'
        )
      );

      const elements = interactiveNodes.slice(0, 50).map(function(el) {
        const selector = getElementSelector(el);
        const tag = el.tagName.toLowerCase();
        const text = (el.innerText || el.textContent || "").trim().slice(0, 100);
        const value = el.value || undefined;
        const type = el.type || undefined;
        const href = el.href || undefined;

        return { selector, tag, text: text || undefined, value, type, href };
      });

      const bodyText = (document.body && document.body.innerText ? document.body.innerText : "").trim().replace(/\\s+/g, " ");
      const contentSummary = bodyText.slice(0, 1000);

      return { elements, contentSummary };
    })()`;

    const observation = await withAbort(
      this.page.evaluate<{
        elements: Array<{
          selector: string;
          tag: string;
          text?: string;
          value?: string;
          type?: string;
          href?: string;
        }>;
        contentSummary: string;
      }>(extractScript),
      options?.signal,
      () => this.stopPage()
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
    if (options?.signal?.aborted) {
      this.stopPage();
      throw new Error("Operation cancelled by AbortSignal");
    }
    const buffer = await withAbort(
      this.page.screenshot({ type: "png", fullPage: false }),
      options?.signal,
      () => this.stopPage()
    );
    return buffer;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.onClose?.(this.sessionId);
    } catch {
      // ignore
    }
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
}

/**
 * Provider adapter that creates real Playwright browser sessions using local Chrome/Edge.
 */
export class PlaywrightBrowserProvider implements BrowserProviderAdapter {
  private options: PlaywrightBrowserOptions;
  private sessions = new Map<string, PlaywrightBrowserSession>();
  private navigationValidator?: NavigationValidator;

  constructor(options: PlaywrightBrowserOptions = {}) {
    this.options = options;
    this.navigationValidator = options.navigationValidator;
  }

  /**
   * Set or update the security policy validator for all current and future sessions.
   */
  setNavigationValidator(validator: NavigationValidator): void {
    this.navigationValidator = validator;
    for (const session of this.sessions.values()) {
      session.setNavigationValidator(validator);
    }
  }

  getNavigationValidator(): NavigationValidator | undefined {
    return this.navigationValidator;
  }

  getSessions(): Map<string, PlaywrightBrowserSession> {
    return this.sessions;
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
    const session = new PlaywrightBrowserSession(sessionId, browser, context, page, {
      navigationValidator: this.navigationValidator ?? this.options.navigationValidator,
      onClose: (id) => {
        this.sessions.delete(id);
      },
    });
    await session.init();

    this.sessions.set(sessionId, session);
    return session;
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    if (session) {
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

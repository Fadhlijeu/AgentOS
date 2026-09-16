// ─── @agentos/adapters/browser ────────────────────────────────────────────────
// In-process virtual browser implementation for autonomous agent web navigation.
// Enables full web workflows (navigate, click, type, observe, screenshot) without
// requiring heavy binary browser installations for CI/offline use, while adhering
// to the exact BrowserSession and BrowserProviderAdapter contracts.

import { generateId } from "@agentos/core";
import type { BrowserSession, BrowserProviderAdapter } from "./index";

export interface VirtualElement {
  selector: string;
  tag: string;
  text?: string;
  value?: string;
  href?: string;
  type?: string;
}

export interface VirtualPageData {
  title: string;
  content: string;
  elements?: VirtualElement[];
}

export interface VirtualBrowserOptions {
  mockPages?: Record<string, VirtualPageData>;
  defaultTitle?: string;
}

/**
 * A simulated browser session that models page navigation, DOM inspection,
 * form typing, element clicking, and screenshot rendering.
 */
export class VirtualBrowserSession implements BrowserSession {
  readonly sessionId: string;
  private url: string = "about:blank";
  private title: string = "Blank Page";
  private content: string = "";
  private elements = new Map<string, VirtualElement>();
  private closed: boolean = false;
  private mockPages: Map<string, VirtualPageData>;

  constructor(options: VirtualBrowserOptions = {}) {
    this.sessionId = generateId("browser");
    this.mockPages = new Map(Object.entries(options.mockPages ?? {}));
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

  async navigate(url: string): Promise<void> {
    this.assertOpen();
    this.url = url;

    // Check if we have preconfigured mock data for this URL
    const pageData = this.mockPages.get(url);
    if (pageData) {
      this.title = pageData.title;
      this.content = pageData.content;
      this.elements.clear();
      if (pageData.elements) {
        for (const el of pageData.elements) {
          this.elements.set(el.selector, el);
        }
      }
    } else {
      // Synthesize realistic default page from URL
      try {
        const parsed = new URL(url);
        this.title = `${parsed.hostname} — Agent Browser View`;
        this.content = `Welcome to ${parsed.hostname}. Content loaded from ${parsed.pathname || "/"}.`;
        this.elements.clear();
        this.elements.set("#search", {
          selector: "#search",
          tag: "input",
          type: "text",
          value: "",
        });
        this.elements.set("#submit-btn", {
          selector: "#submit-btn",
          tag: "button",
          text: "Search",
        });
        this.elements.set("a.home", {
          selector: "a.home",
          tag: "a",
          text: "Home",
          href: `${parsed.origin}/`,
        });
      } catch {
        this.title = "Page Loaded";
        this.content = `Loaded content from: ${url}`;
      }
    }
  }

  async click(selector: string): Promise<void> {
    this.assertOpen();
    const el = this.elements.get(selector);
    if (!el) {
      throw new Error(`Element with selector "${selector}" not found on page "${this.url}"`);
    }

    // If it's a link with href, simulate navigation
    if (el.tag === "a" && el.href) {
      await this.navigate(el.href);
    }
  }

  async type(selector: string, text: string): Promise<void> {
    this.assertOpen();
    const el = this.elements.get(selector);
    if (!el) {
      // Auto-register dynamically if typing into a selector
      this.elements.set(selector, {
        selector,
        tag: "input",
        type: "text",
        value: text,
      });
      return;
    }
    el.value = text;
  }

  async screenshot(): Promise<Buffer> {
    this.assertOpen();
    // 1x1 transparent PNG fallback buffer
    const pngHex =
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082";
    return Buffer.from(pngHex, "hex");
  }

  async evaluate<T>(script: string): Promise<T> {
    this.assertOpen();
    if (script === "document.title") {
      return this.title as unknown as T;
    }
    if (script === "window.location.href") {
      return this.url as unknown as T;
    }
    if (script === "document.body.innerText") {
      return this.content as unknown as T;
    }
    return null as unknown as T;
  }

  /**
   * Observe all visible interactive elements on the current page.
   * Crucial for AI agent perception (links, inputs, buttons).
   */
  async observe(): Promise<{
    url: string;
    title: string;
    content: string;
    elements: VirtualElement[];
  }> {
    this.assertOpen();
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

  private assertOpen(): void {
    if (this.closed) {
      throw new Error(`BrowserSession "${this.sessionId}" is already closed.`);
    }
  }
}

/**
 * Provider that instantiates VirtualBrowserSession instances.
 */
export class VirtualBrowserProvider implements BrowserProviderAdapter {
  constructor(private defaultOptions: VirtualBrowserOptions = {}) {}

  async createSession(options?: Record<string, unknown>): Promise<BrowserSession> {
    return new VirtualBrowserSession({
      ...this.defaultOptions,
      ...(options as VirtualBrowserOptions),
    });
  }
}

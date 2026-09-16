// ─── @agentos/memory ─────────────────────────────────────────────────────────
// Memory system with working, long-term, and semantic tiers.
// Working memory is per-run (conversation state), long-term persists across runs.

import type { ModelMessage } from "@agentos/core";
import { SQLiteMemoryStore } from "./sqlite-store";

// ─── Types ───────────────────────────────────────────────────────────────────

export type MemoryTier = "working" | "long-term" | "semantic";

export interface MemoryEntry {
  key: string;
  value: unknown;
  tier: MemoryTier;
  timestamp: number;
  tags?: string[];
  expiresAt?: number;
}

/**
 * Pluggable storage backend for memory entries.
 * Implement this to back memory with SQLite, Redis, filesystem, etc.
 */
export interface MemoryStore {
  get(key: string): Promise<unknown | null>;
  set(
    key: string,
    value: unknown,
    tier?: MemoryTier,
    tags?: string[]
  ): Promise<void>;
  has(key: string): Promise<boolean>;
  delete(key: string, tier?: MemoryTier): Promise<void>;
  getByTier(tier: MemoryTier): Promise<MemoryEntry[]>;
  clear(tier?: MemoryTier): Promise<void>;
  search?(
    query: string,
    tier?: MemoryTier,
    limit?: number
  ): Promise<MemoryEntry[]>;
}

// ─── In-Memory Store ─────────────────────────────────────────────────────────

/** Default in-memory store. Fast but non-persistent (data lost on restart). */
export class InMemoryStore implements MemoryStore {
  private store = new Map<string, MemoryEntry>();

  async get(key: string): Promise<unknown | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(
    key: string,
    value: unknown,
    tier: MemoryTier = "working",
    tags: string[] = []
  ): Promise<void> {
    this.store.set(key, {
      key,
      value,
      tier,
      tags,
      timestamp: Date.now(),
    });
  }

  async has(key: string): Promise<boolean> {
    const val = await this.get(key);
    return val !== null;
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async getByTier(tier: MemoryTier): Promise<MemoryEntry[]> {
    return Array.from(this.store.values()).filter((e) => e.tier === tier);
  }

  async clear(tier?: MemoryTier): Promise<void> {
    if (tier) {
      for (const [key, entry] of this.store) {
        if (entry.tier === tier) this.store.delete(key);
      }
    } else {
      this.store.clear();
    }
  }

  async search(
    query: string,
    tier?: MemoryTier,
    limit: number = 10
  ): Promise<MemoryEntry[]> {
    const stopWords = new Set([
      "a",
      "an",
      "the",
      "to",
      "in",
      "for",
      "of",
      "and",
      "or",
      "is",
      "it",
      "on",
      "at",
      "by",
      "with",
    ]);
    const words = query
      .toLowerCase()
      .split(/[^a-zA-Z0-9_-]+/)
      .filter((w) => w.length > 1 && !stopWords.has(w));

    const scored: Array<{ entry: MemoryEntry; score: number }> = [];

    for (const entry of this.store.values()) {
      if (tier && entry.tier !== tier) continue;
      if (entry.expiresAt && entry.expiresAt < Date.now()) continue;

      let score = 0;
      const keyLower = entry.key.toLowerCase();
      const tagsLower = (entry.tags || []).map((t) => t.toLowerCase());
      const valStr = (
        typeof entry.value === "string"
          ? entry.value
          : JSON.stringify(entry.value)
      ).toLowerCase();

      // Full query match
      if (keyLower.includes(query.toLowerCase())) score += 10;
      if (tagsLower.includes(query.toLowerCase())) score += 8;
      if (valStr.includes(query.toLowerCase())) score += 5;

      // Word matches
      for (const word of words) {
        if (keyLower.includes(word)) score += 3;
        if (tagsLower.some((t) => t.includes(word))) score += 3;
        if (valStr.includes(word)) score += 1;
      }

      if (score > 0) {
        scored.push({ entry, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.entry);
  }
}

// ─── Memory Manager ──────────────────────────────────────────────────────────

/**
 * High-level memory manager used by the Agent.
 * Provides tiered access to working memory (per-run state),
 * long-term memory (cross-run knowledge), and context retrieval.
 */
export class MemoryManager {
  private store: MemoryStore;

  constructor(store?: MemoryStore) {
    this.store = store ?? new InMemoryStore();
  }

  private cleanKey(key: string): string {
    return key.replace(/^(working|longterm|long-term|semantic):/, "");
  }

  // ── Working Memory (per-run) ───────────────────────────────────────────

  /** Store a value in working memory. Cleared between runs. */
  async setWorking(
    key: string,
    value: unknown,
    tags?: string[]
  ): Promise<void> {
    const clean = this.cleanKey(key);
    await this.store.set(`working:${clean}`, value, "working", tags);
  }

  /** Get a value from working memory. */
  async getWorking(key: string): Promise<unknown | null> {
    const clean = this.cleanKey(key);
    return (
      (await this.store.get(`working:${clean}`)) ??
      (await this.store.get(clean))
    );
  }

  /** Clear all working memory (called at the start of each run). */
  async clearWorking(): Promise<void> {
    await this.store.clear("working");
  }

  // ── Conversation History (working memory shortcut) ─────────────────────

  /** Store the current conversation messages for the active run. */
  async setConversation(messages: ModelMessage[]): Promise<void> {
    await this.setWorking("conversation", messages);
  }

  /** Get the current conversation messages. */
  async getConversation(): Promise<ModelMessage[]> {
    const val = await this.getWorking("conversation");
    return (val as ModelMessage[]) ?? [];
  }

  // ── Long-Term Memory (persists across runs) ────────────────────────────

  /** Store a fact, preference, or outcome in long-term memory. */
  async setLongTerm(
    key: string,
    value: unknown,
    tags?: string[]
  ): Promise<void> {
    const clean = this.cleanKey(key);
    await this.store.set(`longterm:${clean}`, value, "long-term", tags);
  }

  /** Get a value from long-term memory. */
  async getLongTerm(key: string): Promise<unknown | null> {
    const clean = this.cleanKey(key);
    return (
      (await this.store.get(`longterm:${clean}`)) ??
      (await this.store.get(`long-term:${clean}`)) ??
      (await this.store.get(clean))
    );
  }

  /** Get all long-term memory entries. */
  async getAllLongTerm(): Promise<MemoryEntry[]> {
    return this.store.getByTier("long-term");
  }

  // ── Generic Remember & Retrieval ──────────────────────────────────────

  /** Store a memory in a specific tier with optional search tags. */
  async remember(
    tier: MemoryTier,
    key: string,
    value: unknown,
    tags: string[] = []
  ): Promise<void> {
    const clean = this.cleanKey(key);
    await this.store.set(clean, value, tier, tags);
  }

  /**
   * Retrieve memories relevant to a given task or query string.
   * Searches across long-term and semantic tiers.
   */
  async retrieve(query: string, limit: number = 5): Promise<MemoryEntry[]> {
    if (this.store.search) {
      return this.store.search(query, undefined, limit);
    }

    // Fallback: search long-term memory entries
    const entries = await this.getAllLongTerm();
    const q = query.toLowerCase();
    return entries
      .filter((e) => {
        if (e.key.toLowerCase().includes(q)) return true;
        if (e.tags?.some((t) => t.toLowerCase().includes(q))) return true;
        const valStr =
          typeof e.value === "string" ? e.value : JSON.stringify(e.value);
        return valStr.toLowerCase().includes(q);
      })
      .slice(0, limit);
  }

  /**
   * Formats a list of memory entries into markdown text suitable for injecting
   * into an agent's initial prompt context.
   */
  formatContextForPrompt(entries: MemoryEntry[]): string {
    if (entries.length === 0) return "";

    const lines = [
      "## Context & Relevant Past Knowledge",
      "The following relevant items were retrieved from memory:",
    ];

    for (const entry of entries) {
      const cleanKey = entry.key.replace(/^(working|longterm|semantic):/, "");
      const valStr =
        typeof entry.value === "string"
          ? entry.value
          : JSON.stringify(entry.value);
      lines.push(`- [${entry.tier}] ${cleanKey}: ${valStr}`);
    }

    return lines.join("\n");
  }

  // ── Semantic Memory ───────────────────────────────────────────────────

  /** Store a knowledge item with semantic tags. */
  async setSemantic(
    key: string,
    value: unknown,
    tags: string[] = []
  ): Promise<void> {
    await this.store.set(`semantic:${key}`, value, "semantic", tags);
  }

  /** Retrieve semantic memories. */
  async searchSemantic(
    query: string,
    limit: number = 5
  ): Promise<MemoryEntry[]> {
    if (this.store.search) {
      return this.store.search(query, "semantic", limit);
    }
    return [];
  }

  /** Get the underlying store. */
  getStore(): MemoryStore {
    return this.store;
  }
}

// ─── Re-exports ──────────────────────────────────────────────────────────────

export { SQLiteMemoryStore } from "./sqlite-store";
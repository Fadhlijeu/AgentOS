// ─── @agentos/memory ─────────────────────────────────────────────────────────
// Memory system with working, long-term, and semantic tiers.
// Working memory is per-run (conversation state), long-term persists across runs.

import type { ModelMessage } from "@agentos/core";

// ─── Types ───────────────────────────────────────────────────────────────────

export type MemoryTier = "working" | "long-term" | "semantic";

export interface MemoryEntry {
  key: string;
  value: unknown;
  tier: MemoryTier;
  timestamp: number;
  expiresAt?: number;
}

/**
 * Pluggable storage backend for memory entries.
 * Implement this to back memory with SQLite, Redis, filesystem, etc.
 */
export interface MemoryStore {
  get(key: string): Promise<unknown | null>;
  set(key: string, value: unknown, tier?: MemoryTier): Promise<void>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  getByTier(tier: MemoryTier): Promise<MemoryEntry[]>;
  clear(tier?: MemoryTier): Promise<void>;
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
    tier: MemoryTier = "working"
  ): Promise<void> {
    this.store.set(key, { key, value, tier, timestamp: Date.now() });
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
}

// ─── Memory Manager ──────────────────────────────────────────────────────────

/**
 * High-level memory manager used by the Agent.
 * Provides tiered access to working memory (per-run state)
 * and long-term memory (cross-run knowledge).
 */
export class MemoryManager {
  private store: MemoryStore;

  constructor(store?: MemoryStore) {
    this.store = store ?? new InMemoryStore();
  }

  // ── Working Memory (per-run) ───────────────────────────────────────────

  /** Store a value in working memory. Cleared between runs. */
  async setWorking(key: string, value: unknown): Promise<void> {
    await this.store.set(`working:${key}`, value, "working");
  }

  /** Get a value from working memory. */
  async getWorking(key: string): Promise<unknown | null> {
    return this.store.get(`working:${key}`);
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
  async setLongTerm(key: string, value: unknown): Promise<void> {
    await this.store.set(`longterm:${key}`, value, "long-term");
  }

  /** Get a value from long-term memory. */
  async getLongTerm(key: string): Promise<unknown | null> {
    return this.store.get(`longterm:${key}`);
  }

  /** Get all long-term memory entries. */
  async getAllLongTerm(): Promise<MemoryEntry[]> {
    return this.store.getByTier("long-term");
  }

  // ── Semantic Memory (v0.2 — placeholder) ───────────────────────────────

  /** Store a knowledge item with semantic embedding (v0.2). */
  async setSemantic(_key: string, _value: unknown): Promise<void> {
    // Will be implemented in v0.2 with embedding support
  }

  /** Retrieve semantically similar items (v0.2). */
  async searchSemantic(_query: string, _limit?: number): Promise<unknown[]> {
    // Will be implemented in v0.2
    return [];
  }

  /** Get the underlying store (for advanced usage). */
  getStore(): MemoryStore {
    return this.store;
  }
}
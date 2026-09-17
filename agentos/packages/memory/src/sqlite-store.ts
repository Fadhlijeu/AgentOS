// ─── SQLite Memory Store ──────────────────────────────────────────────────────
// Persistent storage backend for agent memories using SQLite.
// Ensures long-term facts, summaries, and learned knowledge survive restarts.

import { generateId } from "@agentos/core";
import { SQLiteStore, type PersistenceStore, type MemoryRecord } from "@agentos/storage";
import type { MemoryStore, MemoryEntry, MemoryTier } from "./index";

export class SQLiteMemoryStore implements MemoryStore {
  private store: PersistenceStore;
  private ownsStore: boolean;

  constructor(storeOrDbPath?: PersistenceStore | string) {
    if (!storeOrDbPath) {
      this.store = new SQLiteStore(":memory:");
      this.ownsStore = true;
    } else if (typeof storeOrDbPath === "string") {
      this.store = new SQLiteStore(storeOrDbPath);
      this.ownsStore = true;
    } else {
      this.store = storeOrDbPath;
      this.ownsStore = false;
    }
  }

  private cleanKey(key: string): string {
    return key.replace(/^(working|longterm|long-term|semantic):/, "");
  }

  async get(key: string): Promise<unknown | null> {
    const rawKey = this.cleanKey(key);
    // Check long-term, then working, then semantic
    for (const tier of ["long-term", "working", "semantic"] as const) {
      const record =
        this.store.getMemory(tier, rawKey) ??
        this.store.getMemory(tier, key);
      if (record) {
        return record.value;
      }
    }
    return null;
  }

  async set(
    key: string,
    value: unknown,
    tier: MemoryTier = "working",
    tags: string[] = []
  ): Promise<void> {
    const rawKey = this.cleanKey(key);
    const record: MemoryRecord = {
      id: generateId("mem"),
      tier,
      key: rawKey,
      value,
      tags,
      timestamp: Date.now(),
    };
    this.store.saveMemory(record);
  }

  async has(key: string): Promise<boolean> {
    const val = await this.get(key);
    return val !== null;
  }

  async delete(key: string, tier: MemoryTier = "working"): Promise<void> {
    const rawKey = this.cleanKey(key);
    this.store.deleteMemory(tier, rawKey);
  }

  async deleteByPrefix(prefix: string, tier: MemoryTier = "working"): Promise<void> {
    const rawPrefix = this.cleanKey(prefix);
    this.store.deleteMemoryByPrefix(tier, rawPrefix);
  }

  async getByTier(tier: MemoryTier): Promise<MemoryEntry[]> {
    const records = this.store.getMemoriesByTier(tier);
    return records.map((r) => ({
      key: r.key,
      value: r.value,
      tier: r.tier as MemoryTier,
      timestamp: r.timestamp,
      tags: r.tags,
    }));
  }

  async clear(tier?: MemoryTier): Promise<void> {
    if (tier) {
      this.store.clearMemoryTier(tier);
    } else {
      this.store.clearMemoryTier("working");
      this.store.clearMemoryTier("long-term");
      this.store.clearMemoryTier("semantic");
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

    const tiers: MemoryTier[] = tier
      ? [tier]
      : ["long-term", "semantic", "working"];

    const allEntries: MemoryEntry[] = [];
    for (const t of tiers) {
      const entries = await this.getByTier(t);
      allEntries.push(...entries);
    }

    const scored: Array<{ entry: MemoryEntry; score: number }> = [];

    for (const entry of allEntries) {
      let score = 0;
      const keyLower = entry.key.toLowerCase();
      const tagsLower = (entry.tags || []).map((t) => t.toLowerCase());
      const valStr = (
        typeof entry.value === "string"
          ? entry.value
          : JSON.stringify(entry.value)
      ).toLowerCase();

      // Check full query match
      if (keyLower.includes(query.toLowerCase())) score += 10;
      if (tagsLower.includes(query.toLowerCase())) score += 8;
      if (valStr.includes(query.toLowerCase())) score += 5;

      // Check word-level matches
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

  close(): void {
    if (this.ownsStore) {
      this.store.close();
    }
  }
}

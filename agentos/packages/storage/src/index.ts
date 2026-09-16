// ─── @agentos/storage ────────────────────────────────────────────────────────
// SQLite-based persistence for events, tasks, runs, state, and memory.
// Uses better-sqlite3 for synchronous, fast database access.

import Database from "better-sqlite3";
import type { AgentEvent, AgentResult } from "@agentos/core";

// ─── Persistence Interface ───────────────────────────────────────────────────

export interface PersistenceStore {
  // Events
  saveEvent(event: AgentEvent): void;
  getEventsByRun(runId: string): AgentEvent[];
  getEventsByType(type: string): AgentEvent[];

  // Runs
  saveRun(run: RunRecord): void;
  getRun(runId: string): RunRecord | null;
  getRecentRuns(limit?: number): RunRecord[];

  // State (key-value)
  saveState(key: string, value: unknown): void;
  getState(key: string): unknown | null;
  deleteState(key: string): void;

  // Cleanup
  close(): void;
}

export interface RunRecord {
  runId: string;
  taskId: string;
  task: string;
  status: string;
  output: string | null;
  error: string | null;
  startedAt: number;
  completedAt: number | null;
  iterations: number;
  totalTokens: number;
}

// ─── SQLite Store ────────────────────────────────────────────────────────────

/**
 * SQLite-backed persistence store.
 *
 * ```ts
 * const store = new SQLiteStore("./agentos.db");
 * store.saveEvent(event);
 * const events = store.getEventsByRun("run_abc123");
 * store.close();
 * ```
 *
 * Pass ":memory:" for an in-memory database (useful for testing).
 */
export class SQLiteStore implements PersistenceStore {
  private db: Database.Database;

  constructor(dbPath: string = "agentos.db") {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL"); // Better concurrent performance
    this.db.pragma("foreign_keys = ON");
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id          TEXT PRIMARY KEY,
        type        TEXT NOT NULL,
        timestamp   INTEGER NOT NULL,
        run_id      TEXT NOT NULL,
        task_id     TEXT NOT NULL,
        data        TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_events_run_id ON events(run_id);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);

      CREATE TABLE IF NOT EXISTS runs (
        run_id        TEXT PRIMARY KEY,
        task_id       TEXT NOT NULL,
        task          TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'RUNNING',
        output        TEXT,
        error         TEXT,
        started_at    INTEGER NOT NULL,
        completed_at  INTEGER,
        iterations    INTEGER NOT NULL DEFAULT 0,
        total_tokens  INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at);

      CREATE TABLE IF NOT EXISTS state (
        key      TEXT PRIMARY KEY,
        value    TEXT NOT NULL,
        updated  INTEGER NOT NULL
      );
    `);
  }

  // ── Events ─────────────────────────────────────────────────────────────

  saveEvent(event: AgentEvent): void {
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO events (id, type, timestamp, run_id, task_id, data) VALUES (?, ?, ?, ?, ?, ?)"
    );
    stmt.run(
      event.id,
      event.type,
      event.timestamp,
      event.runId,
      event.taskId,
      JSON.stringify(event.data)
    );
  }

  getEventsByRun(runId: string): AgentEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE run_id = ? ORDER BY timestamp ASC")
      .all(runId) as any[];
    return rows.map(this.rowToEvent);
  }

  getEventsByType(type: string): AgentEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE type = ? ORDER BY timestamp ASC")
      .all(type) as any[];
    return rows.map(this.rowToEvent);
  }

  // ── Runs ───────────────────────────────────────────────────────────────

  saveRun(run: RunRecord): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO runs
        (run_id, task_id, task, status, output, error, started_at, completed_at, iterations, total_tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      run.runId,
      run.taskId,
      run.task,
      run.status,
      run.output,
      run.error,
      run.startedAt,
      run.completedAt,
      run.iterations,
      run.totalTokens
    );
  }

  getRun(runId: string): RunRecord | null {
    const row = this.db
      .prepare("SELECT * FROM runs WHERE run_id = ?")
      .get(runId) as any;
    if (!row) return null;
    return this.rowToRun(row);
  }

  getRecentRuns(limit: number = 20): RunRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?")
      .all(limit) as any[];
    return rows.map(this.rowToRun);
  }

  // ── State ──────────────────────────────────────────────────────────────

  saveState(key: string, value: unknown): void {
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO state (key, value, updated) VALUES (?, ?, ?)"
    );
    stmt.run(key, JSON.stringify(value), Date.now());
  }

  getState(key: string): unknown | null {
    const row = this.db
      .prepare("SELECT value FROM state WHERE key = ?")
      .get(key) as any;
    if (!row) return null;
    return JSON.parse(row.value);
  }

  deleteState(key: string): void {
    this.db.prepare("DELETE FROM state WHERE key = ?").run(key);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  close(): void {
    this.db.close();
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private rowToEvent(row: any): AgentEvent {
    return {
      id: row.id,
      type: row.type,
      timestamp: row.timestamp,
      runId: row.run_id,
      taskId: row.task_id,
      data: JSON.parse(row.data || "{}"),
    };
  }

  private rowToRun(row: any): RunRecord {
    return {
      runId: row.run_id,
      taskId: row.task_id,
      task: row.task,
      status: row.status,
      output: row.output,
      error: row.error,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      iterations: row.iterations,
      totalTokens: row.total_tokens,
    };
  }
}
// ─── @agentos/events ─────────────────────────────────────────────────────────
// Typed event bus for the AgentOS runtime. Every important operation emits
// events through this bus, making the system fully observable and replayable.

import type { AgentEventType, AgentEvent } from "@agentos/core";
import { generateId } from "@agentos/core";

// ─── Event Handler Types ─────────────────────────────────────────────────────

export type EventHandler = (event: AgentEvent) => void;
export type WildcardHandler = (event: AgentEvent) => void;

// ─── EventBus ────────────────────────────────────────────────────────────────

/**
 * Central event bus for all AgentOS events.
 *
 * Supports:
 * - Typed event subscription with `on(type, handler)`
 * - One-time listeners with `once(type)`
 * - Wildcard listeners with `onAny(handler)`
 * - Full event history for replay / observability
 *
 * ```ts
 * const bus = new EventBus();
 * bus.on("tool.completed", (e) => console.log("Tool done:", e));
 * bus.emit("tool.completed", { runId, taskId, data: { result } });
 * ```
 */
export class EventBus {
  private listeners = new Map<string, Set<EventHandler>>();
  private wildcardListeners = new Set<WildcardHandler>();
  private history: AgentEvent[] = [];

  // ── Subscribe ──────────────────────────────────────────────────────────

  /** Listen for a specific event type. Returns an unsubscribe function. */
  on(type: AgentEventType, handler: EventHandler): () => void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(handler);
    return () => this.off(type, handler);
  }

  /** Remove a specific listener. */
  off(type: AgentEventType, handler: EventHandler): void {
    this.listeners.get(type)?.delete(handler);
  }

  /** Listen for ALL event types. Returns an unsubscribe function. */
  onAny(handler: WildcardHandler): () => void {
    this.wildcardListeners.add(handler);
    return () => this.wildcardListeners.delete(handler);
  }

  /**
   * Wait for the next occurrence of an event type.
   * Resolves with the event payload. Useful for awaiting approval, etc.
   */
  once(type: AgentEventType): Promise<AgentEvent> {
    return new Promise((resolve) => {
      const handler: EventHandler = (event) => {
        this.off(type, handler);
        resolve(event);
      };
      this.on(type, handler);
    });
  }

  // ── Emit ───────────────────────────────────────────────────────────────

  /**
   * Emit an event. The event is enriched with a unique `id` and `timestamp`,
   * stored in history, then dispatched to all matching listeners.
   */
  emit(
    type: AgentEventType,
    payload: { runId: string; taskId: string; data?: Record<string, unknown> }
  ): AgentEvent {
    const event: AgentEvent = {
      id: generateId("evt"),
      type,
      timestamp: Date.now(),
      runId: payload.runId,
      taskId: payload.taskId,
      data: payload.data ?? {},
    };

    this.history.push(event);

    // Dispatch to typed listeners
    const handlers = this.listeners.get(type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event);
        } catch (err) {
          console.error(`[EventBus] Handler error for "${type}":`, err);
        }
      }
    }

    // Dispatch to wildcard listeners
    for (const handler of this.wildcardListeners) {
      try {
        handler(event);
      } catch (err) {
        console.error(`[EventBus] Wildcard handler error:`, err);
      }
    }

    return event;
  }

  // ── History / Replay ───────────────────────────────────────────────────

  /** Get the full event history (all events emitted through this bus). */
  getHistory(): AgentEvent[] {
    return [...this.history];
  }

  /** Get events filtered by run. */
  getEventsByRun(runId: string): AgentEvent[] {
    return this.history.filter((e) => e.runId === runId);
  }

  /** Get events filtered by type. */
  getEventsByType(type: AgentEventType): AgentEvent[] {
    return this.history.filter((e) => e.type === type);
  }

  /** Serialize the full event history to JSON (for replay export). */
  exportHistory(): string {
    return JSON.stringify(this.history, null, 2);
  }

  /** Clear all history (useful for tests). */
  clearHistory(): void {
    this.history = [];
  }

  /** Remove all listeners and history. */
  dispose(): void {
    this.listeners.clear();
    this.wildcardListeners.clear();
    this.history = [];
  }
}
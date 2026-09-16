// ─── Approval System ─────────────────────────────────────────────────────────
// Human-in-the-loop approval for risky tool operations.
// v0.1 provides a console-based handler; future versions will add UI dialogs.

import * as readline from "readline";
import type { RiskLevel, ApprovalStatus } from "@agentos/core";
import { EventBus } from "@agentos/events";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ApprovalRequest {
  requestId: string;
  toolName: string;
  riskLevel: RiskLevel;
  input: Record<string, unknown>;
  description: string;
}

/**
 * Handler that presents approval requests to a human and returns their decision.
 * Implementations can be console-based, UI-based, API-based, etc.
 */
export interface ApprovalHandler {
  requestApproval(request: ApprovalRequest): Promise<ApprovalStatus>;
}

// ─── Approval Manager ────────────────────────────────────────────────────────

/**
 * Manages the lifecycle of approval requests. Integrates with EventBus to
 * emit approval.required / approval.granted / approval.denied events.
 */
export class ApprovalManager {
  private handler: ApprovalHandler;
  private eventBus: EventBus;
  private pending = new Map<string, ApprovalRequest>();
  private timeoutMs: number;

  constructor(
    handler: ApprovalHandler,
    eventBus: EventBus,
    timeoutMs: number = 60_000
  ) {
    this.handler = handler;
    this.eventBus = eventBus;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Request approval for a tool call. Emits events and delegates to the handler.
   *
   * @returns true if approved, false if denied or timed out
   */
  async checkApproval(
    toolName: string,
    riskLevel: RiskLevel,
    input: Record<string, unknown>,
    runId: string,
    taskId: string
  ): Promise<boolean> {
    const requestId = `approval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const request: ApprovalRequest = {
      requestId,
      toolName,
      riskLevel,
      input,
      description: `Tool "${toolName}" (risk: ${riskLevel})`,
    };

    this.pending.set(requestId, request);

    // Emit approval.required event
    this.eventBus.emit("approval.required", {
      runId,
      taskId,
      data: {
        requestId,
        toolName,
        riskLevel,
        input,
      },
    });

    try {
      // Race between handler and timeout
      const status = await Promise.race([
        this.handler.requestApproval(request),
        this.createTimeout(),
      ]);

      this.pending.delete(requestId);

      if (status === "GRANTED") {
        this.eventBus.emit("approval.granted", {
          runId,
          taskId,
          data: { requestId, toolName },
        });
        return true;
      } else {
        this.eventBus.emit("approval.denied", {
          runId,
          taskId,
          data: { requestId, toolName, status },
        });
        return false;
      }
    } catch {
      this.pending.delete(requestId);
      this.eventBus.emit("approval.denied", {
        runId,
        taskId,
        data: { requestId, toolName, status: "TIMEOUT" },
      });
      return false;
    }
  }

  private createTimeout(): Promise<ApprovalStatus> {
    return new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Approval timed out")), this.timeoutMs)
    );
  }
}

// ─── Console Approval Handler ────────────────────────────────────────────────

/**
 * Prompts the user in the terminal for approval. Used in CLI / development mode.
 *
 * Shows the tool name, risk level, and arguments, then asks [y/n].
 */
export class ConsoleApprovalHandler implements ApprovalHandler {
  async requestApproval(request: ApprovalRequest): Promise<ApprovalStatus> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr, // use stderr so stdout stays clean for piping
    });

    return new Promise<ApprovalStatus>((resolve) => {
      console.error("\n┌─────────────────────────────────────────────────────");
      console.error(`│ 🔐 APPROVAL REQUIRED`);
      console.error(`│ Tool:  ${request.toolName}`);
      console.error(`│ Risk:  ${request.riskLevel}`);
      console.error(`│ Input: ${JSON.stringify(request.input, null, 2).split("\n").join("\n│        ")}`);
      console.error("└─────────────────────────────────────────────────────");

      rl.question("  Approve? [y/N]: ", (answer) => {
        rl.close();
        const approved = answer.trim().toLowerCase() === "y";
        resolve(approved ? "GRANTED" : "DENIED");
      });
    });
  }
}

/**
 * Auto-approves everything. Use for testing or trusted environments only.
 */
export class AutoApprovalHandler implements ApprovalHandler {
  async requestApproval(_request: ApprovalRequest): Promise<ApprovalStatus> {
    return "GRANTED";
  }
}
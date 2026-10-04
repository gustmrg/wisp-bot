import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import type { ToolActionCategory, ToolPolicyBehavior } from "../../shared/tool-policy.js";

export interface ToolAuditEvent {
  actionId: string;
  conversationId: string;
  toolCallId: string;
  category: ToolActionCategory;
  scope: string;
  matchedPolicy: ToolPolicyBehavior;
  decision: "allow" | "ask" | "block" | "allow_once" | "allow_always" | "deny" | "expired" | "cancelled";
  actor: "policy" | "user" | "system";
  outcome: "pending" | "allowed" | "blocked" | "cancelled";
  timestamp: string;
}

export interface ToolAuditSink {
  append(event: ToolAuditEvent): void;
}

export class ToolAuditStore implements ToolAuditSink {
  constructor(private readonly filePath: string) {}

  append(event: ToolAuditEvent): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const record = {
      schemaVersion: 1,
      ...event,
      scope: "[REDACTED]",
      scopeHash: createHash("sha256").update(event.scope).digest("hex"),
    };
    appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  }
}

export class NullToolAuditSink implements ToolAuditSink {
  append(_event: ToolAuditEvent): void {}
}

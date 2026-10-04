import { readFile } from "node:fs/promises";
import { writeFileAtomically } from "./atomic-file.js";
import type { AgentSession } from "@earendil-works/pi-coding-agent" with { "resolution-mode": "import" };
import {
  DEFAULT_CONTEXT_POLICY,
  isContextPolicy,
  shouldRenewContext,
  type ContextCommand,
  type ContextView,
} from "../../shared/context-policy.js";
import { WispBackendError } from "./backend-error.js";

const CONTINUITY_INSTRUCTIONS =
  "Preserve the user's goals, decisions, preferences, unresolved questions, pending work, and exact identifiers or references needed to continue. Distinguish completed work from pending work. Preserve the meaning of numbered options the user may refer to. Do not invent facts. Keep the summary concise. Earlier messages remain accessible with search_history.";

export class ContextSession {
  private settings = { policy: { ...DEFAULT_CONTEXT_POLICY }, memory: "" };
  constructor(
    private readonly session: AgentSession,
    private readonly settingsPath: string,
    private readonly onRenewed: (kind: "compacted" | "new_topic", at: string) => void,
    private readonly now = () => new Date(),
  ) {}

  async load(): Promise<void> {
    try {
      const data = JSON.parse(await readFile(this.settingsPath, "utf8"));
      if (!isContextPolicy(data.policy) || typeof data.memory !== "string" || data.memory.length > 8000)
        throw new Error("Invalid context settings");
      this.settings = { policy: data.policy, memory: data.memory };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new WispBackendError("invalid_configuration", "Could not load this Wisp's context settings.");
    }
  }

  view(): ContextView {
    const entries = this.session.sessionManager.getEntries();
    const branch = this.session.sessionManager.getBranch();
    const summary = [...branch].reverse().find((entry) => entry.type === "compaction");
    const renewed = [...entries]
      .reverse()
      .find((entry) => entry.type === "custom" && entry.customType === "wisp:context-renewed");
    const activity = [...entries]
      .reverse()
      .find(
        (entry) => entry.type === "message" || (entry.type === "custom" && entry.customType === "wisp:context-renewed"),
      );
    return {
      policy: { ...this.settings.policy },
      memory: this.settings.memory,
      summary: summary?.type === "compaction" ? summary.summary.slice(0, 32000) : null,
      lastRenewedAt: renewed?.timestamp ?? null,
      lastActivityAt: activity?.timestamp ?? null,
      tokens: this.session.messages.length
        ? (this.session.getContextUsage()?.tokens ?? Math.ceil(JSON.stringify(this.session.messages).length / 4))
        : 0,
    };
  }

  async beforePrompt(): Promise<void> {
    const view = this.view();
    if (shouldRenewContext(view.policy, view.lastActivityAt, view.tokens, this.now()))
      await this.command({ action: "compact" });
  }

  async command(command: ContextCommand): Promise<ContextView> {
    if (command.action === "get") return this.view();
    if (!this.session.isIdle)
      throw new WispBackendError("invalid_request", "Wait for the Wisp to finish before changing its context.");
    if (command.action === "save") {
      const settings = { policy: command.policy, memory: command.memory };
      await writeFileAtomically(this.settingsPath, JSON.stringify(settings));
      this.settings = settings;
    } else if (command.action === "compact") {
      await this.session.compact(CONTINUITY_INSTRUCTIONS);
    } else {
      // An append after resetting the leaf durably records the new branch. Old entries remain searchable.
      this.session.sessionManager.resetLeaf();
      this.session.sessionManager.appendCustomEntry("wisp:context-boundary", {});
      this.session.refreshContext();
      this.renewed("new_topic");
    }
    return this.view();
  }

  renewed(kind: "compacted" | "new_topic"): void {
    const at = this.now().toISOString();
    this.session.sessionManager.appendCustomEntry("wisp:context-renewed", { kind });
    this.onRenewed(kind, at);
  }

  search(query: string): string {
    const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (!words.length) return "Enter words to search for.";
    const matches: string[] = [];
    for (const entry of [...this.session.sessionManager.getEntries()].reverse()) {
      if (entry.type !== "message" || (entry.message.role !== "user" && entry.message.role !== "assistant")) continue;
      const content = entry.message.content;
      const text =
        typeof content === "string"
          ? content
          : content
              .filter((block) => block.type === "text")
              .map((block) => (block.type === "text" ? block.text : ""))
              .join("\n");
      if (!words.every((word) => text.toLowerCase().includes(word))) continue;
      const start = Math.max(0, text.toLowerCase().indexOf(words[0]!) - 200);
      matches.push(`${entry.timestamp} ${entry.message.role}: ${text.slice(start, start + 1200)}`);
      if (matches.length === 5) break;
    }
    return matches.join("\n\n") || "No matching messages in this Wisp's history.";
  }
}

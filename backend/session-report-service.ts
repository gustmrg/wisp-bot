import { readdir, lstat, readFile } from "node:fs/promises";

import path from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent" with { "resolution-mode": "import" };

import type { UsageReport, UsageReportRequest, WispUsageRow, WispSessionReport } from "../shared/contracts.js";
import { WispBackendError } from "./backend-error.js";
import type { ConversationRepository } from "./conversation-repository.js";
import type { ModelPricingService } from "./model-pricing-service.js";
import { addTotals, createUsageReport } from "./usage-report.js";
import { buildSessionReport, emptyUsage } from "./pi-session-report.js";

const MAX_SESSION_FILE_BYTES = 25 * 1024 * 1024;

export class SessionReportService {
  private readonly repository: ConversationRepository;
  private readonly pricing: ModelPricingService;

  constructor(repository: ConversationRepository, pricing: ModelPricingService) {
    this.repository = repository;
    this.pricing = pricing;
  }

  async getSessionReport(conversationId: string): Promise<WispSessionReport | null> {
    const context = this.repository.getPiSessionContext(conversationId);
    if (!context?.piSessionFile) return null;
    const entries = await readSessionEntries(context.piSessionFile).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (!entries) return null;
    await this.pricing.ensureFresh();
    return buildSessionReport(context.piSessionId ?? context.sessionId, entries, {
      workspaceDirectory: context.workspaceDirectory,
      getPricing: (providerId, modelId) => this.pricing.getPricing(providerId, modelId),
    });
  }

  async getUsageReport(request: UsageReportRequest): Promise<UsageReport> {
    await this.pricing.ensureFresh();
    const report = createUsageReport(request, new Date(), this.pricing.getUpdatedAt());
    const rows: WispUsageRow[] = [];
    for (const context of this.repository.listAgentContexts()) {
      const row: WispUsageRow = {
        conversationId: context.conversationId,
        name: context.name,
        sessions: 0,
        totals: { ...emptyUsage(), costUsd: 0 },
      };
      let files: string[];
      try {
        files = (await readdir(context.sessionDirectory)).filter((file) => file.endsWith(".jsonl"));
      } catch {
        report.incomplete = true;
        row.totals.costUsd = null;
        rows.push(row);
        continue;
      }
      // Files are Pi's durable history, including sessions preceding a restart or compaction.
      // Read sequentially so large workspaces cannot allocate all session files at once.
      for (const file of files) {
        try {
          const entries = await readSessionEntries(path.join(context.sessionDirectory, file));
          const filtered = entries.filter(
            (entry) => (!report.from || entry.timestamp >= report.from) && entry.timestamp <= report.generatedAt,
          );
          const session = buildSessionReport("usage", filtered, {
            workspaceDirectory: context.workspaceDirectory,
            getPricing: (provider, model) => this.pricing.getPricing(provider, model),
          });
          if (session.turns > 0) row.sessions += 1;
          addTotals(row.totals, session.totals);
        } catch {
          report.incomplete = true;
          row.totals.costUsd = null;
        }
      }
      rows.push(row);
    }
    report.wisps = rows;
    for (const row of rows) addTotals(report.totals, row.totals);
    return report;
  }
}

async function readSessionEntries(file: string): Promise<SessionEntry[]> {
  const info = await lstat(file);
  if (!info.isFile() || info.size > MAX_SESSION_FILE_BYTES) {
    throw new WispBackendError("internal_error", "The session cannot be summarized.", false);
  }
  const contents = await readFile(file, "utf8");
  if (Buffer.byteLength(contents) > MAX_SESSION_FILE_BYTES) throw new Error("Session exceeds size limit");
  const lines = contents.split("\n").filter((line) => line.trim());
  const entries: SessionEntry[] = [];
  for (const line of lines) {
    const value = JSON.parse(line);
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.type !== "string" ||
      typeof value.timestamp !== "string" ||
      !Number.isFinite(Date.parse(value.timestamp))
    ) {
      throw new Error("Invalid session entry");
    }
    if (value.type !== "session")
      entries.push({ ...value, timestamp: new Date(value.timestamp).toISOString() } as SessionEntry);
  }
  return entries;
}

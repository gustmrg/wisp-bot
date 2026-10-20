import { readdir, lstat, readFile, stat } from "node:fs/promises";

import path from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent" with { "resolution-mode": "import" };

import type { UsageReport, UsageReportRequest, WispUsageRow, WispSessionReport } from "../shared/contracts.js";
import { WispBackendError } from "./backend-error.js";
import type { ConversationRepository } from "./conversation-repository.js";
import type { ModelPricingService } from "./model-pricing-service.js";
import { addTotals, createUsageReport } from "./usage-report.js";
import { buildSessionReport, emptyUsage, type SessionPricingLookup } from "./pi-session-report.js";
import { CLAUDE_CODE_USAGE_FILE, claudeCodeFallbackSessionFiles } from "./claude-code/claude-code-usage-log.js";

const MAX_SESSION_FILE_BYTES = 25 * 1024 * 1024;

export class SessionReportService {
  private readonly repository: ConversationRepository;
  private readonly pricing: ModelPricingService;
  private readonly catalogPricing: SessionPricingLookup | undefined;
  private readonly describeMcpTool: ((alias: string) => string | undefined) | undefined;

  constructor(
    repository: ConversationRepository,
    pricing: ModelPricingService,
    catalogPricing?: SessionPricingLookup,
    describeMcpTool?: (alias: string) => string | undefined,
  ) {
    this.repository = repository;
    this.pricing = pricing;
    this.catalogPricing = catalogPricing;
    this.describeMcpTool = describeMcpTool;
  }

  async getSessionReport(conversationId: string): Promise<WispSessionReport | null> {
    const context = this.repository.getPiSessionContext(conversationId);
    if (!context) return null;
    const entries =
      (await this.claudeCodeEntries(context.sessionDirectory, context.piSessionFile)) ??
      (context.piSessionFile
        ? await readSessionEntries(context.piSessionFile).catch((error) => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw error;
          })
        : null);
    if (!entries) return null;
    await this.pricing.ensureFresh();
    return buildSessionReport(context.piSessionId ?? context.sessionId, entries, {
      workspaceDirectory: context.workspaceDirectory,
      getPricing: (providerId, modelId) => this.pricing.getPricing(providerId, modelId),
      getCatalogPricing: this.catalogPricing,
      describeMcpTool: this.describeMcpTool,
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
        totals: { ...emptyUsage(), costUsd: 0, cacheSavingsUsd: 0 },
      };
      let files: string[];
      try {
        files = (await readdir(context.sessionDirectory)).filter((file) => file.endsWith(".jsonl"));
      } catch {
        report.incomplete = true;
        row.totals.costUsd = null;
        row.totals.cacheSavingsUsd = null;
        rows.push(row);
        continue;
      }
      // Files are Pi's durable history, including sessions preceding a restart or compaction,
      // a Claude Code Wisp's usage log, and the sessions its fallback model answered in.
      // The Wisp's sessions in circles count as its own (ADR 011); one not started has no folder yet.
      // Read sequentially so large workspaces cannot allocate all session files at once.
      const paths = [
        ...files.map((file) => path.join(context.sessionDirectory, file)),
        ...(await claudeCodeFallbackSessionFiles(context.sessionDirectory)),
      ];
      for (const directory of this.repository.listCircleSessionDirectories(context.wispId)) {
        const circleFiles = await readdir(directory).catch(() => [] as string[]);
        paths.push(
          ...circleFiles.filter((file) => file.endsWith(".jsonl")).map((file) => path.join(directory, file)),
          ...(await claudeCodeFallbackSessionFiles(directory)),
        );
      }
      for (const file of paths) {
        try {
          const entries = await readSessionEntries(file);
          const filtered = entries.filter(
            (entry) => (!report.from || entry.timestamp >= report.from) && entry.timestamp <= report.generatedAt,
          );
          const session = buildSessionReport("usage", filtered, {
            workspaceDirectory: context.workspaceDirectory,
            getPricing: (provider, model) => this.pricing.getPricing(provider, model),
            getCatalogPricing: this.catalogPricing,
          });
          if (session.turns > 0) row.sessions += 1;
          addTotals(row.totals, session.totals);
        } catch {
          report.incomplete = true;
          row.totals.costUsd = null;
          row.totals.cacheSavingsUsd = null;
        }
      }
      rows.push(row);
    }
    report.wisps = rows;
    for (const row of rows) addTotals(report.totals, row.totals);
    return report;
  }

  /**
   * A Claude Code Wisp's session (ADR 026): its usage log, with the turns its
   * fallback model answered, in time order. Null when the Wisp last ran on Pi.
   */
  private async claudeCodeEntries(
    sessionDirectory: string,
    piSessionFile: string | null,
  ): Promise<SessionEntry[] | null> {
    const log = path.join(sessionDirectory, CLAUDE_CODE_USAGE_FILE);
    const modified = async (file: string) => (await stat(file).catch(() => null))?.mtimeMs;
    const logModified = await modified(log);
    if (logModified === undefined) return null;
    const piModified = piSessionFile ? await modified(piSessionFile) : undefined;
    if (piModified !== undefined && piModified > logModified) return null;
    const entries = await readSessionEntries(log);
    for (const file of await claudeCodeFallbackSessionFiles(sessionDirectory)) {
      entries.push(...(await readSessionEntries(file)));
    }
    return entries.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
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

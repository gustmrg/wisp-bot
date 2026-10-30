import { readdir, lstat, readFile, stat } from "node:fs/promises";

import path from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent" with { "resolution-mode": "import" };

import type { UsageReport, UsageReportRequest, WispUsageRow, WispSessionReport } from "../shared/contracts.js";
import { WispBackendError } from "./backend-error.js";
import type { ConversationRepository } from "./conversation-repository.js";
import type { ModelPricingService } from "./model-pricing-service.js";
import { addModelUsage, addTotals, createUsageReport, mergeModelUsage, type ModelUsage } from "./usage-report.js";
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
    let decisions: WispUsageRow;
    if (request.conversationId !== undefined) {
      // A circle's members, counting only their sessions in it (ADR 011).
      for (const member of this.repository.getCircleAgentContext(request.conversationId).members) {
        // A member's session there has no folder until its first turn.
        rows.push(
          await this.usageRow(report, member.wispId, member.name, member.workspaceDirectory, {
            optional: [member.sessionDirectory],
          }),
        );
      }
      decisions = await this.usageRow(report, request.conversationId, DECISION_MODEL_ROW, "", {
        optional: [this.repository.circleDecisionUsageDirectory(request.conversationId)],
      });
    } else {
      for (const context of this.repository.listAgentContexts()) {
        // The Wisp's sessions in circles count as its own (ADR 011); one not started has no folder yet.
        rows.push(
          await this.usageRow(report, context.conversationId, context.name, context.workspaceDirectory, {
            required: [context.sessionDirectory],
            optional: this.repository.listCircleSessionDirectories(context.wispId),
          }),
        );
      }
      decisions = await this.usageRow(report, DECISION_MODEL_ROW_ID, DECISION_MODEL_ROW, "", {
        optional: this.repository.listCircleDecisionUsageDirectories(),
      });
    }
    // A row only once it was used; a Wisp has one either way.
    if (decisions.totals.totalTokens > 0) rows.push(decisions);
    const models: ModelUsage = new Map();
    for (const row of rows) {
      addTotals(report.totals, row.totals);
      mergeModelUsage(models, row.models ?? []);
    }
    report.wisps = rows;
    report.models = [...models.values()];
    return report;
  }

  /**
   * A Wisp's usage in the report's period, from its session folders. A
   * missing required folder makes the report incomplete; a missing optional
   * one has no usage.
   */
  private async usageRow(
    report: UsageReport,
    conversationId: string,
    name: string,
    workspaceDirectory: string,
    directories: { required?: ReadonlyArray<string>; optional?: ReadonlyArray<string> },
  ): Promise<WispUsageRow> {
    const row: WispUsageRow = {
      conversationId,
      name,
      sessions: 0,
      totals: { ...emptyUsage(), costUsd: 0, cacheSavingsUsd: 0 },
    };
    const models: ModelUsage = new Map();
    const markIncomplete = () => {
      report.incomplete = true;
      row.totals.costUsd = null;
      row.totals.cacheSavingsUsd = null;
    };
    // Files are Pi's durable history, including sessions preceding a restart or compaction,
    // a Claude Code Wisp's usage log, and the sessions its fallback model answered in.
    // Read sequentially so large workspaces cannot allocate all session files at once.
    const paths: string[] = [];
    for (const directory of directories.required ?? []) {
      let files: string[];
      try {
        files = await readdir(directory);
      } catch {
        markIncomplete();
        return row;
      }
      paths.push(...(await sessionFiles(directory, files)));
    }
    for (const directory of directories.optional ?? []) {
      paths.push(...(await sessionFiles(directory, await readdir(directory).catch(() => [] as string[]))));
    }
    for (const file of paths) {
      try {
        const entries = await readSessionEntries(file);
        const filtered = entries.filter(
          (entry) => (!report.from || entry.timestamp >= report.from) && entry.timestamp <= report.generatedAt,
        );
        const session = buildSessionReport("usage", filtered, {
          workspaceDirectory,
          getPricing: (provider, model) => this.pricing.getPricing(provider, model),
          getCatalogPricing: this.catalogPricing,
        });
        if (session.turns > 0) row.sessions += 1;
        addTotals(row.totals, session.totals);
        addModelUsage(models, session);
      } catch {
        markIncomplete();
      }
    }
    row.models = [...models.values()];
    return row;
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

/** A session folder's history: its `.jsonl` files and its Claude Code fallback sessions. */
/** The row of what decision models used, which belongs to no Wisp (ADR 011). */
const DECISION_MODEL_ROW = "Decision model";
const DECISION_MODEL_ROW_ID = "decision-model";

async function sessionFiles(directory: string, files: ReadonlyArray<string>): Promise<string[]> {
  return [
    ...files.filter((file) => file.endsWith(".jsonl")).map((file) => path.join(directory, file)),
    ...(await claudeCodeFallbackSessionFiles(directory)),
  ];
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

import { stat } from "node:fs/promises";

import type { WispSessionReport } from "../../shared/contracts.js";
import { WispBackendError } from "./backend-error.js";
import type { ConversationRepository } from "./conversation-repository.js";
import type { ModelPricingService } from "./model-pricing-service.js";
import { buildSessionReport } from "./pi-session-report.js";

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
    const fileStats = await stat(context.piSessionFile).catch(() => null);
    if (!fileStats) return null;
    if (fileStats.size > MAX_SESSION_FILE_BYTES) {
      throw new WispBackendError("internal_error", "The session is too large to summarize.", false);
    }
    await this.pricing.ensureFresh();
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const entries = SessionManager.open(context.piSessionFile).getEntries();
    return buildSessionReport(context.piSessionId ?? context.sessionId, entries, {
      workspaceDirectory: context.workspaceDirectory,
      getPricing: (providerId, modelId) => this.pricing.getPricing(providerId, modelId),
    });
  }
}

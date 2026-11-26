import { randomUUID } from "node:crypto";
import path from "node:path";

import type { ModelSelection } from "../shared/contracts.js";
import { WispBackendError } from "./backend-error.js";
import type { ConversationAgentContext } from "./conversation-agent.js";
import { sanitizeErrorMessage } from "./pi-event-translator.js";
import { describeProviderError } from "./provider-error.js";
import type { RuntimeJobSession } from "./runtime-session.js";
import type { ToolAuthorizationBroker } from "./tool-authorization-broker.js";
import type { ConsultationSessionSpec } from "./wisp-session-plan.js";

/** Where a Wisp's `ask_wisp` consultation sessions live, apart from its own conversation session. */
export const CONSULTATIONS_DIRECTORY = "consultations";
/** Default upper bound on a single Wisp-to-Wisp consultation. */
export const DEFAULT_CONSULTATION_TIMEOUT_MS = 5 * 60_000;
/** Maximum reply length returned to the calling Wisp, kept safely below the tool output cap. */
export const MAX_CONSULTATION_REPLY_LENGTH = 32_000;

export interface ConsultationSessionFactory {
  createConsultationSession(
    context: ConversationAgentContext,
    selection: ModelSelection,
    consultation: ConsultationSessionSpec,
  ): Promise<RuntimeJobSession>;
}

export interface ConsultationRequest {
  /** The conversation where the caller is running, where any approval cards appear. */
  callerConversationId: string;
  callerWispId: string;
  callerName: string;
  callerRole?: string;
  targetWispId: string;
  message: string;
}

export interface WispConsultationRunnerOptions {
  sessionFactory: ConsultationSessionFactory;
  /** The target Wisp's own agent context; throws `not_found` when the Wisp does not exist. */
  getContext: (wispId: string) => ConversationAgentContext;
  /** The model the target Wisp answers with: its own override, or the app default. */
  getSelection: (context: ConversationAgentContext) => Promise<ModelSelection | null>;
  routeApprovals: ToolAuthorizationBroker["routeApprovals"];
  timeoutMs?: number;
}

/**
 * Runs a single isolated `ask_wisp` consultation (ADR 049).
 *
 * The consulted Wisp runs with its own identity, soul, memory (if enabled),
 * skills, model, and workspace, without touching its own conversation session.
 * It receives no `ask_wisp`, `manage_wisp`, or job tools, preventing loops and
 * recursion. Any approval card it triggers is routed into the caller's
 * conversation while remaining attributed to and governed by the consulted
 * Wisp's own `wispId` and permissions.
 */
export class WispConsultationRunner {
  private readonly options: WispConsultationRunnerOptions;
  private readonly timeoutMs: number;

  constructor(options: WispConsultationRunnerOptions) {
    this.options = options;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CONSULTATION_TIMEOUT_MS;
  }

  readonly consult = async (request: ConsultationRequest, signal?: AbortSignal): Promise<string> => {
    if (request.targetWispId === request.callerWispId) {
      throw new WispBackendError("invalid_request", "A Wisp cannot consult itself.");
    }
    if (signal?.aborted) {
      throw new WispBackendError("aborted", "The consultation was cancelled.");
    }
    const targetContext = this.options.getContext(request.targetWispId);
    const selection = await this.options.getSelection(targetContext);
    if (!selection) {
      throw new WispBackendError(
        "configuration_required",
        `${targetContext.name} does not have a configured provider and model yet.`,
      );
    }
    if (signal?.aborted) {
      throw new WispBackendError("aborted", "The consultation was cancelled.");
    }

    const runId = randomUUID();
    const session = await this.options.sessionFactory.createConsultationSession(targetContext, selection, {
      runId,
      runDirectory: path.join(targetContext.sessionDirectory, CONSULTATIONS_DIRECTORY),
      callerName: request.callerName,
      ...(request.callerRole ? { callerRole: request.callerRole } : {}),
    });

    const controller = new AbortController();
    let timedOut = false;
    const onCallerAbort = () => controller.abort();
    signal?.addEventListener("abort", onCallerAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    timer.unref?.();

    const callerLabel = request.callerRole ? `${request.callerName} (${request.callerRole})` : request.callerName;
    const prompt = `[Consultation from ${callerLabel}]\n\n${request.message}`;

    try {
      await this.options.routeApprovals(request.callerConversationId, () => session.prompt(prompt, controller.signal));
      if (signal?.aborted) throw new WispBackendError("aborted", "The consultation was cancelled.");
      if (timedOut) {
        throw new WispBackendError("aborted", `${targetContext.name} did not answer in time.`, true);
      }
      const last = session.lastAssistantMessage();
      if (last?.stopReason === "aborted") {
        throw new WispBackendError("aborted", "The consultation was cancelled.");
      }
      if (last?.stopReason === "error") throw providerError(last.errorMessage);
      const reply = (last?.text ?? "").trim();
      if (!reply) return "(no reply)";
      return reply.length > MAX_CONSULTATION_REPLY_LENGTH
        ? `${reply.slice(0, MAX_CONSULTATION_REPLY_LENGTH)}\n… (truncated)`
        : reply;
    } catch (error) {
      if (signal?.aborted) throw new WispBackendError("aborted", "The consultation was cancelled.");
      if (timedOut) throw new WispBackendError("aborted", `${targetContext.name} did not answer in time.`, true);
      if (error instanceof WispBackendError) throw error;
      throw providerError(error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onCallerAbort);
      session.dispose();
    }
  };
}

function providerError(message: string | undefined): WispBackendError {
  const described = describeProviderError(sanitizeErrorMessage(message ?? ""));
  return new WispBackendError("internal_error", described.message, described.retryable);
}

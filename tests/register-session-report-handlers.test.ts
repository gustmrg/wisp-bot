import { describe, expect, it, vi } from "vitest";

import { WISP_IPC_CHANNELS, type WispSessionReport } from "../shared/contracts.js";
import { WispBackendError } from "../backend/backend-error.js";
import type { SessionReportService } from "../backend/session-report-service.js";
import { registerSessionReportHandlers } from "../electron/ipc/register-session-report-handlers.js";

const REPORT: WispSessionReport = {
  sessionId: "pi-session-1",
  generatedAt: "2026-09-03T12:00:00.000Z",
  turns: 1,
  totals: {
    inputTokens: 1_000,
    outputTokens: 200,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 1_200,
    costUsd: null,
  },
  models: [
    {
      providerId: "openrouter",
      modelId: "openai/gpt-oss-120b",
      turns: 1,
      usage: { inputTokens: 1_000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1_200 },
      costUsd: null,
    },
  ],
  toolCalls: [],
  events: [],
};

function createIpcMain() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
  };
  return { ipcMain, handlers };
}

function createService(
  getSessionReport: (conversationId: string) => Promise<WispSessionReport | null>,
): SessionReportService {
  return { getSessionReport } as unknown as SessionReportService;
}

describe("registerSessionReportHandlers", () => {
  it("returns the session report for a valid request", async () => {
    const { ipcMain, handlers } = createIpcMain();
    const getSessionReport = vi.fn(async () => REPORT);
    const registration = registerSessionReportHandlers(ipcMain as never, createService(getSessionReport), () => true);
    const handler = handlers.get(WISP_IPC_CHANNELS.getSessionReport);

    await expect(handler?.({}, { conversationId: "wisp-1" })).resolves.toEqual({ ok: true, value: REPORT });
    expect(getSessionReport).toHaveBeenCalledWith("wisp-1");

    registration.dispose();
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(WISP_IPC_CHANNELS.getSessionReport);
  });

  it("returns null when the Wisp has no Pi session", async () => {
    const { ipcMain, handlers } = createIpcMain();
    const registration = registerSessionReportHandlers(
      ipcMain as never,
      createService(async () => null),
      () => true,
    );
    const handler = handlers.get(WISP_IPC_CHANNELS.getSessionReport);

    await expect(handler?.({}, { conversationId: "wisp-1" })).resolves.toEqual({ ok: true, value: null });

    registration.dispose();
  });

  it("rejects untrusted senders and invalid payloads, and sanitizes service errors", async () => {
    const { ipcMain, handlers } = createIpcMain();
    const service = createService(async () => {
      throw new WispBackendError("not_found", "The conversation was not found.");
    });
    const untrusted = registerSessionReportHandlers(ipcMain as never, service, () => false);
    const untrustedHandler = handlers.get(WISP_IPC_CHANNELS.getSessionReport);

    await expect(untrustedHandler?.({}, { conversationId: "wisp-1" })).resolves.toEqual({
      ok: false,
      error: { code: "invalid_request", message: "The backend request is invalid.", retryable: false },
    });

    const trusted = registerSessionReportHandlers(ipcMain as never, service, () => true);
    const trustedHandler = handlers.get(WISP_IPC_CHANNELS.getSessionReport);

    await expect(trustedHandler?.({}, { conversationId: "../invalid" })).resolves.toEqual({
      ok: false,
      error: { code: "invalid_request", message: "The backend request is invalid.", retryable: false },
    });
    await expect(trustedHandler?.({}, { conversationId: "missing" })).resolves.toEqual({
      ok: false,
      error: { code: "not_found", message: "The conversation was not found.", retryable: false },
    });

    trusted.dispose();
    untrusted.dispose();
  });
});

it("authorizes and validates usage requests before reading history, and disposes the handler", async () => {
  const { ipcMain, handlers } = createIpcMain();
  const getUsageReport = vi.fn(async () => ({ period: "7d", wisps: [] }));
  const service = { getUsageReport } as unknown as SessionReportService;
  const untrusted = registerSessionReportHandlers(ipcMain as never, service, () => false);
  await expect(handlers.get(WISP_IPC_CHANNELS.getUsageReport)?.({}, { period: "7d" })).resolves.toMatchObject({
    ok: false,
  });
  expect(getUsageReport).not.toHaveBeenCalled();
  untrusted.dispose();
  const registration = registerSessionReportHandlers(ipcMain as never, service, () => true);
  const handler = handlers.get(WISP_IPC_CHANNELS.getUsageReport);
  for (const payload of [null, {}, { period: "../../private" }, { period: 7 }]) {
    await expect(handler?.({}, payload)).resolves.toMatchObject({ ok: false, error: { code: "invalid_request" } });
  }
  expect(getUsageReport).not.toHaveBeenCalled();
  await expect(handler?.({}, { period: "7d" })).resolves.toMatchObject({ ok: true, value: { period: "7d" } });
  expect(getUsageReport).toHaveBeenCalledWith({ period: "7d" });
  registration.dispose();
  expect(ipcMain.removeHandler).toHaveBeenCalledWith(WISP_IPC_CHANNELS.getUsageReport);
});

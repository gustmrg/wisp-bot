import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type {
  AiSettingsView,
  ConversationAgentEvent,
  ConversationModelView,
  ModelSelection,
} from "../../shared/contracts";
import { WispModelSettings } from "./wisp-model-settings";

const globalModel = { providerId: "provider-a", modelId: "model-a" };
const providers: AiSettingsView["providers"] = ["a", "b"].map((id) => ({
  id: `provider-${id}`,
  name: `Provider ${id}`,
  credentialConfigured: true,
  models: [
    {
      id: `model-${id}`,
      name: `Model ${id}`,
      reasoning: false,
      input: ["text"],
      contextWindow: 10000,
      maxOutputTokens: 1000,
    },
  ],
}));
function api(configured = true) {
  let view: ConversationModelView = {
    override: null,
    effective: globalModel,
    applied: globalModel,
    pending: null,
    status: "idle",
  };
  const applyModel = vi.fn(async ({ model }: { model: ModelSelection | null }) => {
    view = { ...view, override: model, effective: model ?? globalModel, applied: model ?? globalModel };
    return { ok: true, value: {} };
  });
  Object.defineProperty(window, "wisp", {
    configurable: true,
    value: {
      getAiSettings: vi.fn(async () => ({
        ok: true,
        value: {
          selection: globalModel,
          secureStorageAvailable: true,
          providers: providers.map((provider) => ({ ...provider, credentialConfigured: configured })),
        },
      })),
      getConversationModel: vi.fn(async () => ({ ok: true, value: view })),
      subscribeToAgentEvents: vi.fn(() => () => undefined),
      applyModel,
    },
  });
  return { applyModel };
}
describe("WispModelSettings", () => {
  it("saves a separate provider and model only for the selected Wisp, then restores inheritance", async () => {
    const { applyModel } = api();
    const user = userEvent.setup();
    render(<WispModelSettings conversationId="wisp-one" />);
    const inherit = await screen.findByRole("checkbox", { name: "Use global model" });
    await user.click(inherit);
    await user.click(screen.getByRole("combobox", { name: "Provider" }));
    await user.click(await screen.findByRole("option", { name: "Provider b" }));
    await user.type(screen.getByLabelText("Maximum output tokens"), "512");
    await user.click(screen.getByRole("button", { name: "Save model" }));
    await waitFor(() =>
      expect(applyModel).toHaveBeenCalledWith({
        conversationId: "wisp-one",
        model: { providerId: "provider-b", modelId: "model-b", maxOutputTokens: 512 },
      }),
    );
    expect(await screen.findByText("Current model: provider-b / model-b")).toBeVisible();
    await user.click(inherit);
    await user.click(screen.getByRole("button", { name: "Save model" }));
    await waitFor(() => expect(applyModel).toHaveBeenLastCalledWith({ conversationId: "wisp-one", model: null }));
  });
  it("prevents saving an override without its shared provider key", async () => {
    const { applyModel } = api(false);
    const user = userEvent.setup();
    render(<WispModelSettings conversationId="wisp-one" />);
    await user.click(await screen.findByRole("checkbox", { name: "Use global model" }));
    expect(screen.getByRole("button", { name: "Save model" })).toBeDisabled();
    expect(screen.getByText(/Configure this provider's API key/)).toBeVisible();
    expect(applyModel).not.toHaveBeenCalled();
  });
});

it("retains the edit revision when a newer model event refreshes the status view", async () => {
  api();
  let view: ConversationModelView = {
    revision: 7,
    override: globalModel,
    effective: globalModel,
    applied: globalModel,
    pending: null,
    status: "idle",
  };
  let onEvent: ((event: ConversationAgentEvent) => void) | undefined;
  const getConversationModel = vi.fn(async () => ({ ok: true as const, value: view }));
  const applyModel = vi.fn(async () => ({
    ok: false as const,
    error: { code: "conflict", message: "Changed on another device. Reload." },
  }));
  Object.assign(window.wisp, {
    getConversationModel,
    applyModel,
    subscribeToAgentEvents: (listener: (event: ConversationAgentEvent) => void) => {
      onEvent = listener;
      return () => undefined;
    },
  });
  const user = userEvent.setup();
  render(<WispModelSettings conversationId="wisp-one" />);
  await user.type(await screen.findByLabelText("Maximum output tokens"), "512");
  view = { ...view, revision: 8, applied: { providerId: "provider-b", modelId: "model-b" } };
  await act(async () => onEvent?.({ type: "conversation_status", conversationId: "wisp-one", status: "idle" }));
  expect(await screen.findByText("Current model: provider-b / model-b")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Save model" }));
  expect(applyModel).toHaveBeenLastCalledWith({
    conversationId: "wisp-one",
    expectedRevision: 7,
    model: { ...globalModel, maxOutputTokens: 512 },
  });
  await user.click(await screen.findByRole("button", { name: "Reload server settings" }));
  await waitFor(() => expect(screen.getByLabelText("Maximum output tokens")).toHaveValue(null));
  await user.type(screen.getByLabelText("Maximum output tokens"), "256");
  await user.click(screen.getByRole("button", { name: "Save model" }));
  expect(applyModel).toHaveBeenLastCalledWith({
    conversationId: "wisp-one",
    expectedRevision: 8,
    model: { ...globalModel, maxOutputTokens: 256 },
  });
});

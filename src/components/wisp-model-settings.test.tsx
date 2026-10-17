import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AiSettingsView, ConversationModelView, ModelSelection } from "../../shared/contracts";
import { WispModelSettings } from "./wisp-model-settings";

const globalModel: ModelSelection = { providerId: "provider-a", modelId: "model-a" };
const providers: AiSettingsView["providers"] = ["a", "b"].map((id) => ({
  id: `provider-${id}`,
  name: `Provider ${id}`,
  credentialConfigured: true,
  models: [
    {
      id: `model-${id}`,
      name: `Model ${id}`,
      reasoning: false,
      thinkingLevels: ["off"],
      input: ["text"],
      contextWindow: 10000,
      maxOutputTokens: 1000,
    },
  ],
}));

const baseView: ConversationModelView = {
  override: null,
  effective: globalModel,
  applied: globalModel,
  pending: null,
  fallback: "global",
  status: "idle",
};

const reasoningProviders: AiSettingsView["providers"] = providers.map((provider) => ({
  ...provider,
  models: provider.models.map((model) => ({ ...model, reasoning: true, thinkingLevels: ["off", "low", "high"] })),
}));

function api(
  view: ConversationModelView,
  configured = true,
  auxiliary?: AiSettingsView["auxiliary"],
  catalog = providers,
  fallback: AiSettingsView["fallback"] = { selection: null, unavailable: null },
) {
  const applyModel = vi.fn(async () => ({ ok: true, value: {} }));
  const applyFallbackModel = vi.fn(async () => ({ ok: true, value: {} }));
  Object.defineProperty(window, "wisp", {
    configurable: true,
    value: {
      applyModel,
      applyFallbackModel,
      getAiSettings: vi.fn(async () => ({
        ok: true,
        value: {
          selection: globalModel,
          fallback,
          secureStorageAvailable: true,
          providers: catalog.map((provider) => ({ ...provider, credentialConfigured: configured })),
          ...(auxiliary ? { auxiliary } : {}),
        },
      })),
      getConversationModel: vi.fn(async () => ({ ok: true, value: view })),
      subscribeToAgentEvents: vi.fn(() => () => undefined),
    },
  });
  return Object.assign(applyModel, { applyFallbackModel });
}

describe("WispModelSettings", () => {
  it("shows the applied model read-only, noting that it follows the global model", async () => {
    api(baseView);
    render(<WispModelSettings conversationId="wisp-one" />);

    expect(await screen.findByText("Provider a")).toBeVisible();
    expect(screen.getByText("model-a")).toBeVisible();
    expect(screen.queryByText(/set when the Wisp is created/)).not.toBeInTheDocument();
    expect(screen.getByText(/follows the global model/)).toBeVisible();
    expect(screen.queryByRole("combobox", { name: "Reasoning" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save model" })).not.toBeInTheDocument();
  });

  it("omits the global-model note when a per-Wisp override is applied", async () => {
    const override: ModelSelection = { providerId: "provider-b", modelId: "model-b" };
    api({ ...baseView, override, effective: override, applied: override });
    render(<WispModelSettings conversationId="wisp-one" />);

    expect(await screen.findByText("Provider b")).toBeVisible();
    expect(screen.getByText("model-b")).toBeVisible();
    expect(screen.queryByText(/follows the global model/)).not.toBeInTheDocument();
  });

  it("changes the reasoning level of a Wisp with its own model, explaining the cost on hover", async () => {
    const user = userEvent.setup();
    const override: ModelSelection = { providerId: "provider-b", modelId: "model-b", maxOutputTokens: 500 };
    const applyModel = api(
      { ...baseView, override, effective: override, applied: override },
      true,
      undefined,
      reasoningProviders,
    );
    render(<WispModelSettings conversationId="wisp-one" />);

    const select = await screen.findByRole("combobox", { name: "Reasoning" });
    expect(select).toHaveTextContent("Off");
    expect(screen.queryByText(/Reasoning uses more tokens/)).not.toBeInTheDocument();
    await user.hover(screen.getByRole("button", { name: "About reasoning cost" }));
    expect(await screen.findByText(/Reasoning uses more tokens/)).toBeVisible();
    await user.unhover(screen.getByRole("button", { name: "About reasoning cost" }));
    await user.click(select);
    expect(screen.queryByRole("option", { name: "Medium" })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("option", { name: "High" }));

    expect(applyModel).toHaveBeenCalledWith({
      conversationId: "wisp-one",
      model: { ...override, thinkingLevel: "high" },
    });
  });

  it("shows the global reasoning level for a Wisp that follows the global model", async () => {
    const global: ModelSelection = { ...globalModel, thinkingLevel: "low" };
    api({ ...baseView, effective: global, applied: global }, true, undefined, reasoningProviders);
    render(<WispModelSettings conversationId="wisp-one" />);

    expect(await screen.findByText(/Reasoning: Low/)).toBeVisible();
    expect(screen.queryByRole("combobox", { name: "Reasoning" })).not.toBeInTheDocument();
  });

  it("lets a Wisp with its own model turn on the global fallback or choose a model of its own", async () => {
    const user = userEvent.setup();
    const override: ModelSelection = { providerId: "provider-b", modelId: "model-b" };
    const { applyFallbackModel } = api(
      { ...baseView, override, effective: override, applied: override, fallback: "off" },
      true,
      undefined,
      providers,
      { selection: globalModel, unavailable: null },
    );
    render(<WispModelSettings conversationId="wisp-one" />);

    const select = await screen.findByRole("combobox", { name: "Fallback model" });
    expect(select).toHaveTextContent("Off");
    await user.click(select);
    expect(await screen.findByRole("option", { name: /Use the global fallback.*Model a/ })).toBeInTheDocument();
    // The Wisp's own model cannot stand in for itself.
    expect(screen.queryByRole("option", { name: /^Model b/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: /^Model a/ }));
    expect(applyFallbackModel).toHaveBeenCalledWith({ conversationId: "wisp-one", fallback: globalModel });

    await user.click(screen.getByRole("combobox", { name: "Fallback model" }));
    await user.click(await screen.findByRole("option", { name: /Use the global fallback/ }));
    expect(applyFallbackModel).toHaveBeenLastCalledWith({ conversationId: "wisp-one", fallback: "global" });
  });

  it("warns when a Wisp uses the global fallback but none is set", async () => {
    api(baseView);
    render(<WispModelSettings conversationId="wisp-one" />);

    expect(await screen.findByRole("combobox", { name: "Fallback model" })).toHaveTextContent(
      "Use the global fallback",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/No global fallback is set/);
  });

  it("warns when the global fallback is the Wisp's own model", async () => {
    const override: ModelSelection = { providerId: "provider-b", modelId: "model-b" };
    api(
      { ...baseView, override, effective: override, applied: override, fallback: "global" },
      true,
      undefined,
      providers,
      {
        selection: override,
        unavailable: null,
      },
    );
    render(<WispModelSettings conversationId="wisp-one" />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/is this Wisp's own model/);
  });

  it("says when the applied model cannot see images", async () => {
    api(baseView);
    render(<WispModelSettings conversationId="wisp-one" />);

    expect(await screen.findByText("This model can't see images or scanned PDF pages.")).toBeVisible();
  });

  it("names the image model that reads images for it, unless that model is unavailable", async () => {
    const selection = { providerId: "provider-b", modelId: "model-b" };
    api(baseView, true, { imageUnderstanding: { selection, unavailable: null } });
    const { unmount } = render(<WispModelSettings conversationId="wisp-one" />);

    expect(
      await screen.findByText(
        "This model can't see images. Model b (Provider b) reads images and scanned PDF pages for it.",
      ),
    ).toBeVisible();
    unmount();

    api(baseView, true, { imageUnderstanding: { selection, unavailable: "missing_key" } });
    render(<WispModelSettings conversationId="wisp-one" />);
    expect(await screen.findByText("This model can't see images or scanned PDF pages.")).toBeVisible();
  });

  it("warns when the applied provider has no shared API key", async () => {
    api(baseView, false);
    render(<WispModelSettings conversationId="wisp-one" />);

    expect(await screen.findByText(/Configure this provider's API key/)).toBeVisible();
  });
});

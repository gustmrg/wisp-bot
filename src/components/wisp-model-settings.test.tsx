import { render, screen, within } from "@testing-library/react";
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
  contextTokens = 0,
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
      manageContext: vi.fn(async () => ({ ok: true, value: { tokens: contextTokens } })),
      subscribeToAgentEvents: vi.fn(() => () => undefined),
    },
  });
  return Object.assign(applyModel, { applyFallbackModel });
}

describe("WispModelSettings", () => {
  it("shows the applied model, noting that it follows the global model", async () => {
    api(baseView);
    render(<WispModelSettings conversationId="wisp-one" />);

    const current = await screen.findByRole("region", { name: "Current model" });
    expect(within(current).getByText("Model a")).toBeVisible();
    expect(within(current).getByText("Provider a · model-a")).toBeVisible();
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

    const current = await screen.findByRole("region", { name: "Current model" });
    expect(within(current).getByText("Model b")).toBeVisible();
    expect(within(current).getByText("Provider b · model-b")).toBeVisible();
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

  it("lets a Wisp on the global model choose a model of its own", async () => {
    const user = userEvent.setup();
    const applyModel = api(baseView);
    render(<WispModelSettings conversationId="wisp-one" />);

    const select = await screen.findByRole("combobox", { name: "Model" });
    expect(select).toHaveTextContent("Use the global model");
    // Its limit belongs to a model of its own.
    expect(screen.queryByRole("button", { name: "Advanced" })).not.toBeInTheDocument();
    await user.click(select);
    await user.click(await screen.findByRole("option", { name: /^Model b/ }));

    expect(applyModel).toHaveBeenCalledWith({
      conversationId: "wisp-one",
      model: { providerId: "provider-b", modelId: "model-b" },
    });
  });

  it("shows the logo of the lab that made each model it knows", async () => {
    const user = userEvent.setup();
    const catalog = providers.map((provider) =>
      provider.id === "provider-a"
        ? {
            ...provider,
            models: provider.models.map((model) => ({
              ...model,
              id: "anthropic/claude-opus-4.5",
              name: "Claude Opus 4.5",
            })),
          }
        : provider,
    );
    const claude: ModelSelection = { providerId: "provider-a", modelId: "anthropic/claude-opus-4.5" };
    api({ ...baseView, override: claude, effective: claude, applied: claude }, true, undefined, catalog);
    render(<WispModelSettings conversationId="wisp-one" />);

    const select = await screen.findByRole("combobox", { name: "Model" });
    expect(select).toHaveTextContent("Claude Opus 4.5");
    expect(select.querySelector("img")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Current model" }).querySelector("img")).toBeInTheDocument();
    await user.click(select);
    expect((await screen.findByRole("option", { name: /^Claude Opus 4.5/ })).querySelector("img")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /^Model b/ }).querySelector("img")).not.toBeInTheDocument();
  });

  it("lets a Wisp with its own model follow the global model again", async () => {
    const user = userEvent.setup();
    const override: ModelSelection = { providerId: "provider-b", modelId: "model-b" };
    const applyModel = api({ ...baseView, override, effective: override, applied: override });
    render(<WispModelSettings conversationId="wisp-one" />);

    await user.click(await screen.findByRole("combobox", { name: "Model" }));
    await user.click(await screen.findByRole("option", { name: /Use the global model.*Model a/ }));

    expect(applyModel).toHaveBeenCalledWith({ conversationId: "wisp-one", model: null });
  });

  it("keeps the reasoning level and the limit when the new model allows them", async () => {
    const user = userEvent.setup();
    const override: ModelSelection = {
      providerId: "provider-b",
      modelId: "model-b",
      maxOutputTokens: 500,
      thinkingLevel: "high",
    };
    const view = { ...baseView, override, effective: override, applied: override };
    const applyModel = api(view, true, undefined, reasoningProviders);
    const { unmount } = render(<WispModelSettings conversationId="wisp-one" />);

    await user.click(await screen.findByRole("combobox", { name: "Model" }));
    await user.click(await screen.findByRole("option", { name: /^Model a/ }));
    expect(applyModel).toHaveBeenCalledWith({
      conversationId: "wisp-one",
      model: { providerId: "provider-a", modelId: "model-a", maxOutputTokens: 500, thinkingLevel: "high" },
    });
    unmount();

    // A model that answers less, and cannot reason, drops both.
    const smaller = providers.map((provider) =>
      provider.id === "provider-a"
        ? { ...provider, models: provider.models.map((model) => ({ ...model, maxOutputTokens: 100 })) }
        : provider,
    );
    const applyToSmaller = api(view, true, undefined, smaller);
    render(<WispModelSettings conversationId="wisp-one" />);
    await user.click(await screen.findByRole("combobox", { name: "Model" }));
    await user.click(await screen.findByRole("option", { name: /^Model a/ }));
    expect(applyToSmaller).toHaveBeenCalledWith({
      conversationId: "wisp-one",
      model: { providerId: "provider-a", modelId: "model-a" },
    });
  });

  it("marks models that cannot see images or hold the conversation before one is chosen", async () => {
    const user = userEvent.setup();
    const catalog = providers.map((provider) =>
      provider.id === "provider-a"
        ? { ...provider, models: provider.models.map((model) => ({ ...model, input: ["text", "image"] as const })) }
        : { ...provider, models: provider.models.map((model) => ({ ...model, contextWindow: 5000 })) },
    );
    api(baseView, true, undefined, catalog, undefined, 8000);
    render(<WispModelSettings conversationId="wisp-one" />);

    await user.click(await screen.findByRole("combobox", { name: "Model" }));
    expect(
      await screen.findByRole("option", { name: /^Model b.*No image input · Too small for this conversation/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /^Model a/ })).not.toHaveTextContent(/No image input|Too small/);
  });

  it("warns when the conversation is larger than the Wisp's model can hold", async () => {
    const override: ModelSelection = { providerId: "provider-b", modelId: "model-b" };
    api(
      { ...baseView, override, effective: override, applied: override },
      true,
      undefined,
      providers,
      undefined,
      20000,
    );
    render(<WispModelSettings conversationId="wisp-one" />);

    expect(await screen.findByText(/larger than this model's context window/)).toBeVisible();
  });

  it("sets a Wisp's maximum output tokens under Advanced", async () => {
    const user = userEvent.setup();
    const override: ModelSelection = { providerId: "provider-b", modelId: "model-b" };
    const applyModel = api({ ...baseView, override, effective: override, applied: override });
    render(<WispModelSettings conversationId="wisp-one" />);

    expect(await screen.findByRole("combobox", { name: "Model" })).toBeVisible();
    expect(screen.queryByRole("spinbutton", { name: "Maximum output tokens" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Advanced" }));
    const field = await screen.findByRole("spinbutton", { name: "Maximum output tokens" });
    await user.type(field, "2000");
    expect(screen.getByText(/must be a whole number between 1 and 1,000/)).toBeVisible();
    await user.tab();
    expect(applyModel).not.toHaveBeenCalled();

    await user.clear(field);
    await user.type(field, "800{Enter}");
    expect(applyModel).toHaveBeenCalledTimes(1);
    expect(applyModel).toHaveBeenCalledWith({
      conversationId: "wisp-one",
      model: { ...override, maxOutputTokens: 800 },
    });
  });

  it("opens Advanced when the Wisp has a limit, and clearing it goes back to automatic", async () => {
    const user = userEvent.setup();
    const override: ModelSelection = { providerId: "provider-b", modelId: "model-b", maxOutputTokens: 500 };
    const applyModel = api({ ...baseView, override, effective: override, applied: override });
    render(<WispModelSettings conversationId="wisp-one" />);

    const field = await screen.findByRole("spinbutton", { name: "Maximum output tokens" });
    expect(field).toHaveValue(500);
    await user.clear(field);
    await user.tab();

    expect(applyModel).toHaveBeenCalledWith({
      conversationId: "wisp-one",
      model: { providerId: "provider-b", modelId: "model-b" },
    });
  });

  it("keeps a fallback of its own from its model's provider, marked unavailable, and says why", async () => {
    const override: ModelSelection = { providerId: "provider-b", modelId: "model-b" };
    api({ ...baseView, override, effective: override, applied: override, fallback: override });
    render(<WispModelSettings conversationId="wisp-one" />);

    expect(await screen.findByRole("combobox", { name: "Fallback model" })).toHaveTextContent("(unavailable)");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This fallback is from Provider b, the provider of this Wisp's model, so it fails along with it.",
    );
  });

  it("offers no fallback from the provider of the Wisp's model", async () => {
    const user = userEvent.setup();
    const catalog = providers.map((provider) =>
      provider.id === "provider-b"
        ? { ...provider, models: [...provider.models, { ...provider.models[0]!, id: "mini-b", name: "Mini b" }] }
        : provider,
    );
    const override: ModelSelection = { providerId: "provider-b", modelId: "model-b" };
    api({ ...baseView, override, effective: override, applied: override, fallback: "off" }, true, undefined, catalog);
    render(<WispModelSettings conversationId="wisp-one" />);

    await user.click(await screen.findByRole("combobox", { name: "Fallback model" }));
    expect(await screen.findByRole("option", { name: /^Model a/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /^Model b/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /^Mini b/ })).not.toBeInTheDocument();
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
    // The provider of the Wisp's own model cannot stand in for it.
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

  it("warns when the global fallback is from the provider of the Wisp's own model", async () => {
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

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The global fallback is from Provider b, the provider of this Wisp's model, so it fails along with it.",
    );
  });

  it("uses a global fallback from the global model's provider for a Wisp on another provider", async () => {
    const override: ModelSelection = { providerId: "provider-b", modelId: "model-b" };
    api(
      { ...baseView, override, effective: override, applied: override, fallback: "global" },
      true,
      undefined,
      providers,
      { selection: globalModel, unavailable: "same_provider" },
    );
    render(<WispModelSettings conversationId="wisp-one" />);

    expect(await screen.findByRole("combobox", { name: "Fallback model" })).toHaveTextContent(
      "Use the global fallback",
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
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

    expect(await screen.findByText(/Add this provider's API key/)).toBeVisible();
  });
});

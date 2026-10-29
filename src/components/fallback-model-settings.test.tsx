import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { FallbackModelSettings } from "@/components/fallback-model-settings";
import type { AiSettingsView, FallbackModelView } from "../../shared/contracts";

function model(id: string) {
  return {
    id,
    name: id.toUpperCase(),
    reasoning: false,
    thinkingLevels: ["off" as const],
    input: ["text" as const],
    contextWindow: 10_000,
    maxOutputTokens: 1_000,
  };
}

function view(
  fallback: FallbackModelView = { selection: null, unavailable: null },
  selection = { providerId: "openai", modelId: "main" },
): AiSettingsView {
  return {
    selection,
    auxiliary: { imageUnderstanding: { selection: null, unavailable: null } },
    fallback,
    secureStorageAvailable: true,
    providers: [
      { id: "openai", name: "OpenAI", credentialConfigured: true, models: [model("main"), model("mini")] },
      { id: "google", name: "Google", credentialConfigured: false, models: [model("gemini")] },
      { id: "mistral", name: "Mistral", credentialConfigured: true, models: [model("large")] },
    ],
    catalogError: null,
  };
}

function renderSettings(initial: AiSettingsView) {
  const saved = view({ selection: { providerId: "mistral", modelId: "large" }, unavailable: null });
  const saveFallbackModel = vi.fn(async () => ({ ok: true as const, value: saved }));
  Object.defineProperty(window, "wisp", { configurable: true, value: { saveFallbackModel } });
  const onViewChange = vi.fn();
  render(<FallbackModelSettings view={initial} onViewChange={onViewChange} />);
  return { saveFallbackModel, onViewChange, saved };
}

describe("FallbackModelSettings", () => {
  it("lists models from other providers with a saved key, and saves the choice", async () => {
    const user = userEvent.setup();
    const { saveFallbackModel, onViewChange, saved } = renderSettings(view());

    await user.click(screen.getByRole("combobox", { name: "Fallback model" }));

    expect(await screen.findByRole("option", { name: /Off/ })).toBeInTheDocument();
    // OpenAI is the global model's provider, so none of its models is offered, and Google has no key.
    expect(screen.queryByRole("option", { name: /MAIN/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /MINI/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /GEMINI/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: /LARGE/ }));

    expect(saveFallbackModel).toHaveBeenCalledWith({ selection: { providerId: "mistral", modelId: "large" } });
    expect(onViewChange).toHaveBeenCalledWith(saved);
    expect(screen.getByText("Fallback model saved.")).toBeInTheDocument();
  });

  it("turns the fallback off", async () => {
    const user = userEvent.setup();
    const { saveFallbackModel } = renderSettings(
      view({ selection: { providerId: "mistral", modelId: "large" }, unavailable: null }),
    );

    await user.click(screen.getByRole("combobox", { name: "Fallback model" }));
    await user.click(await screen.findByRole("option", { name: /Off/ }));

    expect(saveFallbackModel).toHaveBeenCalledWith({ selection: null });
  });

  it("says why a saved model is not used and keeps it selected", () => {
    renderSettings(view({ selection: { providerId: "google", modelId: "gemini" }, unavailable: "missing_key" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Add an API key for Google to use this model.");
    expect(screen.getByRole("combobox", { name: "Fallback model" })).toHaveTextContent("gemini (unavailable)");
  });

  it("says a saved fallback from the global model's provider fails along with it", () => {
    renderSettings(view({ selection: { providerId: "openai", modelId: "mini" }, unavailable: "same_provider" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "This model is from OpenAI, the global model's provider, so it fails along with it.",
    );
    expect(screen.getByRole("combobox", { name: "Fallback model" })).toHaveTextContent("mini (unavailable)");
  });

  it("warns as soon as the global model moves to the fallback's provider", () => {
    const fallback = { selection: { providerId: "mistral", modelId: "large" }, unavailable: null };
    const { rerender } = render(<FallbackModelSettings view={view(fallback)} onViewChange={vi.fn()} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    rerender(
      <FallbackModelSettings
        view={view(fallback, { providerId: "mistral", modelId: "large" })}
        onViewChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("This model is from Mistral, the global model's provider");
  });
});

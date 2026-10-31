import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ModelSettingsSection } from "@/components/model-settings-section";
import type { AiSettingsView } from "../../shared/contracts";

function model(id: string) {
  return {
    id,
    name: id.toUpperCase(),
    reasoning: false,
    thinkingLevels: ["off" as const],
    input: ["text" as const, "image" as const],
    contextWindow: 10_000,
    maxOutputTokens: 1_000,
  };
}

function aiView(selection: AiSettingsView["selection"]): AiSettingsView {
  return {
    selection,
    auxiliary: { imageUnderstanding: { selection: null, unavailable: null } },
    fallback: { selection: null, unavailable: null },
    secureStorageAvailable: true,
    providers: [
      { id: "openrouter", name: "OpenRouter", credentialConfigured: true, models: [model("alpha")] },
      { id: "groq", name: "Groq", credentialConfigured: true, models: [model("beta")] },
      { id: "google", name: "Google", credentialConfigured: false, models: [model("gemini")] },
    ],
    catalogError: null,
  };
}

function renderSection(selection: AiSettingsView["selection"] = { providerId: "openrouter", modelId: "alpha" }) {
  const saveAiSettings = vi.fn(async ({ selection: next }: { selection: NonNullable<typeof selection> }) => ({
    ok: true as const,
    value: aiView(next),
  }));
  Object.defineProperty(window, "wisp", {
    configurable: true,
    value: { getAiSettings: vi.fn(async () => ({ ok: true as const, value: aiView(selection) })), saveAiSettings },
  });
  const onOpenProviders = vi.fn();
  render(<ModelSettingsSection onOpenProviders={onOpenProviders} />);
  return { saveAiSettings, onOpenProviders };
}

describe("ModelSettingsSection", () => {
  it("lists models across connected providers and saves the choice at once", async () => {
    const user = userEvent.setup();
    const { saveAiSettings } = renderSection();

    await user.click(await screen.findByRole("combobox", { name: "Default model" }));
    expect(await screen.findByRole("option", { name: /ALPHA/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /GEMINI/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: /BETA/ }));

    expect(saveAiSettings).toHaveBeenCalledWith({ selection: { providerId: "groq", modelId: "beta" } });
    expect(await screen.findByText("Default model saved.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  it("asks for a model while none can be used", async () => {
    renderSection(null);

    expect(await screen.findByText("Wisps can't respond until you choose one.")).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Default model" })).toHaveTextContent("Choose a model");
  });

  it("saves the output limit when leaving the field, keeping the model", async () => {
    const { saveAiSettings } = renderSection({ providerId: "openrouter", modelId: "alpha", maxOutputTokens: 500 });

    const limit = await screen.findByLabelText("Maximum output tokens");
    fireEvent.change(limit, { target: { value: "800" } });
    fireEvent.blur(limit);

    await waitFor(() =>
      expect(saveAiSettings).toHaveBeenCalledWith({
        selection: { providerId: "openrouter", modelId: "alpha", maxOutputTokens: 800 },
      }),
    );
  });

  it("does not save an output limit above the model's", async () => {
    const { saveAiSettings } = renderSection({ providerId: "openrouter", modelId: "alpha", maxOutputTokens: 500 });

    const limit = await screen.findByLabelText("Maximum output tokens");
    fireEvent.change(limit, { target: { value: "5000" } });
    fireEvent.blur(limit);

    expect(screen.getByRole("alert")).toHaveTextContent("between 1 and");
    expect(saveAiSettings).not.toHaveBeenCalled();
  });

  it("opens Providers from the introduction", async () => {
    const user = userEvent.setup();
    const { onOpenProviders } = renderSection();

    await user.click(await screen.findByRole("button", { name: "providers" }));

    expect(onOpenProviders).toHaveBeenCalledOnce();
  });
});

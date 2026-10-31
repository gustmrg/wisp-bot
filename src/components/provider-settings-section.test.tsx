import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import groqLogo from "@/assets/providers/groq.svg";
import openrouterLogo from "@/assets/providers/openrouter.svg";
import { ProviderSettingsSection } from "@/components/provider-settings-section";
import type { AiSettingsView, ProviderSummary } from "../../shared/contracts";

function provider(id: string, name: string, extra: Partial<ProviderSummary> = {}): ProviderSummary {
  return { id, name, credentialConfigured: false, models: [], ...extra };
}

function aiView(overrides: Partial<AiSettingsView> = {}): AiSettingsView {
  return {
    selection: { providerId: "openrouter", modelId: "model" },
    auxiliary: { imageUnderstanding: { selection: null, unavailable: null } },
    fallback: { selection: null, unavailable: null },
    secureStorageAvailable: true,
    providers: [
      provider("groq", "Groq"),
      provider("openai", "OpenAI", {
        credentialConfigured: true,
        credentialKind: "subscription",
        subscriptionSignIn: { label: "Sign in with ChatGPT" },
      }),
      provider("openrouter", "OpenRouter", { credentialConfigured: true, credentialKind: "api_key" }),
    ],
    decisionProviders: [{ id: "typesafe", name: "TypeSafe", credentialConfigured: false, models: [] }],
    catalogError: null,
    ...overrides,
  };
}

function renderSection(initial: AiSettingsView = aiView()) {
  const saved = aiView({
    providers: [
      provider("groq", "Groq", { credentialConfigured: true, credentialKind: "api_key" }),
      ...initial.providers.slice(1),
    ],
  });
  const api = {
    getAiSettings: vi.fn(async () => ({ ok: true as const, value: initial })),
    saveAiSettings: vi.fn(),
    saveProviderKey: vi.fn(async () => ({ ok: true as const, value: saved })),
    removeProviderCredential: vi.fn(async () => ({ ok: true as const, value: aiView() })),
  };
  Object.defineProperty(window, "wisp", { configurable: true, value: api });
  render(<ProviderSettingsSection />);
  return api;
}

describe("ProviderSettingsSection", () => {
  it("says at a glance which providers are connected and how", async () => {
    renderSection();

    const connected = within(await screen.findByRole("region", { name: "Connected" }));
    expect(connected.getByText("OpenRouter")).toBeVisible();
    expect(connected.getByText("API key saved")).toBeVisible();
    expect(connected.getByText("Signed in with your subscription · Also used for voice")).toBeVisible();
    expect(connected.queryByText("Groq")).not.toBeInTheDocument();
  });

  it("shows each connected provider's logo, or its initial when it has none", async () => {
    renderSection(
      aiView({
        providers: [
          provider("openrouter", "OpenRouter", { credentialConfigured: true, credentialKind: "api_key" }),
          provider("radius", "Radius", { credentialConfigured: true, credentialKind: "api_key" }),
        ],
      }),
    );

    const connected = await screen.findByRole("region", { name: "Connected" });
    const logos = [...connected.querySelectorAll("img")].map((logo) => logo.getAttribute("src"));
    expect(logos).toEqual([openrouterLogo]);
    expect(within(connected).getByText("R")).toHaveAttribute("aria-hidden", "true");
  });

  it("shows logos in the list of providers to add", async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(await screen.findByRole("combobox", { name: "Provider" }));

    const groq = await screen.findByRole("option", { name: /Groq/ });
    expect(groq.querySelector("img")).toHaveAttribute("src", groqLogo);
    // TypeSafe has no logo, and keeps the space so the names stay aligned.
    expect(screen.getByRole("option", { name: /TypeSafe/ }).querySelector("img")).toBeNull();
  });

  it("adds a provider's key without touching the default model", async () => {
    const user = userEvent.setup();
    const api = renderSection();

    await user.click(await screen.findByRole("combobox", { name: "Provider" }));
    await user.click(await screen.findByRole("option", { name: /Groq/ }));
    await user.type(screen.getByLabelText("Groq API key"), "gsk-secret");
    await user.click(screen.getByRole("button", { name: "Save key" }));

    expect(api.saveProviderKey).toHaveBeenCalledWith({ providerId: "groq", apiKey: "gsk-secret" });
    expect(api.saveAiSettings).not.toHaveBeenCalled();
    expect(await screen.findByText("Groq API key saved.")).toBeVisible();
    expect(within(screen.getByRole("region", { name: "Connected" })).getByText("Groq")).toBeVisible();
    expect(screen.queryByLabelText("Groq API key")).not.toBeInTheDocument();
  });

  it("offers providers that have only decision models", async () => {
    const user = userEvent.setup();
    const api = renderSection();

    await user.click(await screen.findByRole("combobox", { name: "Provider" }));
    await user.click(await screen.findByRole("option", { name: /TypeSafe/ }));
    await user.type(screen.getByLabelText("TypeSafe API key"), "secret");
    await user.click(screen.getByRole("button", { name: "Save key" }));

    expect(api.saveProviderKey).toHaveBeenCalledWith({ providerId: "typesafe", apiKey: "secret" });
  });

  it("removes a key after confirmation, saying who loses access", async () => {
    const user = userEvent.setup();
    const api = renderSection();

    await user.click(await screen.findByRole("button", { name: "Manage OpenRouter" }));
    expect(screen.getByLabelText("OpenRouter API key")).toHaveAttribute("placeholder", "Saved — enter a replacement");
    await user.click(screen.getByRole("button", { name: "Remove key" }));
    expect(screen.getByText("Wisps using OpenRouter stop working until you enter a new key.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Remove key" }));

    expect(api.removeProviderCredential).toHaveBeenCalledWith({ providerId: "openrouter" });
  });

  it("asks to update a server that cannot save a key on its own", async () => {
    const user = userEvent.setup();
    const { decisionProviders: _missing, ...older } = aiView();
    renderSection(older);

    await user.click(await screen.findByRole("button", { name: "Manage OpenRouter" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Update this server to add keys here.");
    expect(screen.getByLabelText("OpenRouter API key")).toBeDisabled();
  });
});

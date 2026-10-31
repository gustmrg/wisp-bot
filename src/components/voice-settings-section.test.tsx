import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { VoiceSettingsSection } from "@/components/voice-settings-section";
import { DEFAULT_PREFERENCES, type AppPreferences } from "@/lib/app-preferences";
import type { VoiceSettingsView } from "../../shared/voice";

/** `voiceOnly` lists providers whose key is kept for voice input alone, beside a subscription sign-in. */
function view(configured: ReadonlyArray<string>, voiceOnly: ReadonlyArray<string> = []): VoiceSettingsView {
  const status = (id: "groq" | "openai" | "mistral", name: string) => ({
    id,
    name,
    credentialConfigured: configured.includes(id),
    ...(configured.includes(id) ? { credentialSource: voiceOnly.includes(id) ? "voice" : "shared" } : {}),
  });
  return {
    secureStorageAvailable: true,
    providers: [status("groq", "Groq"), status("openai", "OpenAI"), status("mistral", "Mistral")],
  } as VoiceSettingsView;
}

function renderSection(
  preferences: AppPreferences = DEFAULT_PREFERENCES,
  configured: ReadonlyArray<string> = [],
  voiceOnly: ReadonlyArray<string> = [],
) {
  let saved = [...configured];
  const saveVoiceCredential = vi.fn(async () => {
    saved = [...saved, "groq"];
    return { ok: true as const, value: view(saved, voiceOnly) };
  });
  const removeVoiceCredential = vi.fn(async ({ providerId }: { providerId: string }) => {
    saved = saved.filter((id) => id !== providerId);
    return { ok: true as const, value: view(saved, voiceOnly) };
  });
  Object.defineProperty(window, "wisp", {
    configurable: true,
    value: {
      getVoiceSettings: vi.fn(async () => ({ ok: true as const, value: view(saved, voiceOnly) })),
      saveVoiceCredential,
      removeVoiceCredential,
    },
  });
  const onPreferencesChange = vi.fn();
  const onOpenProviders = vi.fn();
  render(
    <VoiceSettingsSection
      active
      preferences={preferences}
      onPreferencesChange={onPreferencesChange}
      onOpenProviders={onOpenProviders}
    />,
  );
  return { onPreferencesChange, onOpenProviders, saveVoiceCredential, removeVoiceCredential };
}

describe("VoiceSettingsSection", () => {
  it("leaves auto-send off by default and turns it on", async () => {
    const user = userEvent.setup();
    const { onPreferencesChange } = renderSection();
    const autoSend = screen.getByRole("switch", { name: "Send automatically" });

    expect(autoSend).not.toBeChecked();
    expect(screen.getByText(/waits in the composer/)).toBeInTheDocument();
    await user.click(autoSend);

    expect(onPreferencesChange).toHaveBeenCalledWith(expect.objectContaining({ voiceAutoSend: true }));
  });

  it("lists fallback models from other providers with a saved key, and saves the choice", async () => {
    const user = userEvent.setup();
    const { onPreferencesChange } = renderSection(DEFAULT_PREFERENCES, ["groq", "openai"]);
    const picker = screen.getByRole("combobox", { name: "Fallback model" });
    expect(picker).toHaveTextContent("Off");

    await user.click(picker);
    expect(await screen.findByRole("option", { name: /Off/ })).toBeInTheDocument();
    // Groq is the provider above, so none of its models is offered, and Mistral has no key.
    expect(screen.queryByRole("option", { name: /Whisper Large v3/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Voxtral/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: /GPT-4o mini Transcribe/ }));

    expect(onPreferencesChange).toHaveBeenLastCalledWith({
      ...DEFAULT_PREFERENCES,
      voiceFallback: { providerId: "openai", modelId: "gpt-4o-mini-transcribe" },
    });
  });

  it("turns the fallback off", async () => {
    const user = userEvent.setup();
    const voiceFallback = { providerId: "openai" as const, modelId: "whisper-1" };
    const { onPreferencesChange } = renderSection({ ...DEFAULT_PREFERENCES, voiceFallback }, ["groq", "openai"]);

    await user.click(screen.getByRole("combobox", { name: "Fallback model" }));
    await user.click(await screen.findByRole("option", { name: /Off/ }));

    expect(onPreferencesChange).toHaveBeenLastCalledWith({ ...DEFAULT_PREFERENCES, voiceFallback: null });
  });

  it("says a saved fallback on the provider above fails along with it", async () => {
    const voiceFallback = { providerId: "groq" as const, modelId: "whisper-large-v3" };
    renderSection({ ...DEFAULT_PREFERENCES, voiceFallback }, ["groq", "openai"]);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This model is from Groq, the provider above, so it fails along with it.",
    );
    expect(screen.getByRole("combobox", { name: "Fallback model" })).toHaveTextContent(
      "Whisper Large v3 (unavailable)",
    );
  });

  it("says why a saved fallback is not used and keeps it selected", async () => {
    const voiceFallback = { providerId: "mistral" as const, modelId: "voxtral-mini-latest" };
    renderSection({ ...DEFAULT_PREFERENCES, voiceFallback }, ["groq"]);

    expect(await screen.findByRole("alert")).toHaveTextContent("Add an API key for Mistral to use this model.");
    expect(screen.getByRole("combobox", { name: "Fallback model" })).toHaveTextContent(
      "Voxtral Mini Transcribe (unavailable)",
    );
  });

  it("saves a key for the selected provider without keeping it in the form", async () => {
    const user = userEvent.setup();
    const { saveVoiceCredential } = renderSection();
    expect(await screen.findByText(/Add a Groq key to use voice input/)).toBeInTheDocument();

    await user.type(screen.getByLabelText("Groq API key"), "gsk-secret");
    await user.click(screen.getByRole("button", { name: "Save key" }));

    expect(saveVoiceCredential).toHaveBeenCalledWith({ providerId: "groq", apiKey: "gsk-secret" });
    expect(await screen.findByText("Groq key saved.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Groq API key")).not.toBeInTheDocument();
    expect(screen.getByText("Uses your Groq key from Providers.")).toBeInTheDocument();
  });

  it("sends a key shared with chat models to Providers instead of editing it here", async () => {
    const user = userEvent.setup();
    const { onOpenProviders } = renderSection(
      { ...DEFAULT_PREFERENCES, voiceProvider: "openai", voiceModel: "whisper-1" },
      ["openai"],
    );

    expect(await screen.findByText("Uses your OpenAI key from Providers.")).toBeInTheDocument();
    expect(screen.queryByLabelText("OpenAI API key")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove key" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Manage" }));

    expect(onOpenProviders).toHaveBeenCalledOnce();
  });

  it("says a key kept for voice input alone leaves the sign-in in place", async () => {
    const user = userEvent.setup();
    const { removeVoiceCredential } = renderSection(
      { ...DEFAULT_PREFERENCES, voiceProvider: "openai", voiceModel: "whisper-1" },
      ["openai"],
      ["openai"],
    );

    expect(
      await screen.findByText(/Saved for voice input only; your models use your OpenAI sign-in/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove key" }));
    expect(screen.getByText(/Voice input with OpenAI stops working .* Your sign-in is kept/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove key" }));

    expect(removeVoiceCredential).toHaveBeenCalledWith({ providerId: "openai" });
    expect(await screen.findByText(/Add a OpenAI key to use voice input/)).toBeInTheDocument();
  });
});

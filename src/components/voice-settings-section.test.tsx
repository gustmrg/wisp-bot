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
  render(<VoiceSettingsSection active preferences={preferences} onPreferencesChange={onPreferencesChange} />);
  return { onPreferencesChange, saveVoiceCredential, removeVoiceCredential };
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

  it("adds a backup from the providers with a saved key, and removes it", async () => {
    const user = userEvent.setup();
    const { onPreferencesChange } = renderSection(DEFAULT_PREFERENCES, ["groq", "openai"]);
    const add = screen.getByRole("button", { name: "Add backup" });
    await vi.waitFor(() => expect(add).toBeEnabled());

    await user.click(add);
    // The provider's other model comes first; Mistral has no key, so it is never offered.
    expect(onPreferencesChange).toHaveBeenLastCalledWith({
      ...DEFAULT_PREFERENCES,
      voiceFallbacks: [{ providerId: "groq", modelId: "whisper-large-v3" }],
    });
  });

  it("lists saved backups in order, at most two", async () => {
    const user = userEvent.setup();
    const voiceFallbacks = [
      { providerId: "openai" as const, modelId: "whisper-1" },
      { providerId: "mistral" as const, modelId: "voxtral-mini-latest" },
    ];
    const { onPreferencesChange } = renderSection({ ...DEFAULT_PREFERENCES, voiceFallbacks }, ["groq", "openai"]);

    expect(await screen.findByRole("combobox", { name: "Backup 1" })).toHaveTextContent("OpenAI · Whisper");
    // A backup whose key was removed stays listed, and says why it is skipped.
    expect(screen.getByRole("combobox", { name: "Backup 2" })).toHaveTextContent(
      "Mistral · Voxtral Mini Transcribe (no key)",
    );
    expect(screen.getByRole("button", { name: "Add backup" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Remove backup 1" }));
    expect(onPreferencesChange).toHaveBeenLastCalledWith({
      ...DEFAULT_PREFERENCES,
      voiceFallbacks: [{ providerId: "mistral", modelId: "voxtral-mini-latest" }],
    });
  });

  it("says a key is needed before any backup can be added", async () => {
    // Mistral has one model, so with only its key there is nothing to fall back to.
    renderSection({ ...DEFAULT_PREFERENCES, voiceProvider: "mistral", voiceModel: "voxtral-mini-latest" }, ["mistral"]);

    expect(await screen.findByText(/Save a key for another provider to use it as a backup/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Add backup" })).toBeDisabled();
  });

  it("saves a key for the selected provider without keeping it in the form", async () => {
    const user = userEvent.setup();
    const { saveVoiceCredential } = renderSection();
    expect(await screen.findByText(/Add a Groq key to use voice input/)).toBeInTheDocument();

    await user.type(screen.getByLabelText("Groq API key"), "gsk-secret");
    await user.click(screen.getByRole("button", { name: "Save key" }));

    expect(saveVoiceCredential).toHaveBeenCalledWith({ providerId: "groq", apiKey: "gsk-secret" });
    expect(await screen.findByText("Groq key saved.")).toBeInTheDocument();
    expect(screen.getByLabelText("Groq API key")).toHaveValue("");
    expect(screen.getByText(/An encrypted key is saved for Groq/)).toBeInTheDocument();
  });

  it("reuses a key saved for chat models of the same provider", async () => {
    renderSection({ ...DEFAULT_PREFERENCES, voiceProvider: "openai", voiceModel: "whisper-1" }, ["openai"]);

    expect(
      await screen.findByText(/An encrypted key is saved for OpenAI and shared with AI Model/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("OpenAI API key")).toHaveAttribute("placeholder", "Saved — enter a replacement");
  });

  it("removes the saved key after confirmation", async () => {
    const user = userEvent.setup();
    const { removeVoiceCredential } = renderSection(DEFAULT_PREFERENCES, ["groq"]);

    await user.click(await screen.findByRole("button", { name: "Remove key" }));
    expect(screen.getByText(/Voice input and Wisps using Groq stop working/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove key" }));

    expect(removeVoiceCredential).toHaveBeenCalledWith({ providerId: "groq" });
    expect(await screen.findByText(/Add a Groq key to use voice input/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove key" })).not.toBeInTheDocument();
  });

  it("says a key kept for voice input alone leaves the sign-in in place", async () => {
    const user = userEvent.setup();
    const { removeVoiceCredential } = renderSection(
      { ...DEFAULT_PREFERENCES, voiceProvider: "openai", voiceModel: "whisper-1" },
      ["openai"],
      ["openai"],
    );

    expect(
      await screen.findByText(/saved for OpenAI voice input only; AI Model settings use your sign-in/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove key" }));
    expect(screen.getByText(/Voice input with OpenAI stops working .* Your sign-in is kept/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove key" }));

    expect(removeVoiceCredential).toHaveBeenCalledWith({ providerId: "openai" });
    expect(await screen.findByText(/Add a OpenAI key to use voice input/)).toBeInTheDocument();
  });
});

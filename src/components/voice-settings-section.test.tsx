import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { VoiceSettingsSection } from "@/components/voice-settings-section";
import { DEFAULT_PREFERENCES, type AppPreferences } from "@/lib/app-preferences";
import type { VoiceSettingsView } from "../../shared/voice";

function view(configured: ReadonlyArray<string>): VoiceSettingsView {
  return {
    secureStorageAvailable: true,
    providers: [
      { id: "groq", name: "Groq", credentialConfigured: configured.includes("groq") },
      { id: "openai", name: "OpenAI", credentialConfigured: configured.includes("openai") },
      { id: "mistral", name: "Mistral", credentialConfigured: configured.includes("mistral") },
    ],
  };
}

function renderSection(preferences: AppPreferences = DEFAULT_PREFERENCES, configured: ReadonlyArray<string> = []) {
  let saved = [...configured];
  const saveVoiceCredential = vi.fn(async () => {
    saved = [...saved, "groq"];
    return { ok: true as const, value: view(saved) };
  });
  const removeProviderCredential = vi.fn(async ({ providerId }: { providerId: string }) => {
    saved = saved.filter((id) => id !== providerId);
    return { ok: true as const, value: {} };
  });
  Object.defineProperty(window, "wisp", {
    configurable: true,
    value: {
      getVoiceSettings: vi.fn(async () => ({ ok: true as const, value: view(saved) })),
      saveVoiceCredential,
      removeProviderCredential,
    },
  });
  const onPreferencesChange = vi.fn();
  render(<VoiceSettingsSection active preferences={preferences} onPreferencesChange={onPreferencesChange} />);
  return { onPreferencesChange, saveVoiceCredential, removeProviderCredential };
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
    const { removeProviderCredential } = renderSection(DEFAULT_PREFERENCES, ["groq"]);

    await user.click(await screen.findByRole("button", { name: "Remove key" }));
    expect(screen.getByText(/Voice input and Wisps using Groq stop working/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove key" }));

    expect(removeProviderCredential).toHaveBeenCalledWith({ providerId: "groq" });
    expect(await screen.findByText(/Add a Groq key to use voice input/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove key" })).not.toBeInTheDocument();
  });
});

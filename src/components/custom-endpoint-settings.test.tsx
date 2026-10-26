import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CustomEndpointSettings } from "@/components/custom-endpoint-settings";
import type { AiSettingsView } from "../../shared/contracts";
import type { CustomEndpointView } from "../../shared/custom-endpoints";

const OLLAMA: CustomEndpointView = {
  id: "custom-0a1b2c3d",
  name: "Ollama",
  baseUrl: "http://127.0.0.1:11434/v1",
  keySaved: false,
  models: [{ id: "qwen2.5-coder:7b", contextWindow: 32_768, maxOutputTokens: 8_192, images: false }],
};

function view(customEndpoints: ReadonlyArray<CustomEndpointView> = []): AiSettingsView {
  return {
    selection: null,
    auxiliary: { imageUnderstanding: { selection: null, unavailable: null } },
    fallback: { selection: null, unavailable: null },
    secureStorageAvailable: true,
    providers: [],
    customEndpoints,
    catalogError: null,
  };
}

function renderSettings(initial: AiSettingsView, api: Record<string, unknown> = {}) {
  const saved = view([OLLAMA]);
  const wisp = {
    saveCustomEndpoint: vi.fn(async () => ({ ok: true as const, value: saved })),
    removeCustomEndpoint: vi.fn(async () => ({ ok: true as const, value: view() })),
    loadCustomEndpointModels: vi.fn(async () => ({
      ok: true as const,
      value: { models: ["llama3.1:8b-instruct-q4_K_M", "qwen2.5-coder:7b"] },
    })),
    detectLocalEndpoints: vi.fn(async () => ({
      ok: true as const,
      value: { endpoints: [{ name: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", models: ["qwen2.5-coder:7b"] }] },
    })),
    ...api,
  };
  Object.defineProperty(window, "wisp", { configurable: true, value: wisp });
  const onViewChange = vi.fn();
  const onCreated = vi.fn();
  render(<CustomEndpointSettings view={initial} onViewChange={onViewChange} onCreated={onCreated} />);
  return { wisp, onViewChange, onCreated, saved };
}

describe("CustomEndpointSettings", () => {
  it("adds an endpoint with the models it lists and offers it right away", async () => {
    const user = userEvent.setup();
    const { wisp, onViewChange, onCreated, saved } = renderSettings(view());

    await user.click(screen.getByRole("button", { name: "Add endpoint" }));
    await user.type(screen.getByLabelText("Name"), "Ollama");
    await user.type(screen.getByLabelText("Address"), "http://127.0.0.1:11434/v1");
    await user.click(screen.getByRole("button", { name: "Load models" }));
    expect(wisp.loadCustomEndpointModels).toHaveBeenCalledWith({ baseUrl: "http://127.0.0.1:11434/v1" });
    await user.click(screen.getByRole("switch", { name: "Offer llama3.1:8b-instruct-q4_K_M" }));
    await user.click(screen.getByRole("switch", { name: "qwen2.5-coder:7b accepts images" }));
    await user.click(screen.getByRole("button", { name: "Save endpoint" }));

    expect(wisp.saveCustomEndpoint).toHaveBeenCalledWith({
      name: "Ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      models: [{ id: "qwen2.5-coder:7b", contextWindow: 32_768, maxOutputTokens: 8_192, images: true }],
    });
    expect(onViewChange).toHaveBeenCalledWith(saved);
    expect(onCreated).toHaveBeenCalledWith(saved, OLLAMA.id);
  });

  it("finds a local server and adds it with its models", async () => {
    const user = userEvent.setup();
    const { wisp } = renderSettings(view());

    await user.click(screen.getByRole("button", { name: "Find local servers" }));
    await user.click(await screen.findByRole("button", { name: "Add Ollama" }));
    expect(screen.getByLabelText("Address")).toHaveValue("http://127.0.0.1:11434/v1");
    await user.click(screen.getByRole("button", { name: "Save endpoint" }));

    expect(wisp.saveCustomEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Ollama", models: [expect.objectContaining({ id: "qwen2.5-coder:7b" })] }),
    );
  });

  it("marks a found server that is already added", async () => {
    const user = userEvent.setup();
    renderSettings(view([OLLAMA]));

    await user.click(screen.getByRole("button", { name: "Find local servers" }));
    expect(await screen.findByRole("button", { name: "Ollama is added" })).toBeDisabled();
  });

  it("says when no local server answers", async () => {
    const user = userEvent.setup();
    renderSettings(view(), {
      detectLocalEndpoints: vi.fn(async () => ({ ok: true as const, value: { endpoints: [] } })),
    });

    await user.click(screen.getByRole("button", { name: "Find local servers" }));
    expect(await screen.findByRole("status")).toHaveTextContent("No model server answered");
  });

  it("edits a saved endpoint, removing its key, and loads models with the saved key", async () => {
    const user = userEvent.setup();
    const { wisp } = renderSettings(view([{ ...OLLAMA, name: "Proxy", keySaved: true }]));

    expect(screen.getByText(/API key saved/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Edit Proxy" }));
    await user.click(screen.getByRole("button", { name: "Load models" }));
    expect(wisp.loadCustomEndpointModels).toHaveBeenCalledWith({ baseUrl: OLLAMA.baseUrl, id: OLLAMA.id });
    await user.click(screen.getByRole("button", { name: "Remove key" }));
    await user.click(screen.getByRole("button", { name: "Save endpoint" }));

    expect(wisp.saveCustomEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({ id: OLLAMA.id, removeKey: true, models: OLLAMA.models }),
    );
    expect(wisp.saveCustomEndpoint).toHaveBeenCalledWith(expect.not.objectContaining({ apiKey: expect.anything() }));
  });

  it("removes an endpoint after confirming", async () => {
    const user = userEvent.setup();
    const { wisp, onViewChange } = renderSettings(view([OLLAMA]));

    await user.click(screen.getByRole("button", { name: "Edit Ollama" }));
    await user.click(screen.getByRole("button", { name: "Remove endpoint" }));
    await user.click(screen.getAllByRole("button", { name: "Remove endpoint" }).at(-1)!);

    expect(wisp.removeCustomEndpoint).toHaveBeenCalledWith({ id: OLLAMA.id });
    expect(onViewChange).toHaveBeenCalledWith(view());
  });

  it("shows why a save was refused", async () => {
    const user = userEvent.setup();
    renderSettings(view([OLLAMA]), {
      saveCustomEndpoint: vi.fn(async () => ({
        ok: false as const,
        error: { code: "invalid_request", message: "Enter the API key again.", retryable: false },
      })),
    });

    await user.click(screen.getByRole("button", { name: "Edit Ollama" }));
    await user.click(screen.getByRole("button", { name: "Save endpoint" }));

    expect(await screen.findByText("Enter the API key again.")).toBeInTheDocument();
  });
});

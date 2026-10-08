import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AiSettingsView } from "../../shared/contracts";
import { CreateAgentDialog } from "@/components/create-agent-dialog";
import { serializeWispTemplate } from "@/lib/wisp-template";

const providers: AiSettingsView["providers"] = ["a", "b"].map((id) => ({
  id: `provider-${id}`,
  name: `Provider ${id}`,
  credentialConfigured: id === "a",
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

function mockAiSettings(selection: AiSettingsView["selection"] = { providerId: "provider-a", modelId: "model-a" }) {
  Object.defineProperty(window, "wisp", {
    configurable: true,
    value: {
      getAiSettings: vi.fn(async () => ({
        ok: true,
        value: { selection, secureStorageAvailable: true, providers },
      })),
    },
  });
}

describe("CreateAgentDialog persistence", () => {
  it("keeps the form open on failure so the same draft can be retried", async () => {
    mockAiSettings();
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<CreateAgentDialog onCreate={onCreate} />);
    await user.click(screen.getByRole("button", { name: "Create Wisp" }));
    const name = screen.getByRole("textbox", { name: "Name" });
    await user.type(name, "Atlas");
    await user.click(screen.getByRole("button", { name: "Create Wisp" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not create this Wisp");
    expect(name).toHaveValue("Atlas");
    await user.click(screen.getByRole("button", { name: "Create Wisp" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(onCreate).toHaveBeenCalledTimes(2);
  });

  it("inherits the global model when the custom selection stays off", async () => {
    mockAiSettings();
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(true);
    render(<CreateAgentDialog onCreate={onCreate} />);
    await user.click(screen.getByRole("button", { name: "Create Wisp" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Atlas");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Global default · Provider a model-a");
    await user.click(screen.getByRole("button", { name: "Create Wisp" }));
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ name: "Atlas", role: "", soul: "" }), {
        notifyOnUpdatesEnabled: true,
        model: null,
      }),
    );
  });

  it("submits the chosen provider and model for this Wisp", async () => {
    mockAiSettings();
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(true);
    render(<CreateAgentDialog onCreate={onCreate} />);
    await user.click(screen.getByRole("button", { name: "Create Wisp" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Atlas");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Global default · Provider a model-a");
    await user.click(screen.getByRole("switch", { name: "Choose model for this Wisp" }));
    await user.type(screen.getByRole("spinbutton", { name: "Maximum output tokens" }), "512");
    await user.click(screen.getByRole("button", { name: "Create Wisp" }));
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ name: "Atlas" }), {
        notifyOnUpdatesEnabled: true,
        model: { providerId: "provider-a", modelId: "model-a", maxOutputTokens: 512 },
      }),
    );
  });

  it("warns when the selected provider has no saved API key", async () => {
    mockAiSettings({ providerId: "provider-b", modelId: "model-b" });
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(true);
    render(<CreateAgentDialog onCreate={onCreate} />);
    await user.click(screen.getByRole("button", { name: "Create Wisp" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Atlas");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Global default · Provider b model-b");
    await user.click(screen.getByRole("switch", { name: "Choose model for this Wisp" }));
    expect(await screen.findByText(/No API key saved for Provider b/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Create Wisp" })).toBeDisabled();
  });

  it("blocks creation until a usable global default or Wisp model exists", async () => {
    mockAiSettings(null);
    const user = userEvent.setup();
    render(<CreateAgentDialog onCreate={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Create Wisp" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Atlas");
    expect(await screen.findByText(/needs a model before it can be created/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Create Wisp" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText(/No global default model is set/)).toBeVisible();
    const submit = screen.getByRole("button", { name: "Create Wisp" });
    expect(submit).toBeDisabled();
    await user.click(screen.getByRole("switch", { name: "Choose model for this Wisp" }));
    expect(submit).toBeEnabled();
  });

  it("splits creation into two steps and keeps the draft between them", async () => {
    mockAiSettings();
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(true);
    render(<CreateAgentDialog onCreate={onCreate} />);
    await user.click(screen.getByRole("button", { name: "Create Wisp" }));
    expect(screen.getByText("Step 1 of 2 · Appearance and name")).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Soul" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

    await user.type(screen.getByRole("textbox", { name: "Name" }), "Atlas");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Step 2 of 2 · Soul and behavior")).toBeVisible();
    const personality = screen.getByRole("textbox", { name: "Soul" });
    expect(personality).toHaveFocus();
    expect(screen.queryByRole("textbox", { name: "Name" })).not.toBeInTheDocument();
    await user.type(personality, "Careful researcher");

    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Atlas");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("textbox", { name: "Soul" })).toHaveValue("Careful researcher");

    await user.click(screen.getByRole("button", { name: "Create Wisp" }));
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ name: "Atlas", soul: "Careful researcher" }), {
        notifyOnUpdatesEnabled: true,
        model: null,
      }),
    );
  });
});

describe("CreateAgentDialog template import", () => {
  const wisp = { name: "Atlas", role: "Research", soul: "Careful researcher" };

  async function importTemplate(text: string, onCreate = vi.fn().mockResolvedValue(true)) {
    const user = userEvent.setup();
    render(<CreateAgentDialog onCreate={onCreate} />);
    await user.click(screen.getByRole("button", { name: "Create Wisp" }));
    await user.click(screen.getByRole("button", { name: "Import template" }));
    await user.click(screen.getByRole("textbox", { name: "Template" }));
    await user.paste(text);
    await waitFor(() => expect(screen.getByRole("button", { name: "Apply template" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Apply template" }));
    return { user, onCreate };
  }

  it("fills the form and selects the template's model for review", async () => {
    mockAiSettings();
    const { user, onCreate } = await importTemplate(
      serializeWispTemplate(wisp, { providerId: "provider-a", modelId: "model-a", maxOutputTokens: 512 }),
    );
    expect(screen.getByText(/Template applied/)).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Atlas");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("textbox", { name: "Soul" })).toHaveValue("Careful researcher");
    expect(screen.getByRole("spinbutton", { name: "Maximum output tokens" })).toHaveValue(512);
    await user.click(screen.getByRole("button", { name: "Create Wisp" }));
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(expect.objectContaining(wisp), {
        notifyOnUpdatesEnabled: true,
        model: { providerId: "provider-a", modelId: "model-a", maxOutputTokens: 512 },
      }),
    );
  });

  it("asks for a key when the template's provider has none saved", async () => {
    mockAiSettings();
    const { user } = await importTemplate(
      serializeWispTemplate(wisp, { providerId: "provider-b", modelId: "model-b" }),
    );
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText(/No API key saved for Provider b/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Create Wisp" })).toBeDisabled();
  });

  it("falls back to the global model when the template's model is unavailable", async () => {
    mockAiSettings();
    const { user, onCreate } = await importTemplate(
      serializeWispTemplate(wisp, { providerId: "provider-z", modelId: "model-z", maxOutputTokens: 512 }),
    );
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText(/uses model-z from provider-z, which isn't available here/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Create Wisp" }));
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(expect.objectContaining(wisp), {
        notifyOnUpdatesEnabled: true,
        model: null,
      }),
    );
  });

  it("rejects text that is not a template and keeps the form unchanged", async () => {
    mockAiSettings();
    await importTemplate("wisp://template/atlas");
    expect(screen.getByRole("alert")).toHaveTextContent("not a valid Wisp template");
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("");
  });
});

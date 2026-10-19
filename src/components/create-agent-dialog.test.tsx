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
      thinkingLevels: ["off"],
      input: ["text"],
      contextWindow: 10000,
      maxOutputTokens: 1000,
    },
  ],
}));

const GIB = 1024 * 1024 * 1024;

const trigger = <button type="button" aria-label="Create Wisp" />;

function mockAiSettings(
  selection: AiSettingsView["selection"] = { providerId: "provider-a", modelId: "model-a" },
  setup: Partial<Record<"getWispSetup" | "setWorkspaceQuota" | "saveWispExecution", ReturnType<typeof vi.fn>>> = {},
) {
  const api = {
    getAiSettings: vi.fn(async () => ({
      ok: true,
      value: { selection, secureStorageAvailable: true, providers },
    })),
    getWispSetup: vi.fn(async () => ({
      ok: true,
      value: { maxQuotaBytes: 10 * GIB, runtime: { available: true, name: "docker", version: "27.0" } },
    })),
    setWorkspaceQuota: vi.fn(async () => ({ ok: true, value: { usedBytes: 0, quotaBytes: 0, maxQuotaBytes: 0 } })),
    saveWispExecution: vi.fn(async () => ({ ok: true, value: {} })),
    ...setup,
  };
  Object.defineProperty(window, "wisp", { configurable: true, value: api });
  return api;
}

describe("CreateAgentDialog persistence", () => {
  it("keeps the form open on failure so the same draft can be retried", async () => {
    mockAiSettings();
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce("atlas");
    render(<CreateAgentDialog onCreate={onCreate} trigger={trigger} />);
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
    const onCreate = vi.fn().mockResolvedValue("atlas");
    render(<CreateAgentDialog onCreate={onCreate} trigger={trigger} />);
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
    const onCreate = vi.fn().mockResolvedValue("atlas");
    render(<CreateAgentDialog onCreate={onCreate} trigger={trigger} />);
    await user.click(screen.getByRole("button", { name: "Create Wisp" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Atlas");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Global default · Provider a model-a");
    await user.click(screen.getByRole("switch", { name: "Choose model for this Wisp" }));
    // The limit is set later, under Advanced in the Wisp's Model tab.
    expect(screen.queryByRole("spinbutton", { name: "Maximum output tokens" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create Wisp" }));
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ name: "Atlas" }), {
        notifyOnUpdatesEnabled: true,
        model: { providerId: "provider-a", modelId: "model-a" },
      }),
    );
  });

  it("warns when the selected provider has no saved API key", async () => {
    mockAiSettings({ providerId: "provider-b", modelId: "model-b" });
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue("atlas");
    render(<CreateAgentDialog onCreate={onCreate} trigger={trigger} />);
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
    render(<CreateAgentDialog onCreate={vi.fn()} trigger={trigger} />);
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

  it("splits creation into steps and keeps the draft between them", async () => {
    mockAiSettings();
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue("atlas");
    render(<CreateAgentDialog onCreate={onCreate} trigger={trigger} />);
    await user.click(screen.getByRole("button", { name: "Create Wisp" }));
    expect(screen.getByText("Step 1 of 3 · Appearance and name")).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Soul" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

    await user.type(screen.getByRole("textbox", { name: "Name" }), "Atlas");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Step 2 of 3 · Soul and behavior")).toBeVisible();
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

  async function importTemplate(text: string, onCreate = vi.fn().mockResolvedValue("atlas")) {
    const user = userEvent.setup();
    render(<CreateAgentDialog onCreate={onCreate} trigger={trigger} />);
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
    // The field is gone from creation, but the template's limit is kept.
    expect(screen.queryByRole("spinbutton", { name: "Maximum output tokens" })).not.toBeInTheDocument();
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

describe("CreateAgentDialog workspace and commands", () => {
  async function openSetupStep() {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue("atlas");
    render(<CreateAgentDialog onCreate={onCreate} trigger={trigger} />);
    await user.click(screen.getByRole("button", { name: "Create Wisp" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Atlas");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Step 3 of 3 · Workspace and commands")).toBeVisible();
    return { user, onCreate };
  }

  it("leaves a Wisp created with the defaults alone", async () => {
    const api = mockAiSettings();
    const { user, onCreate } = await openSetupStep();
    expect(await screen.findByRole("combobox", { name: "Workspace size" })).toHaveTextContent("512 MiB");
    expect(screen.getByRole("switch", { name: "Run commands in a container" })).not.toBeChecked();
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create Wisp" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(onCreate).toHaveBeenCalledOnce();
    expect(api.setWorkspaceQuota).not.toHaveBeenCalled();
    expect(api.saveWispExecution).not.toHaveBeenCalled();
  });

  it("gives the new Wisp the chosen size and commands", async () => {
    const api = mockAiSettings();
    const { user } = await openSetupStep();
    await user.click(await screen.findByRole("combobox", { name: "Workspace size" }));
    expect(await screen.findByRole("option", { name: "50.0 GiB" })).toHaveAttribute("aria-disabled", "true");
    await user.click(await screen.findByRole("option", { name: "128 MiB" }));
    await user.click(screen.getByRole("switch", { name: "Run commands in a container" }));
    expect(screen.getByText(/Packages installed by commands count toward the workspace/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Create Wisp" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.setWorkspaceQuota).toHaveBeenCalledWith({ conversationId: "atlas", quotaBytes: 128 * 1024 * 1024 });
    expect(api.saveWispExecution).toHaveBeenCalledWith({
      conversationId: "atlas",
      mode: "container",
      image: null,
      localNetwork: false,
    });
  });

  it("keeps commands off when the server cannot run them", async () => {
    mockAiSettings(undefined, {
      getWispSetup: vi.fn(async () => ({
        ok: true,
        value: { maxQuotaBytes: 10 * GIB, runtime: { available: false, message: "Install Docker or Podman." } },
      })),
    });
    await openSetupStep();
    expect(await screen.findByText("Install Docker or Podman.")).toBeVisible();
    expect(screen.getByRole("switch", { name: "Run commands in a container" })).toBeDisabled();
  });

  it("explains that an older server keeps the defaults", async () => {
    mockAiSettings(undefined, {
      getWispSetup: vi.fn(async () => ({
        ok: false,
        error: { code: "unsupported", message: "not offered", retryable: false },
      })),
    });
    await openSetupStep();
    expect(await screen.findByText(/This server is older than this app/)).toBeVisible();
    expect(screen.queryByRole("combobox", { name: "Workspace size" })).not.toBeInTheDocument();
  });

  it("reports a setup that could not be applied without creating the Wisp again", async () => {
    mockAiSettings(undefined, {
      setWorkspaceQuota: vi.fn(async () => ({
        ok: false,
        error: { code: "invalid_request", message: "Choose one of the offered workspace sizes.", retryable: false },
      })),
    });
    const { user, onCreate } = await openSetupStep();
    await user.click(await screen.findByRole("combobox", { name: "Workspace size" }));
    await user.click(await screen.findByRole("option", { name: "64.0 MiB" }));
    await user.click(screen.getByRole("button", { name: "Create Wisp" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Atlas was created, but its workspace size (Choose one of the offered workspace sizes.) could not be set.",
    );
    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(onCreate).toHaveBeenCalledOnce();
  });
});

describe("CreateAgentDialog soul templates", () => {
  async function openSoulStep() {
    mockAiSettings();
    const user = userEvent.setup();
    render(<CreateAgentDialog onCreate={vi.fn().mockResolvedValue("atlas")} trigger={trigger} />);
    await user.click(screen.getByRole("button", { name: "Create Wisp" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Atlas");
    await user.click(screen.getByRole("button", { name: "Next" }));
    return user;
  }

  it("switches between templates while the text is untouched", async () => {
    const user = await openSoulStep();
    await user.click(screen.getByRole("button", { name: "Friendly" }));
    const soul = screen.getByRole("textbox", { name: "Soul" });
    expect((soul as HTMLTextAreaElement).value).toContain("Warm and approachable");
    expect(screen.getByRole("combobox", { name: "Soul template" })).toHaveTextContent("Friendly");

    await user.click(screen.getByRole("combobox", { name: "Soul template" }));
    await user.click(await screen.findByRole("option", { name: "Direct" }));
    expect((soul as HTMLTextAreaElement).value).toContain("Straight to the point");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("asks before a template replaces edited text", async () => {
    const user = await openSoulStep();
    const soul = screen.getByRole("textbox", { name: "Soul" });
    await user.type(soul, "My own soul");
    await user.click(screen.getByRole("combobox", { name: "Soul template" }));
    await user.click(await screen.findByRole("option", { name: "Formal" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Replace the soul with the Formal template?");
    expect(soul).toHaveValue("My own soul");

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(soul).toHaveValue("My own soul");

    await user.click(screen.getByRole("combobox", { name: "Soul template" }));
    await user.click(await screen.findByRole("option", { name: "Formal" }));
    await user.click(screen.getByRole("button", { name: "Replace" }));
    expect((soul as HTMLTextAreaElement).value).toContain("Professional and polished");
  });

  it("shows an edited soul as custom and asks before clearing it", async () => {
    const user = await openSoulStep();
    const soul = screen.getByRole("textbox", { name: "Soul" });
    await user.type(soul, "My own soul");
    expect(screen.getByRole("combobox", { name: "Soul template" })).toHaveTextContent("Custom");

    await user.click(screen.getByRole("combobox", { name: "Soul template" }));
    await user.click(await screen.findByRole("option", { name: "Blank" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Clear the soul?");
    expect(soul).toHaveValue("My own soul");

    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(soul).toHaveValue("");
    expect(screen.queryByRole("combobox", { name: "Soul template" })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Soul templates" })).toBeInTheDocument();
  });

  it("clears an untouched template without asking", async () => {
    const user = await openSoulStep();
    await user.click(screen.getByRole("button", { name: "Friendly" }));
    await user.click(screen.getByRole("combobox", { name: "Soul template" }));
    await user.click(await screen.findByRole("option", { name: "Blank" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Soul" })).toHaveValue("");
  });
});

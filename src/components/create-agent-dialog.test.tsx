import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AiSettingsView } from "../../shared/contracts";
import { CreateAgentDialog } from "@/components/create-agent-dialog";

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

function mockAiSettings(selection = { providerId: "provider-a", modelId: "model-a" }) {
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
    await screen.findByText("Global default · Provider a model-a");
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Atlas");
    await user.click(screen.getByRole("button", { name: "Create Wisp" }));
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ name: "Atlas", kind: "wisp" }), null),
    );
  });

  it("submits the chosen provider and model for this Wisp", async () => {
    mockAiSettings();
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(true);
    render(<CreateAgentDialog onCreate={onCreate} />);
    await user.click(screen.getByRole("button", { name: "Create Wisp" }));
    await screen.findByText("Global default · Provider a model-a");
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Atlas");
    await user.click(screen.getByRole("switch", { name: "Choose model for this Wisp" }));
    await user.type(screen.getByRole("spinbutton", { name: "Maximum output tokens" }), "512");
    await user.click(screen.getByRole("button", { name: "Create Wisp" }));
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ name: "Atlas" }), {
        providerId: "provider-a",
        modelId: "model-a",
        maxOutputTokens: 512,
      }),
    );
  });

  it("warns when the selected provider has no saved API key", async () => {
    mockAiSettings({ providerId: "provider-b", modelId: "model-b" });
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(true);
    render(<CreateAgentDialog onCreate={onCreate} />);
    await user.click(screen.getByRole("button", { name: "Create Wisp" }));
    await screen.findByText("Global default · Provider b model-b");
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Atlas");
    await user.click(screen.getByRole("switch", { name: "Choose model for this Wisp" }));
    expect(await screen.findByText(/No API key saved for Provider b/)).toBeVisible();
  });
});

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DetailsPanel } from "@/components/details-panel";
import { wispChatView } from "@/test/chat-fixtures";

const chat = wispChatView("atlas", {
  wisp: { name: "Atlas", role: "Research", soul: "Finds relevant information" },
});

function renderDetails(onDelete = vi.fn()): void {
  render(
    <DetailsPanel
      chat={chat}
      wisps={{ atlas: chat.wisp }}
      width={318}
      onChange={vi.fn()}
      onChangeWisp={vi.fn()}
      onClose={vi.fn()}
      onDelete={onDelete}
      onResizeStart={vi.fn()}
    />,
  );
}

function setClipboard(writeText: ((text: string) => Promise<void>) | undefined): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: writeText ? { writeText } : undefined,
  });
}

function mockConversationModel(result: unknown): void {
  Object.defineProperty(window, "wisp", {
    configurable: true,
    value: {
      getConversationModel: vi.fn(async () => result),
      getJobs: vi.fn(async () => ({ ok: true, value: { jobs: [] } })),
      subscribeToJobs: vi.fn(() => () => {}),
    },
  });
}

const model = { providerId: "anthropic", modelId: "claude-sonnet-5-5", maxOutputTokens: 4096 };

describe("DetailsPanel template sharing", () => {
  afterEach(() => setClipboard(undefined));

  it("copies the soul and the model the Wisp runs on, without its appearance", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    const user = userEvent.setup();
    setClipboard(writeText);
    mockConversationModel({
      ok: true,
      value: { override: null, effective: model, applied: model, pending: null, status: "idle" },
    });
    renderDetails();

    await user.click(screen.getByRole("button", { name: "Share as template" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Template copied");
    expect(screen.getByRole("button", { name: "Template copied" })).toBeVisible();
    expect(JSON.parse(writeText.mock.calls[0]![0])).toEqual({
      format: "wisp-template",
      version: 1,
      name: "Atlas",
      role: "Research",
      soul: "Finds relevant information",
      model,
    });
  });

  it("still copies the soul when the model cannot be read", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    const user = userEvent.setup();
    setClipboard(writeText);
    mockConversationModel({ ok: false, error: { code: "not_found", message: "Missing" } });
    renderDetails();

    await user.click(screen.getByRole("button", { name: "Share as template" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Template copied");
    expect(JSON.parse(writeText.mock.calls[0]![0])).not.toHaveProperty("model");
  });

  it("announces clipboard failures", async () => {
    const user = userEvent.setup();
    mockConversationModel({ ok: false, error: { code: "not_found", message: "Missing" } });
    setClipboard(async () => {
      throw new Error("denied");
    });
    renderDetails();

    await user.click(screen.getByRole("button", { name: "Share as template" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not copy template");
    expect(screen.getByRole("button", { name: "Could not copy template" })).toBeVisible();
  });
});

describe("DetailsPanel deletion", () => {
  it("requires explicit confirmation and describes the data being removed", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    mockConversationModel({ ok: false, error: { code: "not_found", message: "Missing" } });
    renderDetails(onDelete);

    await user.click(screen.getByRole("button", { name: "Delete Atlas…" }));

    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Delete Atlas?" })).toBeVisible();
    expect(screen.getByText(/conversation history and settings/)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Confirm deletion" }));

    expect(onDelete).toHaveBeenCalledOnce();
  });
});

describe("DetailsPanel on the desktop", () => {
  it("shows a compact profile whose rows open the settings dialog at their section", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    Object.defineProperty(window, "wisp", {
      configurable: true,
      value: {
        getConversationModel: vi.fn(async () => ({
          ok: true,
          value: { effective: { providerId: "anthropic", modelId: "claude-opus-5-5" } },
        })),
        getAiSettings: vi.fn(async () => ({ ok: false, error: { message: "unavailable" } })),
        getJobs: vi.fn(async () => ({ ok: true, value: { jobs: [] } })),
        subscribeToJobs: vi.fn(() => () => {}),
        subscribeToAgentEvents: vi.fn(() => () => undefined),
      },
    });
    render(
      <DetailsPanel
        chat={chat}
        wisps={{ atlas: chat.wisp }}
        width={318}
        onChange={onChange}
        onChangeWisp={vi.fn()}
        onClose={vi.fn()}
        onDelete={vi.fn()}
        onResizeStart={vi.fn()}
      />,
    );
    const profile = screen.getByRole("region", { name: "Atlas" });
    expect(profile).toHaveTextContent("Finds relevant information");
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    // The Model row says which model is set without opening it.
    expect(await screen.findByText("claude-opus-5-5")).toBeVisible();

    await user.click(screen.getByRole("switch", { name: "Notifications" }));
    expect(onChange).toHaveBeenCalledWith({ kind: "wisp", notifyOnUpdatesEnabled: false });

    await user.click(screen.getByRole("button", { name: /^Model/ }));
    const dialog = await screen.findByRole("dialog", { name: "Atlas" });
    expect(screen.getByRole("heading", { name: "Model" })).toBeVisible();
    expect(screen.getByRole("navigation", { name: "Atlas settings sections" })).toBeVisible();

    await user.keyboard("{Escape}");
    expect(dialog).not.toBeInTheDocument();

    // E edits the profile while the panel has focus.
    screen.getByRole("button", { name: /^Usage/ }).focus();
    await user.keyboard("e");
    expect(await screen.findByRole("textbox", { name: "Name" })).toHaveValue("Atlas");
  });
});

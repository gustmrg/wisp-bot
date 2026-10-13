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
      initialTab="general"
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
    renderDetails(onDelete);

    await user.click(screen.getByRole("button", { name: "Delete Wisp" }));

    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Delete Atlas?" })).toBeVisible();
    expect(screen.getByText(/conversation history and settings/)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Confirm deletion" }));

    expect(onDelete).toHaveBeenCalledOnce();
  });
});

describe("DetailsPanel on the desktop", () => {
  it("opens straight on the Wisp's settings, with who it is in the panel's header", async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, "wisp", {
      configurable: true,
      value: {
        getAiSettings: vi.fn(async () => ({ ok: false, error: { message: "No settings yet" } })),
        getConversationModel: vi.fn(async () => ({ ok: false, error: { message: "No model yet" } })),
        subscribeToAgentEvents: vi.fn(() => () => undefined),
      },
    });
    render(
      <DetailsPanel
        chat={chat}
        wisps={{ atlas: chat.wisp }}
        width={318}
        onChange={vi.fn()}
        onChangeWisp={vi.fn()}
        onClose={vi.fn()}
        onDelete={vi.fn()}
        onResizeStart={vi.fn()}
      />,
    );
    expect(screen.getByRole("heading", { name: "Atlas" })).toBeVisible();
    expect(screen.getByText("Research")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Atlas");
    expect(screen.queryByRole("button", { name: "Back to profile" })).not.toBeInTheDocument();

    // The tabs carry the navigation; switching them stays inside the panel.
    await user.click(screen.getByRole("tab", { name: "Model" }));
    expect(screen.getByRole("tab", { name: "Model" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "Atlas" })).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "General" }));
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Atlas");
  });
});

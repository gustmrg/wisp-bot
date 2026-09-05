import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { CircleChat, WispChat } from "@/chat-data";
import { CircleDetails } from "@/components/circle-details";
import { WispDetails } from "@/components/wisp-details";

const wisp: WispChat = {
  id: "atlas",
  kind: "wisp",
  name: "Atlas",
  label: "Research",
  description: "Researches",
  shape: "circle",
  notifyOnUpdatesEnabled: true,
  preview: "Ready",
  timestamp: "Now",
  messages: [],
};

const circle: CircleChat = {
  id: "crew",
  kind: "circle",
  name: "Crew",
  label: "Circle",
  description: "Works together",
  memberIds: [wisp.id],
  notifyOnUpdatesEnabled: true,
  preview: "Ready",
  timestamp: "Now",
  messages: [],
};

describe("variant details", () => {
  it("renders Wisp-only appearance editing", () => {
    render(<WispDetails chat={wisp} onChange={vi.fn()} />);
    expect(screen.getByRole("group", { name: "Wisp shape" })).toBeVisible();
    expect(screen.getByText("Identity & personality")).toBeVisible();
    expect(screen.getByDisplayValue("Researches")).toHaveAttribute("maxlength", "4000");
    expect(screen.getByDisplayValue("Researches")).toHaveAttribute("rows", "5");
  });

  it("keeps Wisp edits local until they are saved", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn(async () => true);
    render(<WispDetails chat={wisp} onChange={onChange} />);

    const name = screen.getByRole("textbox", { name: "Name" });
    const save = screen.getByRole("button", { name: "Save changes" });
    expect(save).toBeDisabled();

    await user.clear(name);
    await user.type(name, "Nova");

    expect(onChange).not.toHaveBeenCalled();
    expect(save).toBeEnabled();

    await user.click(save);

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ kind: "wisp", name: "Nova" }));
  });

  it("renders circle-only membership details", () => {
    render(<CircleDetails chat={circle} chats={{ atlas: wisp, crew: circle }} onChange={vi.fn()} />);
    expect(screen.getByText("Participants (1)")).toBeVisible();
    expect(screen.getAllByText("Atlas")).not.toHaveLength(0);
    expect(screen.getByRole("group", { name: "Edit participants" })).toBeVisible();
  });
});

it("preserves General and Model drafts across tabs, and loads model/usage data lazily", async () => {
  const user = userEvent.setup();
  const getAiSettings = vi.fn(async () => ({
    ok: true,
    value: {
      selection: { providerId: "test", modelId: "model" },
      secureStorageAvailable: true,
      providers: [
        {
          id: "test",
          name: "Test",
          credentialConfigured: true,
          models: [{ id: "model", name: "Model", maxOutputTokens: 1000 }],
        },
      ],
    },
  }));
  const getSessionReport = vi.fn(async () => ({ ok: true, value: null }));
  const applyModel = vi.fn();
  Object.defineProperty(window, "wisp", {
    configurable: true,
    value: {
      getAiSettings,
      getSessionReport,
      applyModel,
      getConversationModel: vi.fn(async () => ({
        ok: true,
        value: { override: null, applied: { providerId: "test", modelId: "model" }, pending: null, status: "idle" },
      })),
      subscribeToAgentEvents: vi.fn(() => () => undefined),
    },
  });
  const onChange = vi.fn();
  render(<WispDetails chat={wisp} onChange={onChange} />);
  expect(screen.getByRole("tab", { name: "General" })).toHaveAttribute("aria-selected", "true");
  expect(getAiSettings).not.toHaveBeenCalled();
  expect(getSessionReport).not.toHaveBeenCalled();
  await user.clear(screen.getByRole("textbox", { name: "Name" }));
  await user.type(screen.getByRole("textbox", { name: "Name" }), "Unsent name");
  await user.click(screen.getByRole("tab", { name: "Model" }));
  await user.click(await screen.findByRole("checkbox", { name: "Use global model" }));
  await user.type(screen.getByLabelText("Maximum output tokens"), "512");
  await user.click(screen.getByRole("tab", { name: "Usage" }));
  expect(await screen.findByText(/No agent session yet/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Save model" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("tab", { name: "Model" }));
  expect(screen.getByLabelText("Maximum output tokens")).toHaveValue(512);
  expect(getAiSettings).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("tab", { name: "General" }));
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Unsent name");
  expect(onChange).not.toHaveBeenCalled();
  expect(applyModel).not.toHaveBeenCalled();
});

it("supports keyboard navigation between settings tabs", async () => {
  const user = userEvent.setup();
  Object.defineProperty(window, "wisp", {
    configurable: true,
    value: {
      getAiSettings: vi.fn(async () => ({ ok: false, error: { message: "No settings yet" } })),
      getConversationModel: vi.fn(async () => ({ ok: false, error: { message: "No model yet" } })),
      subscribeToAgentEvents: vi.fn(() => () => undefined),
    },
  });
  render(<WispDetails chat={wisp} onChange={vi.fn()} />);
  screen.getByRole("tab", { name: "General" }).focus();
  await user.keyboard("{ArrowRight}{Enter}");
  expect(screen.getByRole("tab", { name: "Model" })).toHaveFocus();
  expect(screen.getByRole("tab", { name: "Model" })).toHaveAttribute("aria-selected", "true");
});

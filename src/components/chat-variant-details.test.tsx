import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CircleDetails } from "@/components/circle-details";
import { WispDetails } from "@/components/wisp-details";
import { WispSettingsSectionContent } from "@/components/wisp-settings";
import { circleChatView, wispChatView } from "@/test/chat-fixtures";

const wisp = wispChatView("atlas", { wisp: { name: "Atlas", role: "Research", soul: "Researches" } });
const circle = circleChatView("crew", [wisp.wisp], { name: "Crew", description: "Works together" });

describe("variant details", () => {
  it("renders Wisp-only appearance editing and the soul", () => {
    render(<WispSettingsSectionContent chat={wisp} section="profile" onChangeWisp={vi.fn()} />);
    for (const axis of ["Wisp trail", "Wisp body", "Wisp eyes"]) {
      expect(screen.getByRole("group", { name: axis })).toBeVisible();
    }
    expect(screen.getByRole("textbox", { name: "Role (optional)" })).toHaveValue("Research");
    const soul = screen.getByRole("textbox", { name: "Soul" });
    expect(soul).toHaveValue("Researches");
    expect(soul).toHaveAttribute("maxlength", "10000");
  });

  it("previews the soul as markdown and offers templates for an empty one", async () => {
    const user = userEvent.setup();
    render(
      <WispSettingsSectionContent
        chat={wispChatView("nova", { wisp: { soul: "" } })}
        section="profile"
        onChangeWisp={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Teacher" }));
    const soul = screen.getByRole("textbox", { name: "Soul" });
    expect((soul as HTMLTextAreaElement).value).toContain("# Personality\nA patient teacher.");
    expect(screen.queryByRole("group", { name: "Soul templates" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "Preview" }));
    expect(screen.getByRole("heading", { name: "Personality" })).toBeVisible();
  });

  it("keeps Wisp edits local until they are saved", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn(async () => true);
    render(<WispSettingsSectionContent chat={wisp} section="profile" onChangeWisp={onChange} />);

    const name = screen.getByRole("textbox", { name: "Name" });
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();

    await user.clear(name);
    await user.type(name, "Nova");

    expect(onChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ name: "Nova", role: "Research" }));
  });

  it("discards unsaved profile edits", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn(async () => true);
    render(<WispSettingsSectionContent chat={wisp} section="profile" onChangeWisp={onChange} />);

    const name = screen.getByRole("textbox", { name: "Name" });
    await user.type(name, " II");
    await user.click(screen.getByRole("button", { name: "Discard" }));

    expect(name).toHaveValue("Atlas");
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("saves the General tab's profile edits on the desktop", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn(async () => true);
    const onChangeNotifications = vi.fn(async () => true);
    render(<WispDetails chat={wisp} onChangeWisp={onChange} onChangeNotifications={onChangeNotifications} />);

    const name = screen.getByRole("textbox", { name: "Name" });
    expect(screen.queryByRole("button", { name: "Save profile" })).not.toBeInTheDocument();

    await user.clear(name);
    await user.type(name, "Nova");

    expect(onChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Save profile" }));

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ name: "Nova", role: "Research" }));
    expect(onChangeNotifications).not.toHaveBeenCalled();
  });

  it("saves the notification setting on the Wisp's conversation", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn(async () => true);
    const onChangeNotifications = vi.fn(async () => true);
    render(<WispDetails chat={wisp} onChangeWisp={onChange} onChangeNotifications={onChangeNotifications} />);

    await user.click(screen.getByRole("switch", { name: "Notifications" }));
    await user.click(screen.getByRole("button", { name: "Save profile" }));

    expect(onChange).not.toHaveBeenCalled();
    expect(onChangeNotifications).toHaveBeenCalledWith(false);
  });

  it("renders circle-only membership details", () => {
    render(<CircleDetails chat={circle} wisps={{ atlas: wisp.wisp }} onChange={vi.fn()} />);
    expect(screen.getByText("Participants (1)")).toBeVisible();
    expect(screen.getAllByText("Atlas")).not.toHaveLength(0);
    expect(screen.getByRole("group", { name: "Edit participants" })).toBeVisible();
  });
});

it("loads model and usage data lazily and keeps model details across tabs", async () => {
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
          models: [{ id: "model", name: "Model", input: ["text", "image"], maxOutputTokens: 1000 }],
        },
      ],
    },
  }));
  const getSessionReport = vi.fn(async () => ({ ok: true, value: null }));
  Object.defineProperty(window, "wisp", {
    configurable: true,
    value: {
      getAiSettings,
      getSessionReport,
      getConversationModel: vi.fn(async () => ({
        ok: true,
        value: {
          override: null,
          effective: { providerId: "test", modelId: "model" },
          applied: { providerId: "test", modelId: "model" },
          pending: null,
          status: "idle",
        },
      })),
      subscribeToAgentEvents: vi.fn(() => () => undefined),
    },
  });
  const onChange = vi.fn();
  render(<WispDetails chat={wisp} onChangeWisp={onChange} onChangeNotifications={onChange} />);
  expect(screen.getByRole("tab", { name: "General" })).toHaveAttribute("aria-selected", "true");
  expect(getAiSettings).not.toHaveBeenCalled();
  expect(getSessionReport).not.toHaveBeenCalled();
  await user.clear(screen.getByRole("textbox", { name: "Name" }));
  await user.type(screen.getByRole("textbox", { name: "Name" }), "Unsent name");
  await user.click(screen.getByRole("tab", { name: "Model" }));
  expect(await screen.findByText("Test")).toBeVisible();
  expect(screen.getByText("model")).toBeVisible();
  expect(screen.getByText(/set when the Wisp is created/)).toBeVisible();
  await user.click(screen.getByRole("tab", { name: "Usage" }));
  expect(await screen.findByText("No session yet")).toBeVisible();
  await user.click(screen.getByRole("tab", { name: "Model" }));
  expect(screen.getByText("Test")).toBeVisible();
  expect(getAiSettings).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("tab", { name: "General" }));
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Unsent name");
  expect(onChange).not.toHaveBeenCalled();
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
  render(<WispDetails chat={wisp} onChangeWisp={vi.fn()} onChangeNotifications={vi.fn()} />);
  screen.getByRole("tab", { name: "General" }).focus();
  await user.keyboard("{ArrowRight}{Enter}");
  expect(screen.getByRole("tab", { name: "Model" })).toHaveFocus();
  expect(screen.getByRole("tab", { name: "Model" })).toHaveAttribute("aria-selected", "true");
});

import { render, screen } from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CircleDetails } from "@/components/circle-details";
import { WispSettingsDialog, WispSettingsSectionContent, type WispSettingsSection } from "@/components/wisp-settings";
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

  it("renders circle-only membership details", () => {
    render(<CircleDetails chat={circle} wisps={{ atlas: wisp.wisp }} onChange={vi.fn()} />);
    expect(screen.getByText("Participants (1)")).toBeVisible();
    expect(screen.getAllByText("Atlas")).not.toHaveLength(0);
    expect(screen.getByRole("group", { name: "Edit participants" })).toBeVisible();
  });
});

/** The dialog as the side panel opens it, with its sections switched by the person. */
function SettingsDialog({ onChangeWisp = vi.fn() }: { onChangeWisp?: () => void }) {
  const [section, setSection] = useState<WispSettingsSection | null>("profile");
  return <WispSettingsDialog chat={wisp} section={section} onSectionChange={setSection} onChangeWisp={onChangeWisp} />;
}

it("loads model and usage data when shown and keeps an unsaved edit across sections", async () => {
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
  render(<SettingsDialog onChangeWisp={onChange} />);
  expect(screen.getByRole("button", { name: "Profile" })).toHaveAttribute("aria-current", "page");
  expect(getAiSettings).not.toHaveBeenCalled();
  expect(getSessionReport).not.toHaveBeenCalled();
  await user.clear(screen.getByRole("textbox", { name: "Name" }));
  await user.type(screen.getByRole("textbox", { name: "Name" }), "Unsent name");
  await user.click(screen.getByRole("button", { name: "Model" }));
  expect(await screen.findByText("Test")).toBeVisible();
  expect(screen.getByText(/set when the Wisp is created/)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Usage" }));
  expect(await screen.findByText(/No agent session yet/)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Model" }));
  expect(screen.getByText("Test")).toBeVisible();
  expect(getAiSettings).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", { name: "Profile" }));
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Unsent name");
  expect(onChange).not.toHaveBeenCalled();
});

it("moves between sections with the arrow keys", async () => {
  const user = userEvent.setup();
  Object.defineProperty(window, "wisp", {
    configurable: true,
    value: {
      getAiSettings: vi.fn(async () => ({ ok: false, error: { message: "No settings yet" } })),
      getConversationModel: vi.fn(async () => ({ ok: false, error: { message: "No model yet" } })),
      subscribeToAgentEvents: vi.fn(() => () => undefined),
    },
  });
  render(<SettingsDialog />);
  screen.getByRole("button", { name: "Profile" }).focus();
  await user.keyboard("{ArrowDown}");
  expect(screen.getByRole("button", { name: "Model" })).toHaveFocus();
  expect(screen.getByRole("button", { name: "Model" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("heading", { name: "Model" })).toBeVisible();
  await user.keyboard("{ArrowUp}");
  expect(screen.getByRole("button", { name: "Profile" })).toHaveFocus();
  expect(screen.getByRole("textbox", { name: "Name" })).toBeVisible();
});

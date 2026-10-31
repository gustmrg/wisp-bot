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
    // A written soul opens on its preview.
    expect(screen.getByText("Researches")).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Soul" })).not.toBeInTheDocument();
  });

  it("edits the soul after switching to Edit", async () => {
    const user = userEvent.setup();
    render(<WispSettingsSectionContent chat={wisp} section="profile" onChangeWisp={vi.fn()} />);

    await user.click(screen.getByRole("radio", { name: "Edit" }));

    const soul = screen.getByRole("textbox", { name: "Soul" });
    expect(soul).toHaveValue("Researches");
    expect(soul).toHaveAttribute("maxlength", "10000");
  });

  it("opens an empty soul on its preview too, still offering its templates", () => {
    render(
      <WispSettingsSectionContent
        chat={wispChatView("nova", { wisp: { soul: "" } })}
        section="profile"
        onChangeWisp={vi.fn()}
      />,
    );

    expect(screen.getByRole("radio", { name: "Preview" })).toBeChecked();
    expect(screen.queryByRole("textbox", { name: "Soul" })).not.toBeInTheDocument();
    expect(screen.getByText("Nothing written yet.")).toBeVisible();
    expect(screen.getByRole("group", { name: "Soul templates" })).toBeVisible();
  });

  it("opens a written soul on its preview in the details panel too", () => {
    render(<WispDetails chat={wisp} onChangeWisp={vi.fn()} onChangeNotifications={vi.fn()} />);

    expect(screen.getByRole("radio", { name: "Preview" })).toBeChecked();
    expect(screen.queryByRole("textbox", { name: "Soul" })).not.toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: "Tutor" }));
    // A template opens on its preview, ready to use, with Edit to make it the person's own.
    expect(screen.getByRole("heading", { name: "Identity" })).toBeVisible();
    expect(screen.getByText(/The Tutor soul is ready to use as it is/)).toBeVisible();
    expect(screen.queryByRole("group", { name: "Soul templates" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "Edit" }));
    const soul = screen.getByRole("textbox", { name: "Soul" });
    expect((soul as HTMLTextAreaElement).value).toContain("# Identity\nYou are a patient tutor.");
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

  it("renders circle-only membership details on the Members tab", async () => {
    const user = userEvent.setup();
    render(<CircleDetails chat={circle} wisps={{ atlas: wisp.wisp }} onChange={vi.fn()} />);
    expect(screen.getByRole("tab", { name: "General" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("textbox", { name: "Name" })).toBeVisible();
    expect(screen.getByText("Participants (1)")).not.toBeVisible();

    await user.click(screen.getByRole("tab", { name: "Members" }));

    expect(screen.getByText("Participants (1)")).toBeVisible();
    expect(screen.getByRole("group", { name: "Participants (1)" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Remove Atlas" })).toBeVisible();
  });

  it("shows a circle's shared workspace and lets its size change", async () => {
    const user = userEvent.setup();
    const MIB = 1024 * 1024;
    const getWorkspace = vi.fn(async () => ({
      ok: true as const,
      value: { usedBytes: 10 * MIB, quotaBytes: 512 * MIB, maxQuotaBytes: 10 * 1024 * MIB },
    }));
    const setWorkspaceQuota = vi.fn(async ({ quotaBytes }: { quotaBytes: number }) => ({
      ok: true as const,
      value: { usedBytes: 10 * MIB, quotaBytes, maxQuotaBytes: 10 * 1024 * MIB },
    }));
    Object.defineProperty(window, "wisp", { configurable: true, value: { getWorkspace, setWorkspaceQuota } });
    render(<CircleDetails chat={circle} wisps={{ atlas: wisp.wisp }} onChange={vi.fn()} />);
    // Loaded only once the tab is opened.
    expect(getWorkspace).not.toHaveBeenCalled();

    await user.click(screen.getByRole("tab", { name: "Workspace" }));

    expect(await screen.findByText("10.0 MiB of 512 MiB used")).toBeVisible();
    expect(screen.getByText(/every Wisp in this circle reads and writes/)).toBeVisible();
    expect(getWorkspace).toHaveBeenCalledWith({ conversationId: "crew" });
    await user.click(screen.getByRole("combobox", { name: "Size" }));
    await user.click(await screen.findByRole("option", { name: "2.0 GiB" }));
    expect(setWorkspaceQuota).toHaveBeenCalledWith({ conversationId: "crew", quotaBytes: 2 * 1024 * MIB });
    expect(await screen.findByText("10.0 MiB of 2.0 GiB used")).toBeVisible();
  });

  it("makes the chosen lead the circle's first member", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const nova = wispChatView("nova", { wisp: { name: "Nova" } }).wisp;
    render(
      <CircleDetails
        chat={circleChatView("crew", [wisp.wisp, nova])}
        wisps={{ atlas: wisp.wisp, nova }}
        onChange={onChange}
      />,
    );
    await user.click(screen.getByRole("tab", { name: "Members" }));

    expect(screen.getByRole("radio", { name: "Atlas" })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: "Nova" }));
    await user.click(screen.getByRole("button", { name: "Save circle" }));

    expect(onChange).toHaveBeenCalledWith({ kind: "circle", memberIds: ["nova", wisp.wisp.id] });
  });

  it("removes a participant only once the circle is saved", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn(async () => true);
    const nova = wispChatView("nova", { wisp: { name: "Nova" } }).wisp;
    render(
      <CircleDetails
        chat={circleChatView("crew", [wisp.wisp, nova])}
        wisps={{ atlas: wisp.wisp, nova }}
        onChange={onChange}
      />,
    );
    await user.click(screen.getByRole("tab", { name: "Members" }));

    await user.click(screen.getByRole("button", { name: "Remove Nova" }));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText("Participants (1)")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Save circle" }));
    expect(onChange).toHaveBeenCalledWith({ kind: "circle", memberIds: [wisp.wisp.id] });
  });

  it("saves only what changed, and discards the rest", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn(async () => true);
    render(<CircleDetails chat={circle} wisps={{ atlas: wisp.wisp }} onChange={onChange} />);
    expect(screen.queryByRole("button", { name: "Save circle" })).toBeNull();

    await user.type(screen.getByRole("textbox", { name: "Label (optional)" }), "Ops");
    await user.click(screen.getByRole("switch", { name: "Notifications" }));
    await user.click(screen.getByRole("button", { name: "Discard" }));

    expect(screen.getByRole("textbox", { name: "Label (optional)" })).toHaveValue(circle.label);
    expect(screen.queryByRole("button", { name: "Save circle" })).toBeNull();
    await user.clear(screen.getByRole("textbox", { name: "Name" }));
    await user.click(screen.getByRole("button", { name: "Save circle" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ kind: "circle", name: "Untitled" });
  });

  it("keeps unsaved edits from every tab and saves them together", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn(async () => true);
    const nova = wispChatView("nova", { wisp: { name: "Nova" } }).wisp;
    render(
      <CircleDetails
        chat={circleChatView("crew", [wisp.wisp, nova], { name: "Crew" })}
        wisps={{ atlas: wisp.wisp, nova }}
        onChange={onChange}
      />,
    );

    await user.type(screen.getByRole("textbox", { name: "Label (optional)" }), "Ops");
    await user.click(screen.getByRole("tab", { name: "Members" }));
    await user.click(screen.getByRole("button", { name: "Remove Nova" }));
    await user.click(screen.getByRole("tab", { name: "General" }));

    expect(screen.getByRole("textbox", { name: "Label (optional)" })).toHaveValue(`${circle.label}Ops`);
    await user.click(screen.getByRole("button", { name: "Save circle" }));
    expect(onChange).toHaveBeenCalledWith({ kind: "circle", label: `${circle.label}Ops`, memberIds: [wisp.wisp.id] });
  });

  it("shows each member's usage in the circle on the Usage tab", async () => {
    const user = userEvent.setup();
    const totals = {
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 1200,
      costUsd: 0.5,
      cacheSavingsUsd: 0,
    };
    const getUsageReport = vi.fn(async () => ({
      ok: true as const,
      value: {
        generatedAt: "2026-10-25T00:00:00Z",
        from: null,
        period: "30d",
        pricingUpdatedAt: null,
        incomplete: false,
        wisps: [{ conversationId: wisp.wisp.id, name: "Atlas", sessions: 1, totals }],
        totals,
      },
    }));
    Object.defineProperty(window, "wisp", { configurable: true, value: { getUsageReport } });
    render(<CircleDetails chat={circle} wisps={{ atlas: wisp.wisp }} onChange={vi.fn()} />);
    expect(getUsageReport).not.toHaveBeenCalled();

    await user.click(screen.getByRole("tab", { name: "Usage" }));

    expect(await screen.findByRole("rowheader", { name: /Atlas/ })).toBeVisible();
    expect(getUsageReport).toHaveBeenCalledWith({ period: "30d", conversationId: "crew" });
    expect(screen.getByText(/Their usage elsewhere is not included/)).toBeInTheDocument();
  });

  it("keeps the changes and says so when the circle cannot be saved", async () => {
    const user = userEvent.setup();
    render(<CircleDetails chat={circle} wisps={{ atlas: wisp.wisp }} onChange={vi.fn(async () => false)} />);

    await user.click(screen.getByRole("switch", { name: "Notifications" }));
    await user.click(screen.getByRole("button", { name: "Save circle" }));

    expect(await screen.findByText("Could not save circle settings.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save circle" })).toBeEnabled();
  });
});

it("loads model and usage data lazily and keeps model details across tabs", async () => {
  const user = userEvent.setup();
  const getAiSettings = vi.fn(async () => ({
    ok: true,
    value: {
      selection: { providerId: "test", modelId: "model" },
      fallback: { selection: null, unavailable: null },
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
          fallback: "global",
        },
      })),
      manageContext: vi.fn(async () => ({ ok: true, value: { tokens: 0 } })),
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
  expect(await screen.findByText("Test · model")).toBeVisible();
  expect(screen.getByText(/follows the global model/)).toBeVisible();
  await user.click(screen.getByRole("tab", { name: "Usage" }));
  expect(await screen.findByText("No session yet")).toBeVisible();
  await user.click(screen.getByRole("tab", { name: "Model" }));
  expect(screen.getByText("Test · model")).toBeVisible();
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
      manageContext: vi.fn(async () => ({ ok: true, value: { tokens: 0 } })),
      subscribeToAgentEvents: vi.fn(() => () => undefined),
    },
  });
  render(<WispDetails chat={wisp} onChangeWisp={vi.fn()} onChangeNotifications={vi.fn()} />);
  screen.getByRole("tab", { name: "General" }).focus();
  await user.keyboard("{ArrowRight}{Enter}");
  expect(screen.getByRole("tab", { name: "Model" })).toHaveFocus();
  expect(screen.getByRole("tab", { name: "Model" })).toHaveAttribute("aria-selected", "true");
});

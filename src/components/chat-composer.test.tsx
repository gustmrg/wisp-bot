import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConnectionsView } from "../../shared/connections";
import type { WispApi } from "../../shared/contracts";
import { messageWithAttachments } from "../../shared/workspace";
import type { ChatView } from "@/chat-data";
import { circleChatView, wispChatView } from "@/test/chat-fixtures";
import { ChatComposer } from "@/components/chat-composer";
import { ActiveConnectionContext } from "@/features/connections/active-connection";
import { notifyProviderCredentialsChanged } from "@/lib/voice-credentials";

function wisp(id: string, name = id): ChatView {
  return wispChatView(id, { wisp: { name } });
}

const defaultProps = {
  status: "idle" as const,
  acknowledging: false,
  onAbort: vi.fn(),
  onSend: vi.fn(),
};

describe("ChatComposer", () => {
  it("starts a new topic from the + menu only after confirmation", async () => {
    const user = userEvent.setup();
    const onNewTopic = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce("Wait for the Wisp to finish before changing its context.")
      .mockResolvedValueOnce(null);
    render(<ChatComposer {...defaultProps} chat={wisp("one", "One")} onNewTopic={onNewTopic} />);
    await user.click(screen.getByRole("button", { name: "Attach, schedule or new topic" }));
    await user.click(await screen.findByRole("button", { name: "New topic" }));
    expect(onNewTopic).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(await screen.findByRole("button", { name: "New topic" }));
    await user.click(screen.getByRole("button", { name: "Start new topic" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/finish/);
    await user.click(screen.getByRole("button", { name: "Start new topic" }));
    expect(onNewTopic).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Start new topic" })).toBeNull());
  });

  it("offers a new topic only for an idle Wisp", async () => {
    const user = userEvent.setup();
    const onNewTopic = vi.fn(async () => null);
    const { rerender } = render(
      <ChatComposer {...defaultProps} status="working" chat={wisp("one", "One")} onNewTopic={onNewTopic} />,
    );
    await user.click(screen.getByRole("button", { name: "Attach, schedule or new topic" }));
    expect(await screen.findByRole("button", { name: "New topic" })).toBeDisabled();
    rerender(<ChatComposer {...defaultProps} chat={wisp("one", "One")} />);
    expect(screen.queryByRole("button", { name: "New topic" })).toBeNull();
  });

  it("keeps the unsent draft when it remounts, as after a reconnect", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<ChatComposer {...defaultProps} chat={wisp("one", "One")} />);
    await user.type(screen.getByRole("textbox", { name: "Message One" }), "Half a thought");
    unmount();

    render(<ChatComposer {...defaultProps} chat={wisp("one", "One")} />);
    expect(screen.getByRole("textbox", { name: "Message One" })).toHaveValue("Half a thought");
  });

  it("keeps each conversation's draft apart and forgets one once sent", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    const { rerender } = render(<ChatComposer {...defaultProps} key="one" chat={wisp("one", "One")} onSend={onSend} />);
    await user.type(screen.getByRole("textbox", { name: "Message One" }), "Hello{Enter}");
    expect(onSend).toHaveBeenCalledWith("Hello");
    await user.type(screen.getByRole("textbox", { name: "Message One" }), "Unsent");

    rerender(<ChatComposer {...defaultProps} key="two" chat={wisp("two", "Two")} onSend={onSend} />);
    expect(screen.getByRole("textbox", { name: "Message Two" })).toHaveValue("");
    rerender(<ChatComposer {...defaultProps} key="one" chat={wisp("one", "One")} onSend={onSend} />);
    expect(screen.getByRole("textbox", { name: "Message One" })).toHaveValue("Unsent");
  });

  it("schedules the draft from the shortcut instead of sending it", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    const onSchedule = vi.fn(async () => null);
    render(<ChatComposer {...defaultProps} chat={wisp("one", "One")} onSend={onSend} onSchedule={onSchedule} />);
    const input = screen.getByRole("textbox", { name: "Message One" });
    await user.type(input, "Good morning");
    await user.keyboard("{Control>}{Shift>}{Enter}{/Shift}{/Control}");
    await user.click(await screen.findByRole("button", { name: /Tomorrow morning/ }));

    expect(onSchedule).toHaveBeenCalledWith("Good morning", expect.any(Date));
    const at = (onSchedule.mock.calls[0] as unknown as [string, Date])[1];
    expect([at.getHours(), at.getMinutes()]).toEqual([9, 0]);
    expect(onSend).not.toHaveBeenCalled();
    await waitFor(() => expect(input).toHaveValue(""));
  });

  it("schedules at a custom time without submitting the message", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    const onSchedule = vi.fn(async () => "This Wisp already has too many scheduled messages.");
    render(<ChatComposer {...defaultProps} chat={wisp("one", "One")} onSend={onSend} onSchedule={onSchedule} />);
    const input = screen.getByRole("textbox", { name: "Message One" });
    await user.type(input, "Later");
    await user.click(screen.getByRole("button", { name: "Attach, schedule or new topic" }));
    await user.click(await screen.findByRole("button", { name: "Schedule send" }));
    await user.click(await screen.findByRole("button", { name: "Set time" }));
    // Picking a time from the + menu only marks the draft; the main button schedules it.
    expect(onSchedule).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Schedule message" }));

    expect(onSchedule).toHaveBeenCalledWith("Later", expect.any(Date));
    expect(onSend).not.toHaveBeenCalled();
    // A failure keeps the draft and says why.
    expect(await screen.findAllByText("This Wisp already has too many scheduled messages.")).not.toHaveLength(0);
    expect(input).toHaveValue("Later");
  });

  it("offers scheduling only when the backend supports it", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ChatComposer {...defaultProps} chat={wisp("one", "One")} />);
    expect(screen.getByRole("button", { name: "Attach files" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Attach, schedule or new topic" })).toBeNull();
    rerender(<ChatComposer {...defaultProps} chat={wisp("one", "One")} onSchedule={vi.fn(async () => null)} />);
    await user.click(screen.getByRole("button", { name: "Attach, schedule or new topic" }));
    expect(await screen.findByRole("button", { name: "Schedule send" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Attach files" })).toBeEnabled();
  });

  it("lets a time be picked before writing and dropped again", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    const onSchedule = vi.fn(async () => null);
    render(<ChatComposer {...defaultProps} chat={wisp("one", "One")} onSend={onSend} onSchedule={onSchedule} />);
    await user.click(screen.getByRole("button", { name: "Attach, schedule or new topic" }));
    await user.click(await screen.findByRole("button", { name: "Schedule send" }));
    await user.click(await screen.findByRole("button", { name: /Tomorrow morning/ }));

    expect(screen.getByRole("button", { name: "Schedule message" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Remove the scheduled time" }));
    await user.type(screen.getByRole("textbox", { name: "Message One" }), "Now{enter}");

    expect(onSend).toHaveBeenCalledWith("Now");
    expect(onSchedule).not.toHaveBeenCalled();
  });

  it("schedules from the send button's menu", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    const onSchedule = vi.fn(async () => null);
    render(<ChatComposer {...defaultProps} chat={wisp("one", "One")} onSend={onSend} onSchedule={onSchedule} />);
    await user.type(screen.getByRole("textbox", { name: "Message One" }), "Good morning");
    await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("button", { name: "Send message" }) });
    await user.click(await screen.findByRole("menuitem", { name: /Tomorrow morning/ }));

    expect(onSchedule).toHaveBeenCalledWith("Good morning", expect.any(Date));
    expect(onSend).not.toHaveBeenCalled();
  });

  it("keeps the send button's menu open when a long press ends", async () => {
    const onSend = vi.fn();
    render(
      <ChatComposer
        {...defaultProps}
        chat={wisp("one", "One")}
        onSend={onSend}
        onSchedule={vi.fn(async () => null)}
        mobile
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Message One" }), { target: { value: "Later" } });
    vi.useFakeTimers();
    try {
      const send = screen.getByRole("button", { name: "Send message" });
      fireEvent.touchStart(send, { touches: [{ clientX: 10, clientY: 10 }] });
      act(() => vi.advanceTimersByTime(600));
      expect(screen.getByRole("menu", { name: "Schedule send" })).toBeInTheDocument();
      // A prevented touchend stops the browser's follow-up click, which would close the menu or send.
      expect(fireEvent.touchEnd(send)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
    expect(onSend).not.toHaveBeenCalled();
  });

  it("puts voice input in the main button on a phone until there is something to send", async () => {
    const user = userEvent.setup();
    const onAbort = vi.fn();
    const { rerender } = render(<ChatComposer {...defaultProps} chat={wisp("one", "One")} mobile />);
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Start voice input" })).toHaveLength(1);

    await user.type(screen.getByRole("textbox", { name: "Message One" }), "Hi");
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
    expect(screen.getAllByRole("button", { name: "Start voice input" })).toHaveLength(1);

    // While the Wisp works, the main button queues the draft and stop moves into the field.
    rerender(<ChatComposer {...defaultProps} chat={wisp("one", "One")} mobile status="working" onAbort={onAbort} />);
    expect(screen.getByRole("button", { name: "Queue message" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Start voice input" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Stop response" }));
    expect(onAbort).toHaveBeenCalledOnce();
  });

  it("uses Enter for newlines on mobile and sends only through the send control", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(
      <ChatComposer
        {...defaultProps}
        chat={wisp("one", "One")}
        onSend={onSend}
        autoFocus={false}
        enterToSend={false}
      />,
    );
    const input = screen.getByRole("textbox", { name: "Message One" });
    expect(input).not.toHaveFocus();
    await user.type(input, "First line{enter}Second line");
    expect(onSend).not.toHaveBeenCalled();
    expect(input).toHaveValue("First line\nSecond line");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSend).toHaveBeenCalledWith("First line\nSecond line");
  });
  it("attaches workspace files, lets one be removed, and lists the rest in the sent message", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    const attachWorkspaceFiles = vi.fn(async () => ({
      ok: true as const,
      value: {
        files: [
          { name: "a.txt", path: "inbox/a.txt", size: 1 },
          { name: "b.csv", path: "inbox/b.csv", size: 2 },
        ],
        workspace: { usedBytes: 3, quotaBytes: 1024 },
      },
    }));
    Object.defineProperty(window, "wisp", { configurable: true, value: { attachWorkspaceFiles } });
    render(<ChatComposer {...defaultProps} chat={wisp("one", "One")} onSend={onSend} />);

    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Attach files" }));
    expect(attachWorkspaceFiles).toHaveBeenCalledWith({ conversationId: "one" });
    await user.click(await screen.findByRole("button", { name: "Remove b.csv from this message" }));
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(onSend).toHaveBeenCalledWith("Attached to the workspace:\n- `inbox/a.txt`");
    expect(screen.queryByRole("list", { name: "Attached files" })).not.toBeInTheDocument();
  });

  it("offers attaching files when Wisps run on a server elsewhere", () => {
    const remote: ConnectionsView = {
      activeId: "home",
      profiles: [],
      status: { profileId: "home", phase: "connected", epoch: 1 },
      secureStorageAvailable: true,
    };
    render(
      <ActiveConnectionContext.Provider value={remote}>
        <ChatComposer {...defaultProps} chat={wisp("one", "One")} />
      </ActiveConnectionContext.Provider>,
    );
    expect(screen.getByRole("button", { name: "Attach files" })).toBeVisible();
  });

  it("shows why files could not be attached", async () => {
    const user = userEvent.setup();
    const attachWorkspaceFiles = vi.fn(async () => ({
      ok: false as const,
      error: { code: "invalid_request" as const, message: "This Wisp's workspace is full.", retryable: false },
    }));
    Object.defineProperty(window, "wisp", { configurable: true, value: { attachWorkspaceFiles } });
    render(<ChatComposer {...defaultProps} chat={wisp("one", "One")} />);

    await user.click(screen.getByRole("button", { name: "Attach files" }));

    expect(await screen.findByText("This Wisp's workspace is full.")).toBeInTheDocument();
  });

  it.each([
    [["text"], "photo.png", /won't be able to read the attached image/, false],
    [["text"], "scan.pdf", /can read the text of PDFs, but not scanned pages/, false],
    [["text", "image"], "photo.png", null, false],
    [["text"], "notes.txt", null, false],
    [["text"], "photo.png", /Vision \(Provider\) will read the attached image for it/, true],
    [["text"], "scan.pdf", /Vision \(Provider\) reads any scanned pages for it/, true],
    [["text", "image"], "photo.png", null, true],
  ] as const)(
    "with %j input, says what the model misses in %s (image model: %s)",
    async (input, name, hint, withImageModel) => {
      const user = userEvent.setup();
      const selection = { providerId: "provider", modelId: "model" };
      Object.defineProperty(window, "wisp", {
        configurable: true,
        value: {
          attachWorkspaceFiles: vi.fn(async () => ({
            ok: true as const,
            value: { files: [{ name, path: `inbox/${name}`, size: 1 }], workspace: { usedBytes: 1, quotaBytes: 1024 } },
          })),
          getConversationModel: vi.fn(async () => ({
            ok: true,
            value: { override: null, effective: selection, applied: selection, pending: null, status: "idle" },
          })),
          getAiSettings: vi.fn(async () => ({
            ok: true,
            value: {
              providers: [
                {
                  id: "provider",
                  name: "Provider",
                  models: [
                    { id: "model", name: "Model", input, reasoning: false, contextWindow: 1, maxOutputTokens: 1 },
                    {
                      id: "vision",
                      name: "Vision",
                      input: ["text", "image"],
                      reasoning: false,
                      contextWindow: 1,
                      maxOutputTokens: 1,
                    },
                  ],
                },
              ],
              ...(withImageModel
                ? {
                    auxiliary: {
                      imageUnderstanding: {
                        selection: { providerId: "provider", modelId: "vision" },
                        unavailable: null,
                      },
                    },
                  }
                : {}),
            },
          })),
          subscribeToAgentEvents: vi.fn(() => () => undefined),
        },
      });
      render(<ChatComposer {...defaultProps} chat={wisp("one", "One")} />);

      await user.click(screen.getByRole("button", { name: "Attach files" }));
      await screen.findByRole("button", { name: `Remove ${name} from this message` });

      if (hint) expect(await screen.findByText(hint)).toBeVisible();
      else expect(screen.queryByText(/can't see images/)).not.toBeInTheDocument();
    },
  );

  it("submits Enter, preserves Shift+Enter, and clears a submitted draft", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<ChatComposer {...defaultProps} chat={wisp("one", "One")} onSend={onSend} />);
    const input = screen.getByRole("textbox", { name: "Message One" });

    await user.type(input, "First line{shift>}{enter}{/shift}Second line");
    expect(onSend).not.toHaveBeenCalled();
    await user.type(input, "{enter}");

    expect(onSend).toHaveBeenCalledWith("First line\nSecond line");
    expect(input).toHaveValue("");
  });

  it("resets and focuses when the keyed conversation changes", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ChatComposer key="one" {...defaultProps} chat={wisp("one", "One")} />);
    await user.type(screen.getByRole("textbox", { name: "Message One" }), "unsent");

    rerender(<ChatComposer key="two" {...defaultProps} chat={wisp("two", "Two")} />);

    const next = screen.getByRole("textbox", { name: "Message Two" });
    expect(next).toHaveValue("");
    expect(next).toHaveFocus();
  });

  it("disables a circle with no members and exposes the active stop control", () => {
    const onAbort = vi.fn();
    const circle = circleChatView("crew", [], { name: "Crew" });
    const { rerender } = render(<ChatComposer {...defaultProps} chat={circle} />);
    expect(screen.getByRole("combobox", { name: "Message Crew" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Add Wisps to this circle");

    rerender(<ChatComposer {...defaultProps} chat={wisp("one", "One")} status="working" onAbort={onAbort} />);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    screen.getByRole("button", { name: "Stop response" }).click();
    expect(onAbort).toHaveBeenCalledOnce();
  });

  it("sends to a circle and completes mentions of its members", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    const atlas = wispChatView("atlas", { wisp: { name: "Atlas", role: "Research" } }).wisp;
    const nova = wispChatView("nova", { wisp: { name: "Nova Lee", role: "Writing" } }).wisp;
    render(
      <ChatComposer {...defaultProps} onSend={onSend} chat={circleChatView("crew", [atlas, nova], { name: "Crew" })} />,
    );
    const input = screen.getByRole("combobox", { name: "Message Crew" });

    await user.type(input, "Ask @");
    const list = screen.getByRole("listbox", { name: "Mention a Wisp" });
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "AtlasResearch",
      "Nova LeeWriting",
    ]);
    expect(input).toHaveAttribute("aria-expanded", "true");
    await user.type(input, "n");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    await user.keyboard("{Enter}");
    expect(input).toHaveValue("Ask @Nova Lee ");
    expect(list).not.toBeInTheDocument();

    await user.type(input, "and @at{Tab}to check{Enter}");
    expect(onSend).toHaveBeenCalledWith("Ask @Nova Lee and @Atlas to check");

    // Escape leaves what was typed; an @ inside a word is no mention.
    await user.type(input, "@x{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await user.clear(input);
    await user.type(input, "ada@");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("puts follow-ups the stopped turn never read back into the draft, after what is typed", async () => {
    const user = userEvent.setup();
    const onAbort = vi.fn(async () => [
      {
        id: "q1",
        conversationId: "steer",
        createdAt: "2026-10-18T12:00:00.000Z",
        text: messageWithAttachments("Only the summary", [{ path: "inbox/notes.md" }]),
        followUp: true as const,
      },
      { id: "q2", conversationId: "steer", createdAt: "2026-10-18T12:00:01.000Z", text: "In Portuguese" },
    ]);
    render(<ChatComposer {...defaultProps} chat={wisp("steer", "Steer")} status="working" onAbort={onAbort} />);
    const input = screen.getByRole("textbox", { name: "Message Steer" });
    await user.type(input, "Draft");

    await user.click(screen.getByRole("button", { name: "Stop response" }));

    await waitFor(() => expect(input).toHaveValue("Draft\n\nOnly the summary\n\nIn Portuguese"));
    expect(screen.getByText("notes.md")).toBeInTheDocument();
  });

  it("keeps draft updates below unrelated siblings", async () => {
    const user = userEvent.setup();
    const renderSibling = vi.fn();
    function UnrelatedSidebar() {
      renderSibling();
      return <aside>Sidebar</aside>;
    }
    render(
      <>
        <UnrelatedSidebar />
        <ChatComposer {...defaultProps} chat={wisp("one", "One")} />
      </>,
    );

    await user.type(screen.getByRole("textbox", { name: "Message One" }), "local draft");

    expect(renderSibling).toHaveBeenCalledOnce();
  });
});

it("blocks first-run sends without losing the draft and offers configuration", async () => {
  const user = userEvent.setup();
  const onSend = vi.fn();
  const onConfigure = vi.fn();
  const props = { ...defaultProps, chat: wisp("new", "New"), onSend, onConfigure };
  const { rerender } = render(<ChatComposer {...props} status="configuration_required" />);
  const input = screen.getByRole("textbox", { name: "Message New" });
  await user.type(input, "First task{enter}");
  expect(onSend).not.toHaveBeenCalled();
  expect(input).toHaveValue("First task");
  expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Configure AI model" }));
  expect(onConfigure).toHaveBeenCalledOnce();
  rerender(<ChatComposer {...props} status="idle" />);
  expect(input).toHaveValue("First task");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  expect(onSend).toHaveBeenCalledWith("First task");
});

describe("ChatComposer voice input", () => {
  class FakeMediaRecorder extends EventTarget {
    static isTypeSupported = (type: string) => type === "audio/webm;codecs=opus";
    state: RecordingState = "inactive";
    mimeType = "audio/webm;codecs=opus";
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      this.dispatchEvent(Object.assign(new Event("dataavailable"), { data: new Blob(["voice"]) }));
      this.dispatchEvent(new Event("stop"));
    }
  }
  const track = { stop: vi.fn() };
  const getUserMedia = vi.fn(async () => ({ getTracks: () => [track] }) as unknown as MediaStream);
  const microphone = { kind: "audioinput", deviceId: "default", label: "" } as MediaDeviceInfo;
  const enumerateDevices = vi.fn(async () => [microphone]);
  let mediaDevices: EventTarget;
  const getVoiceSettings = vi.fn<WispApi["getVoiceSettings"]>();
  function voiceSettings(credentialConfigured: boolean): Awaited<ReturnType<WispApi["getVoiceSettings"]>> {
    return {
      ok: true,
      value: { secureStorageAvailable: true, providers: [{ id: "groq", name: "Groq", credentialConfigured }] },
    };
  }

  type TranscribeAudio = ReturnType<typeof vi.fn<WispApi["transcribeAudio"]>>;
  function setup(
    transcribeAudio: TranscribeAudio = vi.fn<WispApi["transcribeAudio"]>(async () => ({
      ok: true,
      value: { text: "dictated words" },
    })),
  ): TranscribeAudio {
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    enumerateDevices.mockReset().mockResolvedValue([microphone]);
    mediaDevices = Object.assign(new EventTarget(), { getUserMedia, enumerateDevices });
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: mediaDevices });
    getVoiceSettings.mockReset().mockResolvedValue(voiceSettings(true));
    Object.defineProperty(window, "wisp", { configurable: true, value: { transcribeAudio, getVoiceSettings } });
    return transcribeAudio;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    getUserMedia.mockClear();
    track.stop.mockClear();
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
  });

  it("blocks clicks and the shortcut without a speech-to-text key and explains why on hover", async () => {
    const user = userEvent.setup();
    setup();
    getVoiceSettings.mockResolvedValue(voiceSettings(false));
    render(<ChatComposer {...defaultProps} chat={wisp("one", "One")} />);
    await waitFor(() => expect(getVoiceSettings).toHaveBeenCalledOnce());
    const button = screen.getByRole("button", { name: "Start voice input" });
    await waitFor(() => expect(button).toBeDisabled());
    await user.click(button.parentElement!);
    await user.keyboard("{Control>} {/Control}");
    expect(getUserMedia).not.toHaveBeenCalled();
    await user.unhover(button.parentElement!);
    await user.hover(button.parentElement!);
    expect(await screen.findByText("Add a speech-to-text API key in Settings to use voice input.")).toBeVisible();
  });

  it("enables voice input once a key is saved in Settings", async () => {
    setup();
    getVoiceSettings.mockResolvedValue(voiceSettings(false));
    render(<ChatComposer {...defaultProps} chat={wisp("one", "One")} />);
    const button = screen.getByRole("button", { name: "Start voice input" });
    await waitFor(() => expect(getVoiceSettings).toHaveBeenCalledOnce());
    expect(button).toBeDisabled();
    getVoiceSettings.mockResolvedValue(voiceSettings(true));
    act(() => notifyProviderCredentialsChanged());
    await waitFor(() => expect(button).toBeEnabled());
  });

  it("blocks clicks and the shortcut without a microphone and explains why on hover", async () => {
    const user = userEvent.setup();
    setup();
    enumerateDevices.mockResolvedValue([{ kind: "audiooutput" } as MediaDeviceInfo]);
    render(<ChatComposer {...defaultProps} chat={wisp("one", "One")} />);
    await waitFor(() => expect(enumerateDevices).toHaveBeenCalledOnce());
    const button = screen.getByRole("button", { name: "Start voice input" });
    expect(button).toBeDisabled();
    await user.click(button.parentElement!);
    await user.keyboard("{Control>} {/Control}");
    expect(getUserMedia).not.toHaveBeenCalled();
    await user.unhover(button.parentElement!);
    await user.hover(button.parentElement!);
    expect(await screen.findByText("No microphone was found. Connect a microphone to use voice input.")).toBeVisible();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("updates the button when microphones are connected or removed", async () => {
    setup();
    enumerateDevices.mockResolvedValue([]);
    render(<ChatComposer {...defaultProps} chat={wisp("one", "One")} />);
    await waitFor(() => expect(enumerateDevices).toHaveBeenCalledOnce());
    const button = screen.getByRole("button", { name: "Start voice input" });
    expect(button).toBeDisabled();
    enumerateDevices.mockResolvedValue([microphone]);
    await act(async () => mediaDevices.dispatchEvent(new Event("devicechange")));
    expect(button).toBeEnabled();
    enumerateDevices.mockResolvedValue([]);
    await act(async () => mediaDevices.dispatchEvent(new Event("devicechange")));
    expect(button).toBeDisabled();
  });

  it("blocks voice input until device detection finishes", async () => {
    const user = userEvent.setup();
    setup();
    let resolveDevices!: (devices: MediaDeviceInfo[]) => void;
    enumerateDevices.mockReturnValue(
      new Promise((resolve) => {
        resolveDevices = resolve;
      }),
    );
    render(<ChatComposer {...defaultProps} chat={wisp("one", "One")} />);
    const button = screen.getByRole("button", { name: "Start voice input" });
    expect(button).toBeDisabled();
    await user.keyboard("{Control>} {/Control}");
    expect(getUserMedia).not.toHaveBeenCalled();
    await act(async () => resolveDevices([microphone]));
    expect(button).toBeEnabled();
  });

  it("allows requesting microphone access if enumeration fails", async () => {
    setup();
    enumerateDevices.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    render(<ChatComposer {...defaultProps} chat={wisp("one", "One")} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Start voice input" })).toBeEnabled());
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("disables recording if the microphone disappears before it starts", async () => {
    const user = userEvent.setup();
    setup();
    getUserMedia.mockRejectedValueOnce(new DOMException("missing", "NotFoundError"));
    render(<ChatComposer {...defaultProps} chat={wisp("one", "One")} />);
    const button = screen.getByRole("button", { name: "Start voice input" });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    expect(await screen.findByText("No microphone was found.")).toBeInTheDocument();
    expect(button).toBeDisabled();
    await user.keyboard("{Control>} {/Control}");
    expect(getUserMedia).toHaveBeenCalledOnce();
  });

  it("records, transcribes, and inserts the text at the cursor without sending", async () => {
    const user = userEvent.setup();
    const transcribeAudio = setup();
    const onSend = vi.fn();
    render(<ChatComposer {...defaultProps} chat={wisp("one", "One")} onSend={onSend} />);
    const input = screen.getByRole("textbox", { name: "Message One" });
    await user.type(input, "Please  now");
    (input as HTMLTextAreaElement).setSelectionRange(7, 7);

    await user.click(screen.getByRole("button", { name: "Start voice input" }));
    expect(await screen.findByText(/Recording… Press Ctrl\+Space/)).toBeInTheDocument();
    // The main button stops the recording instead of sending.
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Stop recording and transcribe" }));

    await waitFor(() => expect(input).toHaveValue("Please dictated words now"));
    expect(transcribeAudio).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "groq",
        modelId: "whisper-large-v3-turbo",
        language: "auto",
        mimeType: "audio/webm",
        audio: expect.any(Uint8Array),
      }),
    );
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(track.stop).toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("fills the composer width with meter bars", async () => {
    const user = userEvent.setup();
    setup();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private readonly callback: ResizeObserverCallback) {}
        observe() {
          this.callback([{ contentRect: { width: 597 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
        }
        disconnect() {}
      },
    );
    const { container } = render(<ChatComposer {...defaultProps} chat={wisp("one", "One")} />);

    await user.click(screen.getByRole("button", { name: "Start voice input" }));
    await screen.findByRole("button", { name: "Stop recording and transcribe" });

    // 3px bars with 3px gaps: (597 + 3) / 6.
    expect(container.querySelector("[data-voice-meter]")?.children).toHaveLength(100);
  });

  it("sends the transcript right away when auto-send is on", async () => {
    const user = userEvent.setup();
    setup();
    const onSend = vi.fn();
    render(
      <ChatComposer
        {...defaultProps}
        chat={wisp("one", "One")}
        onSend={onSend}
        voice={{
          deviceId: "default",
          providerId: "groq",
          modelId: "whisper-large-v3-turbo",
          language: "auto",
          autoSend: true,
          shortcut: "Ctrl+Space",
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Start voice input" }));
    await user.click(await screen.findByRole("button", { name: "Stop recording and transcribe" }));

    await waitFor(() => expect(onSend).toHaveBeenCalledWith("dictated words"));
    expect(screen.getByRole("textbox", { name: "Message One" })).toHaveValue("");
  });

  it("toggles recording with the shortcut and discards it with Escape", async () => {
    const user = userEvent.setup();
    const transcribeAudio = setup();
    render(<ChatComposer {...defaultProps} chat={wisp("one", "One")} />);

    await user.keyboard("{Control>} {/Control}");
    expect(await screen.findByRole("button", { name: "Stop recording and transcribe" })).toBeInTheDocument();
    await user.keyboard("{Escape}");

    expect(await screen.findByRole("button", { name: "Start voice input" })).toBeInTheDocument();
    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalled();
  });

  it("ignores the shortcut while the composer is not on screen", async () => {
    const user = userEvent.setup();
    setup();
    render(<ChatComposer {...defaultProps} chat={wisp("one", "One")} voiceShortcutEnabled={false} />);

    await user.keyboard("{Control>} {/Control}");

    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("points to voice settings when the provider key is missing", async () => {
    const user = userEvent.setup();
    setup(
      vi.fn(async () => ({
        ok: false as const,
        error: {
          code: "configuration_required" as const,
          message: "Add a Groq API key in Settings to use voice input.",
          retryable: false,
        },
      })),
    );
    const onConfigureVoice = vi.fn();
    render(<ChatComposer {...defaultProps} chat={wisp("one", "One")} onConfigureVoice={onConfigureVoice} />);

    await user.click(screen.getByRole("button", { name: "Start voice input" }));
    await user.click(await screen.findByRole("button", { name: "Stop recording and transcribe" }));
    await user.click(await screen.findByRole("button", { name: "Set up voice input" }));

    expect(screen.getByText("Add a Groq API key in Settings to use voice input.")).toBeInTheDocument();
    expect(onConfigureVoice).toHaveBeenCalledOnce();
  });

  it("explains a denied microphone", async () => {
    const user = userEvent.setup();
    setup();
    getUserMedia.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
    render(<ChatComposer {...defaultProps} chat={wisp("one", "One")} />);

    await user.click(screen.getByRole("button", { name: "Start voice input" }));

    expect(await screen.findByText("Microphone access was denied.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start voice input" })).toBeEnabled();
  });
});

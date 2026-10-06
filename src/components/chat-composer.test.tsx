import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConnectionsView } from "../../shared/connections";
import type { WispApi } from "../../shared/contracts";
import type { Chat } from "../../shared/conversations";
import { ChatComposer } from "@/components/chat-composer";
import { ActiveConnectionContext } from "@/features/connections/active-connection";

function wisp(id: string, name = id): Chat {
  return {
    id,
    name,
    label: "Test",
    description: "Test",
    kind: "wisp",
    shape: "circle",
    notifyOnUpdatesEnabled: true,
    preview: "Ready",
    timestamp: "Now",
    messages: [],
  };
}

const defaultProps = {
  status: "idle" as const,
  acknowledging: false,
  onAbort: vi.fn(),
  onSend: vi.fn(),
};

describe("ChatComposer", () => {
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

  it("disables circles and exposes the active stop control", () => {
    const onAbort = vi.fn();
    const circle: Chat = { ...wisp("crew", "Crew"), kind: "circle", memberIds: [] };
    const { rerender } = render(<ChatComposer {...defaultProps} chat={circle} />);
    expect(screen.getByRole("textbox", { name: "Message Crew" })).toBeDisabled();

    rerender(<ChatComposer {...defaultProps} chat={wisp("one", "One")} status="working" onAbort={onAbort} />);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    screen.getByRole("button", { name: "Stop response" }).click();
    expect(onAbort).toHaveBeenCalledOnce();
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

  type TranscribeAudio = ReturnType<typeof vi.fn<WispApi["transcribeAudio"]>>;
  function setup(
    transcribeAudio: TranscribeAudio = vi.fn<WispApi["transcribeAudio"]>(async () => ({
      ok: true,
      value: { text: "dictated words" },
    })),
  ): TranscribeAudio {
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
    Object.defineProperty(window, "wisp", { configurable: true, value: { transcribeAudio } });
    return transcribeAudio;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    getUserMedia.mockClear();
    track.stop.mockClear();
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
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
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

import { useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { ArrowUpIcon, FileIcon, MicIcon, PaperclipIcon, SquareIcon, XIcon } from "lucide-react";

import type { ChatSummary, ManagedConversationStatus } from "../../shared/conversations";
import { messageWithAttachments, type WorkspaceAttachment } from "../../shared/workspace";

export interface ChatComposerProps {
  autoFocus?: boolean;
  enterToSend?: boolean;
  chat: ChatSummary;
  status: ManagedConversationStatus;
  error?: string;
  acknowledging: boolean;
  onConfigure?: () => void;
  onAbort: () => void;
  onSend: (text: string) => void;
}

export function ChatComposer({
  autoFocus = true,
  enterToSend = true,
  chat,
  status,
  error,
  acknowledging,
  onConfigure,
  onAbort,
  onSend,
}: ChatComposerProps) {
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<ReadonlyArray<WorkspaceAttachment>>([]);
  const [attaching, setAttaching] = useState(false);
  const [attachError, setAttachError] = useState("");
  const working = status === "working";
  const needsConfiguration = status === "configuration_required";
  const canSend = (status === "idle" || working) && !acknowledging && chat.kind === "wisp";

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const text = draft.trim();
    if ((!text && !attachments.length) || !canSend) return;
    setDraft("");
    setAttachments([]);
    setAttachError("");
    onSend(messageWithAttachments(text, attachments));
  }

  async function attachFiles(): Promise<void> {
    setAttaching(true);
    setAttachError("");
    try {
      const result = await window.wisp.attachWorkspaceFiles({ conversationId: chat.id });
      if (!result.ok) {
        setAttachError(result.error.message);
        return;
      }
      const added = result.value.files;
      setAttachments((current) => [...current, ...added.filter((file) => !current.some((c) => c.path === file.path))]);
    } catch {
      setAttachError("Could not attach files.");
    } finally {
      setAttaching(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (enterToSend && event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <form className="chat-composer flex-none px-3 pb-3" onSubmit={handleSubmit}>
      <div className="min-h-[22px] pl-2.5 text-[11px] text-dim" role="status">
        {chat.kind === "circle" ? (
          "Circle conversations are not enabled yet"
        ) : needsConfiguration ? (
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span>Choose a provider and model before sending a message.</span>
            {onConfigure ? (
              <button
                type="button"
                className="font-medium text-primary underline underline-offset-2"
                onClick={onConfigure}
              >
                Configure AI model
              </button>
            ) : null}
          </div>
        ) : (
          attachError ||
          error ||
          (attaching ? "Copying files to the workspace…" : acknowledging ? "Queueing your message…" : null)
        )}
      </div>
      {attachments.length ? (
        <ul className="mx-auto mb-1.5 flex w-full max-w-[1400px] flex-wrap gap-1.5" aria-label="Attached files">
          {attachments.map((file) => (
            <li
              key={file.path}
              className="flex max-w-[240px] items-center gap-1 rounded-md border border-border bg-muted py-0.5 pl-1.5 pr-0.5 text-[11px] [&_svg]:size-3"
            >
              <FileIcon aria-hidden="true" className="flex-none text-dim" />
              <span className="truncate" title={file.path}>
                {file.name}
              </span>
              <button
                type="button"
                className="flex size-4 flex-none items-center justify-center rounded text-dim hover:bg-accent hover:text-foreground"
                aria-label={`Remove ${file.name} from this message`}
                onClick={() => setAttachments((current) => current.filter((item) => item.path !== file.path))}
              >
                <XIcon aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="composer-input mx-auto flex min-h-[42px] w-full max-w-[1400px] items-end gap-2 rounded-[13px] border border-border bg-muted px-2 py-[7px] transition-[border-color] duration-[120ms] focus-within:border-ring">
        {chat.kind === "wisp" ? (
          <button
            type="button"
            className="flex size-[27px] flex-none items-center justify-center rounded-full border-0 bg-transparent text-dim enabled:hover:bg-accent enabled:hover:text-foreground disabled:opacity-[0.35] [&_svg]:size-3.5"
            aria-label="Attach files"
            disabled={attaching}
            onClick={() => void attachFiles()}
          >
            <PaperclipIcon aria-hidden="true" />
          </button>
        ) : null}
        <textarea
          autoFocus={autoFocus}
          rows={1}
          className="max-h-[120px] min-h-[26px] flex-1 resize-none overflow-y-auto border-0 bg-transparent py-1 pl-0 pr-0 text-foreground outline-none leading-[18px] placeholder:text-dim field-sizing-content"
          aria-label={`Message ${chat.name}`}
          placeholder={`Message ${chat.name}`}
          value={draft}
          disabled={chat.kind === "circle"}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={handleKeyDown}
        />
        <button
          type="button"
          className="flex size-[27px] flex-none items-center justify-center rounded-full border-0 bg-secondary text-dim hover:bg-accent hover:text-foreground [&_svg]:size-3.5"
          aria-label="Start voice input"
        >
          <MicIcon aria-hidden="true" />
        </button>
        {working ? (
          <button
            type="button"
            className="flex size-[27px] flex-none items-center justify-center rounded-full border-0 bg-primary text-primary-foreground hover:opacity-[0.85] [&_svg]:size-3"
            aria-label="Stop response"
            onClick={onAbort}
          >
            <SquareIcon aria-hidden="true" fill="currentColor" />
          </button>
        ) : null}
        <button
          type="submit"
          className="flex size-[27px] flex-none items-center justify-center rounded-full border-0 bg-primary text-primary-foreground enabled:hover:opacity-[0.85] disabled:opacity-[0.35] [&_svg]:size-3.5"
          aria-label={working ? "Queue message" : "Send message"}
          disabled={(!draft.trim() && !attachments.length) || !canSend}
        >
          <ArrowUpIcon aria-hidden="true" />
        </button>
      </div>
    </form>
  );
}

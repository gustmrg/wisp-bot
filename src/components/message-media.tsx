import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { DownloadIcon, FileCodeIcon, FileIcon, FileTextIcon, RotateCwIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { MarkdownView } from "@/components/markdown-view";
import {
  MARKDOWN_PREVIEW_LIMIT_BYTES,
  MEDIA_DOWNLOAD_LIMIT_BYTES,
  MEDIA_PREVIEW_LIMIT_BYTES,
  isWorkspaceMediaPath,
  mediaKind,
  mediaName,
  normalizeMediaPath,
  type ConversationMedia,
  type MediaKind,
} from "../../shared/media";
import { formatBytes } from "../../shared/workspace";

/** The Wisp's message whose files are shown: the server serves only files that message refers to. */
export interface MediaSource {
  conversationId: string;
  messageId: string;
  /** False while the reply is still being written and is not stored yet. */
  ready: boolean;
}

const MediaSourceContext = createContext<MediaSource | null>(null);

export function MediaSourceProvider({ value, children }: { value: MediaSource | null; children: ReactNode }) {
  return <MediaSourceContext.Provider value={value}>{children}</MediaSourceContext.Provider>;
}

/** The page HTML previews run in, apart from the app: see `public/media-preview.html`. */
const PREVIEW_PAGE = `${import.meta.env.BASE_URL}media-preview.html`;

type MediaState =
  | { status: "loading" }
  | { status: "ready"; media: ConversationMedia; url: string }
  | { status: "too_large"; message: string }
  | { status: "error"; message: string };

async function readMedia(
  source: Pick<MediaSource, "conversationId" | "messageId">,
  path: string,
  maxBytes: number,
): Promise<{ ok: true; media: ConversationMedia } | { ok: false; tooLarge: boolean; message: string }> {
  try {
    const result = await window.wisp.readConversationMedia({
      conversationId: source.conversationId,
      messageId: source.messageId,
      path,
      maxBytes,
    });
    if (result.ok) return { ok: true, media: result.value };
    return { ok: false, tooLarge: result.error.code === "too_large", message: result.error.message };
  } catch {
    return { ok: false, tooLarge: false, message: "The file could not be loaded." };
  }
}

function blobOf(media: ConversationMedia): Blob {
  return new Blob([media.bytes as Uint8Array<ArrayBuffer>], { type: media.mimeType });
}

/** Saves a file the app already holds, as the browser saves any download. */
function saveMedia(media: ConversationMedia): void {
  const url = URL.createObjectURL(blobOf(media));
  const link = document.createElement("a");
  link.href = url;
  link.download = media.name;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  // The download has started by then; the address is only needed to start it.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * The file at `path` while `enabled`, fetched by the app (never by an address
 * a browser tab would open without the app's sign-in) and held as a blob.
 */
function useMedia(
  source: MediaSource | null,
  path: string,
  maxBytes: number,
  enabled: boolean,
): { state: MediaState; retry: () => void } {
  const [state, setState] = useState<MediaState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const conversationId = source?.conversationId;
  const messageId = source?.messageId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly retries a failed load.
  useEffect(() => {
    if (!enabled || !conversationId || !messageId) return;
    let cancelled = false;
    let url: string | undefined;
    setState({ status: "loading" });
    void readMedia({ conversationId, messageId }, path, maxBytes).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setState({ status: result.tooLarge ? "too_large" : "error", message: result.message });
        return;
      }
      url = URL.createObjectURL(blobOf(result.media));
      setState({ status: "ready", media: result.media, url });
    });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [conversationId, messageId, path, maxBytes, enabled, attempt]);
  return { state, retry: () => setAttempt((count) => count + 1) };
}

/** Fetches a file to save it, up to the download limit, so files too large to show can still be kept. */
function useDownload(source: MediaSource | null, path: string) {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string>();
  const download = async (): Promise<void> => {
    if (!source?.ready || downloading) return;
    setDownloading(true);
    setError(undefined);
    const result = await readMedia(source, path, MEDIA_DOWNLOAD_LIMIT_BYTES);
    setDownloading(false);
    if (result.ok) saveMedia(result.media);
    else setError(result.message);
  };
  return { download, downloading, error };
}

/**
 * A Markdown image in a Wisp's reply. A workspace path is shown as the
 * image, an audio or video player, or a card for any other file; a web
 * address stays an ordinary image.
 */
export function MessageMedia({ src, alt }: { src?: string; alt?: string }) {
  const source = useContext(MediaSourceContext);
  if (!src || !isWorkspaceMediaPath(src)) return <img className="max-w-full rounded-lg" src={src} alt={alt} />;
  const kind = mediaKind(normalizeMediaPath(src));
  if (kind === "image" || kind === "audio" || kind === "video") {
    return <InlineMedia source={source} path={src} kind={kind} alt={alt} />;
  }
  return <FileCard source={source} path={src} kind={kind} />;
}

function InlineMedia({
  source,
  path,
  kind,
  alt,
}: {
  source: MediaSource | null;
  path: string;
  kind: "image" | "audio" | "video";
  alt?: string;
}) {
  const name = mediaName(normalizeMediaPath(path));
  const { state, retry } = useMedia(source, path, MEDIA_PREVIEW_LIMIT_BYTES, Boolean(source?.ready));
  const [previewing, setPreviewing] = useState(false);
  if (!source || state.status === "too_large") return <FileCard source={source} path={path} kind={kind} />;
  if (state.status === "error") return <MediaFailure name={name} message={state.message} onRetry={retry} />;
  if (state.status === "loading") {
    return (
      <span
        className="my-1.5 flex h-24 w-full max-w-[320px] items-center justify-center rounded-lg bg-black/[0.04] text-faint text-xs dark:bg-white/[0.05]"
        role="status"
      >
        {`Loading ${name}…`}
      </span>
    );
  }
  if (kind === "audio") {
    return (
      <audio
        className="my-1.5 block w-full max-w-[420px]"
        controls
        preload="metadata"
        src={state.url}
        aria-label={name}
      />
    );
  }
  if (kind === "video") {
    return (
      <video
        className="my-1.5 block max-h-[420px] max-w-full rounded-lg"
        controls
        preload="metadata"
        src={state.url}
        aria-label={name}
      />
    );
  }
  return (
    <>
      <button
        type="button"
        className="my-1.5 block max-w-full cursor-zoom-in rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        aria-label={`Open ${name}`}
        onClick={() => setPreviewing(true)}
      >
        <img className="max-h-[420px] max-w-full rounded-lg" src={state.url} alt={alt || name} />
      </button>
      <MediaPreviewDialog
        source={source}
        path={path}
        kind="image"
        open={previewing}
        onOpenChange={setPreviewing}
        loaded={state}
      />
    </>
  );
}

const KIND_LABELS: Record<MediaKind, string> = {
  image: "Image",
  audio: "Audio",
  video: "Video",
  html: "HTML page",
  markdown: "Markdown document",
  file: "File",
};

/** A file shown as a card: HTML and Markdown open a preview, anything else downloads. */
function FileCard({ source, path, kind }: { source: MediaSource | null; path: string; kind: MediaKind }) {
  const name = mediaName(normalizeMediaPath(path));
  const { download, downloading, error } = useDownload(source, path);
  const [previewing, setPreviewing] = useState(false);
  const previews = kind === "html" || kind === "markdown";
  const available = Boolean(source?.ready);
  const Icon = kind === "html" ? FileCodeIcon : kind === "markdown" ? FileTextIcon : FileIcon;
  return (
    <span className="my-1.5 flex w-full max-w-[360px] flex-col gap-1">
      <span className="flex items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-2">
        <Icon aria-hidden="true" className="size-4 flex-none text-dim" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium" title={normalizeMediaPath(path)}>
            {name}
          </span>
          <span className="text-faint text-2xs">{KIND_LABELS[kind]}</span>
        </span>
        {previews ? (
          <Button type="button" variant="outline" size="xs" disabled={!available} onClick={() => setPreviewing(true)}>
            Open
          </Button>
        ) : null}
        <Button
          type="button"
          variant={previews ? "ghost" : "outline"}
          size={previews ? "icon-xs" : "xs"}
          disabled={!available || downloading}
          aria-label={`Download ${name}`}
          onClick={() => void download()}
        >
          <DownloadIcon aria-hidden="true" />
          {previews ? null : downloading ? "Downloading…" : "Download"}
        </Button>
      </span>
      {error ? <MediaFailure name={name} message={error} onRetry={() => void download()} /> : null}
      {previews && source ? (
        <MediaPreviewDialog source={source} path={path} kind={kind} open={previewing} onOpenChange={setPreviewing} />
      ) : null}
    </span>
  );
}

function MediaFailure({ name, message, onRetry }: { name: string; message: string; onRetry: () => void }) {
  return (
    <span
      className="my-1.5 flex w-full max-w-[360px] items-center gap-2 rounded-lg border border-destructive/30 px-2.5 py-1.5 text-destructive text-xs"
      role="alert"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{`${name} could not be loaded`}</span>
        <span className="block text-dim">{message}</span>
      </span>
      <Button type="button" variant="outline" size="xs" onClick={onRetry}>
        <RotateCwIcon aria-hidden="true" />
        Retry
      </Button>
    </span>
  );
}

/**
 * A file opened at full size, with a toolbar to download it. Files above the
 * preview limit are not shown, but Download still saves them.
 */
function MediaPreviewDialog({
  source,
  path,
  kind,
  open,
  onOpenChange,
  loaded,
}: {
  source: MediaSource;
  path: string;
  kind: MediaKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A file already fetched to show it in the reply. */
  loaded?: MediaState;
}) {
  const name = mediaName(normalizeMediaPath(path));
  const fetched = useMedia(source, path, MEDIA_PREVIEW_LIMIT_BYTES, open && !loaded);
  const state = loaded ?? fetched.state;
  const full = useDownload(source, path);
  const downloading = state.status !== "ready" && full.downloading;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        mobileFullscreen
        showCloseButton
        className="grid h-[min(860px,92dvh)] max-w-[min(1100px,96vw)] grid-rows-[auto_minmax(0,1fr)] gap-3 p-3"
      >
        <div className="flex min-w-0 items-center gap-2 pr-9">
          <DialogTitle className="min-w-0 flex-1 truncate text-base font-semibold">{name}</DialogTitle>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={downloading || state.status === "loading"}
            onClick={() => (state.status === "ready" ? saveMedia(state.media) : void full.download())}
          >
            <DownloadIcon aria-hidden="true" />
            {downloading ? "Downloading…" : "Download"}
          </Button>
        </div>
        <div className="min-h-0 overflow-auto">
          {full.error ? <MediaFailure name={name} message={full.error} onRetry={() => void full.download()} /> : null}
          <PreviewBody state={state} kind={kind} name={name} onRetry={fetched.retry} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PreviewBody({
  state,
  kind,
  name,
  onRetry,
}: {
  state: MediaState;
  kind: MediaKind;
  name: string;
  onRetry: () => void;
}) {
  if (state.status === "loading") {
    return (
      <p className="p-4 text-center text-dim" role="status">
        Loading…
      </p>
    );
  }
  if (state.status === "error") return <MediaFailure name={name} message={state.message} onRetry={onRetry} />;
  if (state.status === "too_large") {
    return (
      <p className="p-4 text-center text-dim">
        {`This file is too large to show here (more than ${formatBytes(MEDIA_PREVIEW_LIMIT_BYTES)}). Download it to open it.`}
      </p>
    );
  }
  if (kind === "html") return <HtmlPreview key={state.url} html={decodeText(state.media.bytes)} title={name} />;
  if (kind === "markdown") return <MarkdownPreview bytes={state.media.bytes} />;
  if (kind === "image") {
    return <img className="mx-auto max-h-full max-w-full object-contain" src={state.url} alt={name} />;
  }
  return null;
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function MarkdownPreview({ bytes }: { bytes: Uint8Array }) {
  const text = decodeText(bytes);
  if (bytes.length > MARKDOWN_PREVIEW_LIMIT_BYTES) {
    return <pre className="p-2 font-mono text-sm whitespace-pre-wrap break-words">{text}</pre>;
  }
  // Files the document refers to are not the reply's: they are not fetched.
  return (
    <MediaSourceProvider value={null}>
      <div className="p-2 leading-[1.5] select-text">
        <MarkdownView text={text} />
      </div>
    </MediaSourceProvider>
  );
}

/**
 * An HTML file run in a sandboxed frame with an opaque origin: its scripts
 * run, but it cannot read the app's storage, make requests from scripts or
 * send forms, and its own policy keeps it from loading other workspace files.
 * The frame's page asks for the document once it has loaded and writes it.
 */
function HtmlPreview({ html, title }: { html: string; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    let sent = false;
    const receive = (event: MessageEvent): void => {
      const target = frame.current?.contentWindow;
      if (sent || !target || event.source !== target) return;
      if ((event.data as { type?: unknown } | null)?.type !== "wisp-preview-ready") return;
      // Only the first page in the frame gets the document, never one a link opened there.
      sent = true;
      target.postMessage({ type: "wisp-preview", html }, "*");
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [html]);
  return (
    <iframe
      ref={frame}
      title={title}
      src={PREVIEW_PAGE}
      sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      className={cn("block h-full min-h-[60dvh] w-full rounded-lg border border-border bg-white")}
    />
  );
}

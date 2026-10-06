export interface SseMessage {
  id?: string;
  event: string;
  data: string;
}

/**
 * Reads a server-sent event stream until it ends, calling `onMessage` for each
 * event. Comments (keep-alives) call `onActivity` only.
 */
export async function readServerSentEvents(
  body: ReadableStream<Uint8Array>,
  onMessage: (message: SseMessage) => void,
  onActivity: () => void = () => undefined,
): Promise<void> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  let fields: { id?: string; event?: string; data: string[] } = { data: [] };
  const dispatch = (): void => {
    if (fields.data.length > 0 || fields.event) {
      onMessage({
        ...(fields.id === undefined ? {} : { id: fields.id }),
        event: fields.event ?? "message",
        data: fields.data.join("\n"),
      });
    }
    fields = { data: [] };
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onActivity();
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.search(/\r?\n/);
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(buffer[newline] === "\r" ? newline + 2 : newline + 1);
        newline = buffer.search(/\r?\n/);
        if (line === "") {
          dispatch();
          continue;
        }
        if (line.startsWith(":")) continue;
        const separator = line.indexOf(":");
        const name = separator < 0 ? line : line.slice(0, separator);
        const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
        if (name === "id") fields.id = value;
        else if (name === "event") fields.event = value;
        else if (name === "data") fields.data.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Streaming SSE decoder shared by Electron, browsers and Capacitor. */
export interface ServerSentEvent {
  event: string;
  id?: string;
  data: string;
}
export class EventStreamParser {
  private buffer = "";
  private data: string[] = [];
  private event = "message";
  private id: string | undefined;
  private size = 0;
  constructor(
    private readonly emit: (event: ServerSentEvent) => void,
    private readonly maxBytes = 1024 * 1024,
  ) {}
  push(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > this.maxBytes) throw new Error("Event stream frame exceeds its limit.");
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      this.line(line);
    }
  }
  private line(line: string): void {
    if (line === "") {
      if (this.data.length) this.emit({ event: this.event, id: this.id, data: this.data.join("\n") });
      this.data = [];
      this.event = "message";
      this.id = undefined;
      this.size = 0;
      return;
    }
    if (line.startsWith(":")) return;
    this.size += line.length;
    if (this.size > this.maxBytes) throw new Error("Event stream frame exceeds its limit.");
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "data") this.data.push(value);
    else if (field === "event") this.event = value;
    else if (field === "id" && !value.includes("\0")) this.id = value;
  }
}

export async function consumeEventStream(
  response: Response,
  emit: (event: ServerSentEvent) => void,
  signal: AbortSignal,
  heartbeatTimeoutMs = 45000,
): Promise<void> {
  if (!response.body || !response.headers.get("content-type")?.startsWith("text/event-stream"))
    throw new Error("Invalid event stream response.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new EventStreamParser(emit);
  const cancel = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (!signal.aborted) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("The event stream heartbeat timed out.")), heartbeatTimeoutMs);
        }),
      ]).finally(() => {
        if (timeout) clearTimeout(timeout);
      });
      const { value, done } = chunk;
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

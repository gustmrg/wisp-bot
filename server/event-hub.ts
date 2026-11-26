import { randomUUID } from "node:crypto";

import type { RemoteEventPayloads, RemoteEventType } from "../shared/remote-protocol.js";

export interface HubEvent {
  /** `<bootId>:<sequence>`, sent as the SSE event id. */
  id: string;
  type: RemoteEventType;
  payload: unknown;
}

export interface EventSubscription {
  /** Buffered events after the client's cursor, in order. */
  replay: HubEvent[];
  /** The cursor is unknown or too old: the client must reload state instead of replaying. */
  resync: boolean;
  unsubscribe(): void;
}

const DEFAULT_CAPACITY = 5_000;

/**
 * Orders every pushed event with one sequence and keeps the latest ones in
 * memory, so a client that reconnects after a short drop replays what it
 * missed. Anything older, or from before a restart, asks the client to
 * reload state, which the backend always holds in full.
 */
export class EventHub {
  readonly bootId = randomUUID();
  private sequence = 0;
  private readonly capacity: number;
  private readonly slots: Array<HubEvent | undefined>;
  private head = 0;
  private count = 0;
  private readonly listeners = new Set<(event: HubEvent) => void>();

  constructor(capacity = DEFAULT_CAPACITY) {
    this.capacity = Math.max(0, Math.floor(capacity));
    this.slots = new Array<HubEvent | undefined>(this.capacity);
  }

  get cursor(): string {
    return `${this.bootId}:${this.sequence}`;
  }

  publish<T extends Exclude<RemoteEventType, "resync">>(type: T, payload: RemoteEventPayloads[T]): void {
    const event: HubEvent = { id: `${this.bootId}:${++this.sequence}`, type, payload };
    if (this.capacity > 0) {
      if (this.count < this.capacity) {
        this.slots[(this.head + this.count) % this.capacity] = event;
        this.count++;
      } else {
        this.slots[this.head] = event;
        this.head = (this.head + 1) % this.capacity;
      }
    }
    for (const listener of this.listeners) listener(event);
  }

  /** Subscribes after `cursor`; without one, only new events are delivered. */
  subscribe(cursor: string | undefined, listener: (event: HubEvent) => void): EventSubscription {
    this.listeners.add(listener);
    const unsubscribe = (): void => {
      this.listeners.delete(listener);
    };
    if (cursor === undefined) return { replay: [], resync: false, unsubscribe };
    const after = this.parse(cursor);
    const oldest = this.sequence - this.count + 1;
    // Replay is complete only if the next event the client needs is still buffered.
    if (after === undefined || after > this.sequence || after + 1 < oldest) {
      return { replay: [], resync: true, unsubscribe };
    }
    const replayCount = this.sequence - after;
    const startOffset = after + 1 - oldest;
    const replay = new Array<HubEvent>(replayCount);
    for (let index = 0; index < replayCount; index++) {
      replay[index] = this.slots[(this.head + startOffset + index) % this.capacity]!;
    }
    return { replay, resync: false, unsubscribe };
  }

  private parse(cursor: string): number | undefined {
    const separator = cursor.lastIndexOf(":");
    if (cursor.slice(0, separator) !== this.bootId) return undefined;
    const value = Number(cursor.slice(separator + 1));
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }
}

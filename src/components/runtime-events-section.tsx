import { useEffect, useRef, useState } from "react";

import type { RuntimeEventEntry, RuntimeEventLogView } from "../../shared/runtime-events";
import {
  SettingsCard,
  SettingsGroup,
  SettingsRow,
  SettingsRowCopy,
  SettingsRowDescription,
  SettingsRowTitle,
} from "@/components/settings/settings-primitives";
import { Button } from "@/components/ui/button";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { copyText } from "@/lib/clipboard";

/** How often an open, recording view asks for new events. */
export const RUNTIME_EVENTS_POLL_MS = 1_000;
/** The view keeps as many events as the server does. */
const MAX_EVENTS = 1_000;

interface RuntimeEventsState {
  recording: boolean;
  events: RuntimeEventEntry[];
  dropped: boolean;
}

/**
 * A debugging view of the raw events a conversation's runtime emits (Pi's
 * agent events or Claude Code's SDK messages), recorded only while its switch
 * is on. What was recorded stays, in a file where the Wisp runs, until it is
 * cleared, so it can be copied or saved to the workspace after recording
 * stops. The conversation itself works the same either way.
 */
export function RuntimeEventsSection({ conversationId, active = true }: { conversationId: string; active?: boolean }) {
  const [state, setState] = useState<RuntimeEventsState | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState("");
  const lastSequence = useRef<number | undefined>(undefined);
  const shown = useRef(conversationId);
  shown.current = conversationId;

  const recording = state?.recording ?? false;

  /** Reads the events after `after`, or all of them, into the view; the effects call the latest one. */
  const read = useRef<(id: string, after: number | undefined) => Promise<void>>(async () => undefined);
  read.current = async (id, after) => {
    let result: Awaited<ReturnType<typeof window.wisp.getRuntimeEvents>> | null;
    try {
      result = await window.wisp.getRuntimeEvents({ conversationId: id, ...(after !== undefined ? { after } : {}) });
    } catch {
      result = null;
    }
    // A read for a conversation the view no longer shows changes nothing.
    if (id !== shown.current) return;
    if (!result?.ok) {
      setError(result ? result.error.message : "Could not load the runtime events.");
      return;
    }
    setError("");
    const view = result.value;
    const last = view.events.at(-1);
    if (last) lastSequence.current = last.sequence;
    setState((current) => mergeEvents(after === undefined ? null : current, view));
  };

  // Opening the tab reads whether this conversation records, and what it has.
  useEffect(() => {
    if (!active) return;
    lastSequence.current = undefined;
    setSaved("");
    void read.current(conversationId, undefined);
  }, [conversationId, active]);

  // While it records, new events are read every second.
  useEffect(() => {
    if (!active || !recording) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      await read.current(conversationId, lastSequence.current);
      if (!cancelled) timer = setTimeout(() => void poll(), RUNTIME_EVENTS_POLL_MS);
    };
    timer = setTimeout(() => void poll(), RUNTIME_EVENTS_POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [conversationId, active, recording]);

  /** Runs a change and shows the log it returns in place of the one shown. */
  async function change(run: () => ReturnType<typeof window.wisp.clearRuntimeEvents>, failure: string) {
    setBusy(true);
    try {
      const result = await run();
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      lastSequence.current = result.value.events.at(-1)?.sequence;
      setError("");
      setState(mergeEvents(null, result.value));
    } catch {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  const setRecording = (next: boolean) =>
    change(
      () => window.wisp.setRuntimeEventRecording({ conversationId, recording: next }),
      "Could not change the runtime events recording.",
    );

  async function clear() {
    setSaved("");
    await change(() => window.wisp.clearRuntimeEvents({ conversationId }), "Could not clear the runtime events.");
  }

  async function saveToWorkspace() {
    setBusy(true);
    try {
      const result = await window.wisp.saveRuntimeEventsToWorkspace({ conversationId });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setError("");
      setSaved(result.value.path);
    } catch {
      setError("Could not save the runtime events to the workspace.");
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!state) return;
    if (!(await copyText(JSON.stringify(state.events, null, 2)))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1_500);
  }

  const events = state?.events ?? [];
  return (
    <SettingsGroup label="Runtime events">
      <SettingsCard>
        <SettingsRow className="min-h-0 p-[11px]">
          <SettingsRowCopy>
            <SettingsRowTitle>Record runtime events</SettingsRowTitle>
            <SettingsRowDescription>
              For debugging: saves the raw events of this conversation's runtime to a file where its Wisps run, until
              you clear them
            </SettingsRowDescription>
          </SettingsRowCopy>
          <ToggleSwitch
            checked={recording}
            label="Record runtime events"
            disabled={busy || !state}
            onChange={() => void setRecording(!recording)}
          />
        </SettingsRow>
      </SettingsCard>
      {error ? (
        <p role="alert" className="mx-0.5 mt-2 mb-0 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {recording || events.length ? (
        <div className="mt-2 flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <p role="status" className="m-0 mr-auto text-xs text-dim">
              {events.length === 1 ? "1 event" : `${events.length} events`}
              {state?.dropped ? " · older events were dropped" : ""}
            </p>
            <Button type="button" size="sm" variant="outline" disabled={!events.length} onClick={() => void copy()}>
              {copied ? "Copied" : "Copy events"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || !events.length}
              onClick={() => void saveToWorkspace()}
            >
              Save to workspace
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || !events.length}
              onClick={() => void clear()}
            >
              Clear
            </Button>
          </div>
          {saved ? (
            <p role="status" className="m-0 text-xs text-dim">
              Saved to <span className="font-mono">{saved}</span>. Ask a Wisp here to read it.
            </p>
          ) : null}
          {events.length ? (
            <ol
              aria-label="Runtime events"
              className="m-0 max-h-[420px] list-none overflow-y-auto rounded-[10px] bg-popover p-1"
            >
              {events.map((event) => (
                <RuntimeEventRow key={event.sequence} event={event} />
              ))}
            </ol>
          ) : (
            <p className="m-0 rounded-[10px] bg-popover p-3 text-xs text-dim">
              Send a message to see the events of the reply here.
            </p>
          )}
        </div>
      ) : null}
    </SettingsGroup>
  );
}

/** The view after a read: `current` with the new events added, or the read alone when `current` is null. */
function mergeEvents(current: RuntimeEventsState | null, view: RuntimeEventLogView): RuntimeEventsState {
  const events = current ? [...current.events, ...view.events] : view.events;
  const overflow = events.length - MAX_EVENTS;
  return {
    recording: view.recording,
    events: overflow > 0 ? events.slice(overflow) : events,
    dropped: view.dropped || overflow > 0,
  };
}

function RuntimeEventRow({ event }: { event: RuntimeEventEntry }) {
  return (
    <li>
      <details className="group rounded-md px-2 py-1 open:bg-muted/40">
        <summary className="flex cursor-pointer items-baseline gap-2 font-mono text-xs">
          <time dateTime={event.receivedAt} className="flex-none text-dim">
            {clockTime(event.receivedAt)}
          </time>
          <span className="min-w-0 truncate">{event.type}</span>
          <span className="ml-auto flex-none text-dim">{event.runtime}</span>
        </summary>
        <pre className="mt-1 mb-1 max-h-[320px] overflow-auto rounded-md bg-background p-2 text-[11px] leading-snug whitespace-pre-wrap break-all">
          {JSON.stringify(event.payload, null, 2)}
        </pre>
      </details>
    </li>
  );
}

/** The time an event arrived, to the millisecond, since many arrive within one second. */
function clockTime(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number, length = 2) => String(value).padStart(length, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

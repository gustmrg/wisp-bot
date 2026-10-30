import type { VoiceAudioMimeType } from "../../shared/voice";

/** What the composer says about a kept recording, and what it offers to do with it. */
export interface KeptRecordingNotice {
  message: string;
  /** The provider key is missing or was rejected, so the fix is in Settings. */
  needsSetup: boolean;
  /** The action that transcribes it; "Try again" when not set. */
  retryLabel?: string;
}

/** A recording not transcribed yet, because that failed, was never finished, or it was cut short. */
export interface KeptRecording {
  blob: Blob;
  mimeType: VoiceAudioMimeType;
  /** It ended before the person asked, so its text waits for review instead of being sent right away. */
  cutShort: boolean;
  notice: KeptRecordingNotice;
}

type Listener = () => void;

// Kept outside React so a recording outlives the composer: the app remounts after a
// reconnect that missed events, and the composer remounts when another conversation is opened.
const recordings = new Map<string, KeptRecording>();
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function subscribeToKeptRecordings(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function readKeptRecording(key: string): KeptRecording | undefined {
  return recordings.get(key);
}

export function saveKeptRecording(key: string, recording: KeptRecording): void {
  recordings.set(key, recording);
  notify();
}

export function dropKeptRecording(key: string): void {
  if (recordings.delete(key)) notify();
}

export function clearKeptRecordings(): void {
  recordings.clear();
  notify();
}

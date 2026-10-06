export type NotificationSoundKind = "finished" | "needs-input" | "error";

/**
 * Structural subset of AudioContext the player relies on, so tests can inject
 * a lightweight fake instead of a full Web Audio implementation.
 */
export interface AudioContextLike {
  currentTime: number;
  state: AudioContextState;
  resume(): Promise<void>;
  destination: AudioNode;
  createOscillator(): OscillatorNode;
  createGain(): GainNode;
}

export type CreateAudioContext = () => AudioContextLike | null;

interface ChimeNote {
  frequency: number;
  /** Offset in seconds from the start of the chime. */
  startAt: number;
  /** Seconds from note onset to the end of its decay. */
  duration: number;
}

// Sine two-note chimes: "finished" rises (E5 → A5), "needs-input" falls (A5 → E5)
// so the two are distinguishable by direction as well as rhythm.
const CHIMES: Record<NotificationSoundKind, ReadonlyArray<ChimeNote>> = {
  finished: [
    { frequency: 659.25, startAt: 0, duration: 0.16 },
    { frequency: 880, startAt: 0.12, duration: 0.34 },
  ],
  error: [
    { frequency: 440, startAt: 0, duration: 0.16 },
    { frequency: 329.63, startAt: 0.22, duration: 0.34 },
  ],
  "needs-input": [
    { frequency: 880, startAt: 0, duration: 0.16 },
    { frequency: 659.25, startAt: 0.14, duration: 0.36 },
  ],
};

const NOTE_GAIN = 0.14;
const ATTACK_SECONDS = 0.012;
const RELEASE_TAIL_SECONDS = 0.05;
const SILENCE = 0.0001;

export interface NotificationSoundPlayer {
  play(kind: NotificationSoundKind, volume?: number): void;
}

export function createNotificationSoundPlayer(
  createAudioContext: CreateAudioContext = createDefaultAudioContext,
): NotificationSoundPlayer {
  let context: AudioContextLike | null | undefined;

  function acquireContext(): AudioContextLike | null {
    if (context === undefined) context = createAudioContext();
    if (context?.state === "suspended") void context.resume().catch(() => undefined);
    return context;
  }

  return {
    play(kind: NotificationSoundKind, volume = 100): void {
      const level = Number.isFinite(volume) ? Math.min(100, Math.max(0, volume)) / 100 : 1;
      if (level === 0) return;
      const audio = acquireContext();
      if (!audio) return;
      const start = audio.currentTime;
      for (const note of CHIMES[kind]) scheduleNote(audio, note, start + note.startAt, level);
    },
  };
}

function scheduleNote(audio: AudioContextLike, note: ChimeNote, startTime: number, level: number): void {
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();
  oscillator.type = "sine";
  oscillator.frequency.value = note.frequency;
  gain.gain.setValueAtTime(SILENCE, startTime);
  gain.gain.linearRampToValueAtTime(Math.max(SILENCE, NOTE_GAIN * level), startTime + ATTACK_SECONDS);
  gain.gain.exponentialRampToValueAtTime(SILENCE, startTime + note.duration);
  oscillator.connect(gain);
  gain.connect(audio.destination);
  oscillator.start(startTime);
  oscillator.stop(startTime + note.duration + RELEASE_TAIL_SECONDS);
}

function createDefaultAudioContext(): AudioContextLike | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext;
  return Ctor ? new Ctor() : null;
}

const defaultPlayer = createNotificationSoundPlayer();

export function playNotificationSound(kind: NotificationSoundKind, volume = 100): void {
  defaultPlayer.play(kind, volume);
}

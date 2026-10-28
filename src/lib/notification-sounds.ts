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
  /** Defaults to the sound's wave. */
  wave?: OscillatorType;
  /** Loudness relative to the sound's other notes; defaults to 1. */
  level?: number;
}

export type NotificationSoundId = "chime" | "marimba" | "bell" | "glass" | "pop" | "soft";

/**
 * A sound the person can pick for an event. Every sound is synthesized here,
 * so the app ships no audio files and needs no media permission in its
 * content security policy. Each sound keeps the events apart the way the
 * chime does: completion rises, approval falls, an error falls lower.
 */
export interface NotificationSound {
  id: NotificationSoundId;
  label: string;
  wave: OscillatorType;
  notes: Record<NotificationSoundKind, ReadonlyArray<ChimeNote>>;
}

/** A struck bell: the fundamental and its inharmonic overtone, quieter and shorter. */
function strike(frequency: number, startAt: number, duration: number): ChimeNote[] {
  return [
    { frequency, startAt, duration },
    { frequency: frequency * 2.76, startAt, duration: duration * 0.6, level: 0.3 },
  ];
}

export const NOTIFICATION_SOUNDS: ReadonlyArray<NotificationSound> = [
  {
    id: "chime",
    label: "Chime",
    wave: "sine",
    // Sine two-note chimes: "finished" rises (E5 → A5), "needs-input" falls (A5 → E5)
    // so the two are distinguishable by direction as well as rhythm.
    notes: {
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
    },
  },
  {
    id: "marimba",
    label: "Marimba",
    wave: "triangle",
    notes: {
      finished: [
        { frequency: 523.25, startAt: 0, duration: 0.12 },
        { frequency: 783.99, startAt: 0.1, duration: 0.24 },
      ],
      error: [
        { frequency: 392, startAt: 0, duration: 0.12 },
        { frequency: 293.66, startAt: 0.18, duration: 0.26 },
      ],
      "needs-input": [
        { frequency: 783.99, startAt: 0, duration: 0.12 },
        { frequency: 523.25, startAt: 0.1, duration: 0.26 },
      ],
    },
  },
  {
    id: "bell",
    label: "Bell",
    wave: "sine",
    notes: {
      finished: [...strike(659.25, 0, 0.5), ...strike(987.77, 0.18, 0.9)],
      error: [...strike(523.25, 0, 0.5), ...strike(392, 0.26, 0.9)],
      "needs-input": [...strike(987.77, 0, 0.5), ...strike(659.25, 0.2, 0.9)],
    },
  },
  {
    id: "glass",
    label: "Glass",
    wave: "sine",
    notes: {
      finished: [
        { frequency: 1318.51, startAt: 0, duration: 0.4 },
        { frequency: 1975.53, startAt: 0.08, duration: 0.7, level: 0.7 },
      ],
      error: [
        { frequency: 987.77, startAt: 0, duration: 0.4 },
        { frequency: 739.99, startAt: 0.2, duration: 0.7, level: 0.8 },
      ],
      "needs-input": [
        { frequency: 1975.53, startAt: 0, duration: 0.4, level: 0.7 },
        { frequency: 1318.51, startAt: 0.12, duration: 0.7 },
      ],
    },
  },
  {
    id: "pop",
    label: "Pop",
    wave: "sine",
    notes: {
      finished: [
        { frequency: 587.33, startAt: 0, duration: 0.07 },
        { frequency: 880, startAt: 0.08, duration: 0.09 },
      ],
      error: [
        { frequency: 329.63, startAt: 0, duration: 0.08 },
        { frequency: 246.94, startAt: 0.11, duration: 0.11 },
      ],
      "needs-input": [
        { frequency: 880, startAt: 0, duration: 0.07 },
        { frequency: 587.33, startAt: 0.09, duration: 0.09 },
      ],
    },
  },
  {
    id: "soft",
    label: "Soft",
    wave: "sine",
    notes: {
      finished: [
        { frequency: 392, startAt: 0, duration: 0.3, level: 0.8 },
        { frequency: 523.25, startAt: 0.18, duration: 0.45, level: 0.8 },
      ],
      error: [
        { frequency: 293.66, startAt: 0, duration: 0.3, level: 0.8 },
        { frequency: 246.94, startAt: 0.26, duration: 0.45, level: 0.8 },
      ],
      "needs-input": [
        { frequency: 523.25, startAt: 0, duration: 0.3, level: 0.8 },
        { frequency: 392, startAt: 0.2, duration: 0.45, level: 0.8 },
      ],
    },
  },
];

export const DEFAULT_NOTIFICATION_SOUND: NotificationSoundId = "chime";

export function isNotificationSoundId(value: unknown): value is NotificationSoundId {
  return NOTIFICATION_SOUNDS.some(({ id }) => id === value);
}

const NOTE_GAIN = 0.14;
const ATTACK_SECONDS = 0.012;
const RELEASE_TAIL_SECONDS = 0.05;
const SILENCE = 0.0001;

export interface NotificationSoundPlayer {
  /** Plays a sound, cutting off whatever the player is still playing so two never overlap. */
  play(kind: NotificationSoundKind, volume?: number, sound?: NotificationSoundId): void;
}

interface Voice {
  oscillator: OscillatorNode;
  gain: GainNode;
}

export function createNotificationSoundPlayer(
  createAudioContext: CreateAudioContext = createDefaultAudioContext,
): NotificationSoundPlayer {
  let context: AudioContextLike | null | undefined;
  const playing = new Set<Voice>();

  function acquireContext(): AudioContextLike | null {
    if (context === undefined) context = createAudioContext();
    if (context?.state === "suspended") void context.resume().catch(() => undefined);
    return context;
  }

  function silence(): void {
    for (const voice of playing) {
      try {
        voice.oscillator.stop();
      } catch {
        // Already stopped.
      }
      voice.gain.disconnect();
    }
    playing.clear();
  }

  return {
    play(kind: NotificationSoundKind, volume = 100, sound = DEFAULT_NOTIFICATION_SOUND): void {
      const level = Number.isFinite(volume) ? Math.min(100, Math.max(0, volume)) / 100 : 1;
      if (level === 0) return;
      const audio = acquireContext();
      if (!audio) return;
      silence();
      const chosen = NOTIFICATION_SOUNDS.find(({ id }) => id === sound) ?? NOTIFICATION_SOUNDS[0]!;
      const start = audio.currentTime;
      for (const note of chosen.notes[kind]) {
        const voice = scheduleNote(audio, note, chosen.wave, start + note.startAt, level);
        playing.add(voice);
        voice.oscillator.onended = () => playing.delete(voice);
      }
    },
  };
}

function scheduleNote(
  audio: AudioContextLike,
  note: ChimeNote,
  wave: OscillatorType,
  startTime: number,
  level: number,
): Voice {
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();
  oscillator.type = note.wave ?? wave;
  oscillator.frequency.value = note.frequency;
  gain.gain.setValueAtTime(SILENCE, startTime);
  gain.gain.linearRampToValueAtTime(
    Math.max(SILENCE, NOTE_GAIN * (note.level ?? 1) * level),
    startTime + ATTACK_SECONDS,
  );
  gain.gain.exponentialRampToValueAtTime(SILENCE, startTime + note.duration);
  oscillator.connect(gain);
  gain.connect(audio.destination);
  oscillator.start(startTime);
  oscillator.stop(startTime + note.duration + RELEASE_TAIL_SECONDS);
  return { oscillator, gain };
}

function createDefaultAudioContext(): AudioContextLike | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext;
  return Ctor ? new Ctor() : null;
}

const defaultPlayer = createNotificationSoundPlayer();

export function playNotificationSound(
  kind: NotificationSoundKind,
  volume = 100,
  sound: NotificationSoundId = DEFAULT_NOTIFICATION_SOUND,
): void {
  defaultPlayer.play(kind, volume, sound);
}

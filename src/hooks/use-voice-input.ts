import { useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  MAX_VOICE_RECORDING_SECONDS,
  VOICE_AUDIO_MIME_TYPES,
  type VoiceAudioMimeType,
  type VoiceLanguage,
  type VoiceModelChoice,
  type VoiceProviderId,
} from "../../shared/voice";
import { ActiveConnectionContext } from "@/features/connections/active-connection";
import { useScreenWakeLock } from "@/hooks/use-screen-wake-lock";
import {
  dropKeptRecording,
  readKeptRecording,
  saveKeptRecording,
  subscribeToKeptRecordings,
  type KeptRecordingNotice,
} from "@/lib/kept-voice-recordings";
import { subscribeToProviderCredentials } from "@/lib/voice-credentials";

export type VoicePhase = "idle" | "starting" | "recording" | "transcribing";

export interface VoiceInputError {
  message: string;
  /** The provider key is missing or was rejected, so the fix is in Settings. */
  needsSetup: boolean;
  /** The recording is kept, so `retry` sends it again without recording anew (SWE-253). */
  retryable?: boolean;
  /** The action that transcribes it; "Try again" when not set. */
  retryLabel?: string;
}

export interface VoiceInputOptions {
  /** The conversation a recording is for: one cut short stays with it until it comes back on screen. */
  conversationId: string;
  deviceId: string;
  providerId: VoiceProviderId;
  modelId: string;
  /** Tried in order when the provider cannot transcribe the recording. */
  fallbacks?: ReadonlyArray<VoiceModelChoice>;
  language: VoiceLanguage;
  /** `review` asks to leave the text for the person to check, even when it would be sent right away. */
  onTranscript: (text: string, options: { review: boolean }) => void;
}

/** Recent microphone levels kept for the meter, newest last; enough to fill a wide window. */
export const VOICE_LEVEL_HISTORY = 400;
const SAMPLE_INTERVAL_MS = 60;
const RECORDER_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
const NO_LEVELS: ReadonlyArray<number> = [];
const CUT_SHORT_NOTICE: KeptRecordingNotice = {
  message: "The recording stopped early, but what you said is kept.",
  needsSetup: false,
  retryLabel: "Transcribe",
};
const NOT_TRANSCRIBED_NOTICE: KeptRecordingNotice = {
  message: "This recording was not transcribed.",
  needsSetup: false,
};

interface Recording {
  stream: MediaStream;
  recorder: MediaRecorder;
  chunks: Blob[];
  audioContext?: AudioContext;
  timer: ReturnType<typeof setInterval>;
  cancelled: boolean;
  /** Stopped by the person or the time limit; any other stop cut the recording short. */
  finished: boolean;
}

function recorderType(): string | undefined {
  return typeof MediaRecorder.isTypeSupported === "function"
    ? RECORDER_TYPES.find((type) => MediaRecorder.isTypeSupported(type))
    : undefined;
}

function uploadType(recorderMimeType: string): VoiceAudioMimeType {
  const container = recorderMimeType.split(";")[0]?.trim();
  return VOICE_AUDIO_MIME_TYPES.find((type) => type === container) ?? "audio/webm";
}

function microphoneError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Microphone access was denied.";
  if (name === "NotFoundError") return "No microphone was found.";
  if (name === "NotReadableError") return "The microphone is in use by another app.";
  return "Could not start the microphone.";
}

async function openMicrophone(deviceId: string): Promise<MediaStream> {
  if (deviceId === "default") return navigator.mediaDevices.getUserMedia({ audio: true });
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } });
  } catch (error) {
    // The chosen microphone was unplugged; the system default still works.
    if (error instanceof DOMException && (error.name === "OverconstrainedError" || error.name === "NotFoundError")) {
      return navigator.mediaDevices.getUserMedia({ audio: true });
    }
    throw error;
  }
}

/** Root-mean-square loudness of the latest audio frame, scaled to 0–1 for display. */
function sampleLevel(analyser: AnalyserNode, buffer: Uint8Array<ArrayBuffer>): number {
  analyser.getByteTimeDomainData(buffer);
  let sum = 0;
  for (const value of buffer) {
    const centered = (value - 128) / 128;
    sum += centered * centered;
  }
  return Math.min(1, Math.sqrt(sum / buffer.length) * 4);
}

/**
 * Records from the microphone and transcribes the recording in the backend.
 * Only one recording runs at a time. Only `cancel` discards one: a recording
 * the system ended, or that the composer's unmounting cut short, is kept until
 * the person decides, and so is one whose transcription did not finish.
 */
export function useVoiceInput(options: VoiceInputOptions) {
  const [microphoneStatus, setMicrophoneStatus] = useState<"checking" | "available" | "missing" | "unsupported">(
    "checking",
  );
  const [credentialStatus, setCredentialStatus] = useState<"checking" | "configured" | "missing">("checking");
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [levels, setLevels] = useState<ReadonlyArray<number>>(NO_LEVELS);
  const [ownError, setError] = useState<VoiceInputError | null>(null);
  const connection = useContext(ActiveConnectionContext);
  // Each connection is its own environment, so a recording is only offered back on the one it was made for.
  const keptKey = `${connection?.activeId ?? ""}:${options.conversationId}`;
  const latest = useRef({ ...options, keptKey });
  latest.current = { ...options, keptKey };
  const recording = useRef<Recording | null>(null);
  const phaseRef = useRef<VoicePhase>("idle");
  // Bumped on cancel and unmount so a transcription that is still running is ignored.
  const generation = useRef(0);
  const kept = useSyncExternalStore(subscribeToKeptRecordings, () => readKeptRecording(keptKey));
  useScreenWakeLock(phase === "recording");

  useEffect(() => {
    const devices = navigator.mediaDevices;
    if (!devices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setMicrophoneStatus("unsupported");
      return;
    }
    // Older browsers may support recording without device enumeration.
    if (!devices.enumerateDevices) {
      setMicrophoneStatus("available");
      return;
    }
    let active = true;
    let request = 0;
    async function refresh() {
      const current = ++request;
      try {
        const list = await devices.enumerateDevices();
        if (active && current === request) {
          setMicrophoneStatus(list.some((device) => device.kind === "audioinput") ? "available" : "missing");
        }
      } catch {
        // An enumeration failure does not prove that recording is unavailable.
        if (active && current === request) setMicrophoneStatus("available");
      }
    }
    void refresh();
    devices.addEventListener("devicechange", refresh);
    return () => {
      active = false;
      devices.removeEventListener("devicechange", refresh);
    };
  }, []);

  const { providerId } = options;
  useEffect(() => {
    let active = true;
    let request = 0;
    setCredentialStatus("checking");
    async function refresh() {
      const current = ++request;
      try {
        const result = await window.wisp.getVoiceSettings();
        if (!active || current !== request) return;
        // A failed lookup does not prove the key is missing; transcription reports that on its own.
        const provider = result.ok ? result.value.providers.find(({ id }) => id === providerId) : undefined;
        setCredentialStatus(provider && !provider.credentialConfigured ? "missing" : "configured");
      } catch {
        if (active && current === request) setCredentialStatus("configured");
      }
    }
    void refresh();
    const unsubscribe = subscribeToProviderCredentials(() => void refresh());
    return () => {
      active = false;
      unsubscribe();
    };
  }, [providerId]);

  const changePhase = useCallback((next: VoicePhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const release = useCallback((current: Recording) => {
    clearInterval(current.timer);
    for (const track of current.stream.getTracks()) track.stop();
    void current.audioContext?.close().catch(() => undefined);
    if (recording.current === current) recording.current = null;
  }, []);

  const transcribe = useCallback(
    async (blob: Blob, mimeType: VoiceAudioMimeType, cutShort: boolean) => {
      const attempt = generation.current;
      const { providerId, modelId, fallbacks, language, keptKey: key } = latest.current;
      const keep = (notice: KeptRecordingNotice) => saveKeptRecording(key, { blob, mimeType, cutShort, notice });
      // Kept while it is sent too, so a remount before the answer does not lose it.
      keep(NOT_TRANSCRIBED_NOTICE);
      changePhase("transcribing");
      try {
        const audio = new Uint8Array(await blob.arrayBuffer());
        const result = await window.wisp.transcribeAudio({
          providerId,
          modelId,
          ...(fallbacks?.length ? { fallbacks: [...fallbacks] } : {}),
          language,
          mimeType,
          audio,
        });
        if (attempt !== generation.current) return;
        if (!result.ok) {
          const needsSetup = result.error.code === "configuration_required";
          // A recording the provider could not read fails the same way again; one it never got to can be sent again.
          if (result.error.retryable || needsSetup) {
            keep({ message: result.error.message, needsSetup });
          } else {
            dropKeptRecording(key);
            setError({ message: result.error.message, needsSetup });
          }
        } else if (!result.value.text) {
          dropKeptRecording(key);
          setError({ message: "No speech was detected.", needsSetup: false });
        } else {
          dropKeptRecording(key);
          latest.current.onTranscript(result.value.text, { review: cutShort });
        }
      } catch {
        if (attempt === generation.current) keep({ message: "Could not transcribe the recording.", needsSetup: false });
      } finally {
        if (attempt === generation.current) changePhase("idle");
      }
    },
    [changePhase],
  );

  const start = useCallback(async () => {
    if (phaseRef.current !== "idle" || microphoneStatus !== "available" || credentialStatus !== "configured") return;
    setError(null);
    dropKeptRecording(latest.current.keptKey);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError({ message: "Voice input is not supported on this device.", needsSetup: false });
      return;
    }
    changePhase("starting");
    const attempt = generation.current;
    let stream: MediaStream;
    try {
      stream = await openMicrophone(latest.current.deviceId);
    } catch (cause) {
      if (attempt === generation.current) {
        if (cause instanceof DOMException && cause.name === "NotFoundError") setMicrophoneStatus("missing");
        setError({ message: microphoneError(cause), needsSetup: false });
        changePhase("idle");
      }
      return;
    }
    if (attempt !== generation.current) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }

    const type = recorderType();
    const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const chunks: Blob[] = [];
    let audioContext: AudioContext | undefined;
    let analyser: AnalyserNode | undefined;
    if (typeof AudioContext !== "undefined") {
      audioContext = new AudioContext();
      // A context created outside a user gesture (such as from the shortcut) can start suspended.
      void audioContext.resume().catch(() => undefined);
      analyser = audioContext.createAnalyser();
      // About 43 ms of audio per sample, so short sounds between samples still register.
      analyser.fftSize = 2048;
      audioContext.createMediaStreamSource(stream).connect(analyser);
    }
    const samples = new Uint8Array(analyser?.fftSize ?? 0);
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const seconds = Math.floor((Date.now() - startedAt) / 1000);
      setElapsed(seconds);
      if (analyser) {
        const level = sampleLevel(analyser, samples);
        setLevels((current) => [...current.slice(-(VOICE_LEVEL_HISTORY - 1)), level]);
      }
      if (seconds >= MAX_VOICE_RECORDING_SECONDS && recorder.state === "recording") {
        current.finished = true;
        recorder.stop();
      }
    }, SAMPLE_INTERVAL_MS);
    const current: Recording = {
      stream,
      recorder,
      chunks,
      timer,
      cancelled: false,
      finished: false,
      ...(audioContext ? { audioContext } : {}),
    };
    recording.current = current;
    const { keptKey: key } = latest.current;
    // The system took the microphone, as when the phone locks: what follows would be silence.
    for (const track of stream.getTracks()) {
      track.addEventListener(
        "mute",
        () => {
          if (recorder.state === "recording") recorder.stop();
        },
        { once: true },
      );
    }

    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });
    recorder.addEventListener("stop", () => {
      release(current);
      if (current.cancelled) return;
      const mimeType = uploadType(recorder.mimeType || type || "audio/webm");
      const blob = new Blob(chunks, { type: mimeType });
      if (blob.size === 0) {
        setError({ message: "Nothing was recorded.", needsSetup: false });
        changePhase("idle");
        return;
      }
      if (current.finished) {
        void transcribe(blob, mimeType, false);
        return;
      }
      saveKeptRecording(key, { blob, mimeType, cutShort: true, notice: CUT_SHORT_NOTICE });
      changePhase("idle");
    });

    setElapsed(0);
    setLevels(NO_LEVELS);
    recorder.start();
    changePhase("recording");
  }, [changePhase, release, transcribe, microphoneStatus, credentialStatus]);

  /** Ends the recording and transcribes it. */
  const stop = useCallback(() => {
    const current = recording.current;
    if (current?.recorder.state === "recording") {
      current.finished = true;
      current.recorder.stop();
    }
  }, []);

  /** Discards the recording, or the result of a transcription still in progress. */
  const cancel = useCallback(() => {
    generation.current += 1;
    dropKeptRecording(latest.current.keptKey);
    const current = recording.current;
    if (current) {
      current.cancelled = true;
      if (current.recorder.state === "recording") current.recorder.stop();
      else release(current);
    }
    if (phaseRef.current !== "idle") changePhase("idle");
  }, [changePhase, release]);

  const toggle = useCallback(() => {
    if (phaseRef.current === "idle") void start();
    else if (phaseRef.current === "recording") stop();
  }, [start, stop]);

  const clearError = useCallback(() => setError(null), []);

  /** Transcribes the kept recording, with the providers as they are set now. */
  const retry = useCallback(() => {
    const saved = readKeptRecording(latest.current.keptKey);
    if (!saved || phaseRef.current !== "idle") return;
    setError(null);
    void transcribe(saved.blob, saved.mimeType, saved.cutShort);
  }, [transcribe]);

  /** Lets go of the kept recording. */
  const discard = useCallback(() => {
    dropKeptRecording(latest.current.keptKey);
    setError(null);
  }, []);

  useEffect(
    () => () => {
      generation.current += 1;
      const current = recording.current;
      if (!current) return;
      // Stopping fires its event later, which keeps what was recorded for the next composer to offer.
      if (current.recorder.state === "recording") current.recorder.stop();
      release(current);
    },
    [release],
  );

  const unavailableReason =
    microphoneStatus === "checking"
      ? "Checking for a microphone…"
      : microphoneStatus === "missing"
        ? "No microphone was found. Connect a microphone to use voice input."
        : microphoneStatus === "unsupported"
          ? "Voice input is not supported on this device."
          : credentialStatus === "checking"
            ? "Checking voice input settings…"
            : credentialStatus === "missing"
              ? "Add a speech-to-text API key in Settings to use voice input."
              : null;

  // A kept recording speaks only while nothing else is going on, as when its own retry is on its way.
  const error: VoiceInputError | null =
    ownError ?? (phase === "idle" && kept ? { ...kept.notice, retryable: true } : null);

  return { phase, elapsed, levels, error, unavailableReason, start, stop, cancel, toggle, clearError, retry, discard };
}

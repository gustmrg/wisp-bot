import { useCallback, useEffect, useRef, useState } from "react";

import {
  MAX_VOICE_RECORDING_SECONDS,
  VOICE_AUDIO_MIME_TYPES,
  type VoiceAudioMimeType,
  type VoiceLanguage,
  type VoiceProviderId,
} from "../../shared/voice";

export type VoicePhase = "idle" | "starting" | "recording" | "transcribing";

export interface VoiceInputError {
  message: string;
  /** The provider key is missing or was rejected, so the fix is in Settings. */
  needsSetup: boolean;
}

export interface VoiceInputOptions {
  deviceId: string;
  providerId: VoiceProviderId;
  modelId: string;
  language: VoiceLanguage;
  onTranscript: (text: string) => void;
}

/** Recent microphone levels kept for the meter, newest last; enough to fill a wide window. */
export const VOICE_LEVEL_HISTORY = 400;
const SAMPLE_INTERVAL_MS = 60;
const RECORDER_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
const NO_LEVELS: ReadonlyArray<number> = [];

interface Recording {
  stream: MediaStream;
  recorder: MediaRecorder;
  chunks: Blob[];
  audioContext?: AudioContext;
  timer: ReturnType<typeof setInterval>;
  cancelled: boolean;
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
 * Only one recording runs at a time; unmounting discards it.
 */
export function useVoiceInput(options: VoiceInputOptions) {
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [levels, setLevels] = useState<ReadonlyArray<number>>(NO_LEVELS);
  const [error, setError] = useState<VoiceInputError | null>(null);
  const latest = useRef(options);
  latest.current = options;
  const recording = useRef<Recording | null>(null);
  const phaseRef = useRef<VoicePhase>("idle");
  // Bumped on cancel and unmount so a transcription that is still running is ignored.
  const generation = useRef(0);

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
    async (blob: Blob, mimeType: VoiceAudioMimeType) => {
      const attempt = generation.current;
      changePhase("transcribing");
      const { providerId, modelId, language } = latest.current;
      try {
        const audio = new Uint8Array(await blob.arrayBuffer());
        const result = await window.wisp.transcribeAudio({ providerId, modelId, language, mimeType, audio });
        if (attempt !== generation.current) return;
        if (!result.ok) {
          setError({ message: result.error.message, needsSetup: result.error.code === "configuration_required" });
        } else if (!result.value.text) {
          setError({ message: "No speech was detected.", needsSetup: false });
        } else {
          latest.current.onTranscript(result.value.text);
        }
      } catch {
        if (attempt === generation.current)
          setError({ message: "Could not transcribe the recording.", needsSetup: false });
      } finally {
        if (attempt === generation.current) changePhase("idle");
      }
    },
    [changePhase],
  );

  const start = useCallback(async () => {
    if (phaseRef.current !== "idle") return;
    setError(null);
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
      if (seconds >= MAX_VOICE_RECORDING_SECONDS && recorder.state === "recording") recorder.stop();
    }, SAMPLE_INTERVAL_MS);
    const current: Recording = {
      stream,
      recorder,
      chunks,
      timer,
      cancelled: false,
      ...(audioContext ? { audioContext } : {}),
    };
    recording.current = current;

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
      void transcribe(blob, mimeType);
    });

    setElapsed(0);
    setLevels(NO_LEVELS);
    recorder.start();
    changePhase("recording");
  }, [changePhase, release, transcribe]);

  /** Ends the recording and transcribes it. */
  const stop = useCallback(() => {
    const current = recording.current;
    if (current?.recorder.state === "recording") current.recorder.stop();
  }, []);

  /** Discards the recording, or the result of a transcription still in progress. */
  const cancel = useCallback(() => {
    generation.current += 1;
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

  useEffect(
    () => () => {
      generation.current += 1;
      const current = recording.current;
      if (!current) return;
      current.cancelled = true;
      if (current.recorder.state === "recording") current.recorder.stop();
      release(current);
    },
    [release],
  );

  return { phase, elapsed, levels, error, start, stop, cancel, toggle, clearError };
}

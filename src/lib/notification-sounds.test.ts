import { describe, expect, it, vi } from "vitest";

import {
  createNotificationSoundPlayer,
  type AudioContextLike,
  type CreateAudioContext,
} from "@/lib/notification-sounds";

function audioParam(value = 0) {
  return {
    value,
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  };
}

function stubContext(state: AudioContextState = "running") {
  const oscillators: Array<{
    type: OscillatorType;
    frequency: ReturnType<typeof audioParam>;
    connect: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }> = [];
  const gains: Array<{ gain: ReturnType<typeof audioParam>; connect: ReturnType<typeof vi.fn> }> = [];
  const resume = vi.fn(async () => undefined);
  const context: AudioContextLike = {
    currentTime: 12.5,
    state,
    resume,
    destination: {} as AudioNode,
    createOscillator: vi.fn(() => {
      const oscillator = {
        type: "sine" as OscillatorType,
        frequency: audioParam(),
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };
      oscillators.push(oscillator);
      return oscillator as unknown as OscillatorNode;
    }),
    createGain: vi.fn(() => {
      const gain = { gain: audioParam(), connect: vi.fn() };
      gains.push(gain);
      return gain as unknown as GainNode;
    }),
  };
  return { context, oscillators, gains, resume };
}

function playerOver(stub: ReturnType<typeof stubContext>) {
  const createAudioContext: CreateAudioContext = vi.fn(() => stub.context);
  return {
    createAudioContext: createAudioContext as CreateAudioContext,
    player: createNotificationSoundPlayer(createAudioContext),
  };
}

describe("notification sound player", () => {
  it("plays a rising two-note chime when a Wisp finishes", () => {
    const stub = stubContext();
    const { player } = playerOver(stub);

    player.play("finished");

    expect(stub.oscillators.map(({ frequency }) => frequency.value)).toEqual([659.25, 880]);
    expect(stub.oscillators[0]!.start).toHaveBeenCalledWith(12.5);
    expect(stub.oscillators[0]!.stop).toHaveBeenCalledWith(12.71);
    expect(stub.oscillators[1]!.start).toHaveBeenCalledWith(12.62);
    expect(stub.oscillators[1]!.stop).toHaveBeenCalledWith(13.01);
  });

  it("plays a falling two-note chime when input is needed", () => {
    const stub = stubContext();
    const { player } = playerOver(stub);

    player.play("needs-input");

    expect(stub.oscillators.map(({ frequency }) => frequency.value)).toEqual([880, 659.25]);
    expect(stub.oscillators[1]!.start).toHaveBeenCalledWith(12.64);
  });

  it("shapes each note with a fast attack and exponential decay", () => {
    const stub = stubContext();
    const { player } = playerOver(stub);

    player.play("finished");

    const envelope = stub.gains[0]!.gain;
    expect(envelope.setValueAtTime).toHaveBeenCalledWith(0.0001, 12.5);
    expect(envelope.linearRampToValueAtTime).toHaveBeenCalledWith(0.14, 12.512);
    expect(envelope.exponentialRampToValueAtTime).toHaveBeenCalledWith(0.0001, 12.66);
  });

  it("scales volume and keeps zero volume silent", () => {
    const stub = stubContext();
    const { player } = playerOver(stub);
    player.play("error", 0);
    expect(stub.oscillators).toHaveLength(0);
    player.play("error", 50);
    expect(stub.oscillators.map(({ frequency }) => frequency.value)).toEqual([440, 329.63]);
    expect(stub.gains[0]!.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0.07, 12.512);
  });

  it("creates the audio context lazily on the first play", () => {
    const stub = stubContext();
    const { createAudioContext, player } = playerOver(stub);

    expect(createAudioContext).not.toHaveBeenCalled();
    player.play("finished");
    expect(createAudioContext).toHaveBeenCalledTimes(1);
  });

  it("resumes a suspended audio context before scheduling notes", () => {
    const stub = stubContext("suspended");
    const { player } = playerOver(stub);

    player.play("finished");

    expect(stub.resume).toHaveBeenCalledTimes(1);
    expect(stub.oscillators).toHaveLength(2);
  });

  it("stays silent when no audio context is available", () => {
    const player = createNotificationSoundPlayer(() => null);

    expect(() => player.play("finished")).not.toThrow();
    expect(() => player.play("needs-input")).not.toThrow();
  });

  it("stays silent under the default factory when Web Audio is unavailable", () => {
    const player = createNotificationSoundPlayer();

    expect(() => player.play("finished")).not.toThrow();
  });
});

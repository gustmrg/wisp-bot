import { describe, expect, it } from "vitest";

import { decodeRemoteJson, encodeRemoteJson } from "../../shared/remote-codec.js";

describe("remote JSON codec", () => {
  it("round-trips byte arrays, including Buffers and large recordings", () => {
    const audio = new Uint8Array(200_000).map((_, index) => index % 251);
    const decoded = decodeRemoteJson(
      encodeRemoteJson({ audio, nested: [Buffer.from("hi")], text: "plain", empty: new Uint8Array(0) }),
    ) as Record<string, unknown>;
    expect(decoded.audio).toBeInstanceOf(Uint8Array);
    expect(decoded.audio).toEqual(audio);
    expect(decoded.nested).toEqual([new Uint8Array([104, 105])]);
    expect(decoded.empty).toEqual(new Uint8Array(0));
    expect(decoded.text).toBe("plain");
  });

  it("leaves ordinary objects that only resemble the byte encoding alone", () => {
    expect(decodeRemoteJson('{"$bytes":1}')).toEqual({ $bytes: 1 });
    expect(decodeRemoteJson('{"$bytes":"AA==","other":true}')).toEqual({ $bytes: "AA==", other: true });
  });
});

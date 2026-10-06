/**
 * JSON for the remote protocol. Byte arrays (recorded audio) are not JSON
 * values, so they travel as `{ "$bytes": "<base64>" }` and are restored on the
 * other side. Works in Node and in browsers.
 */
const BYTES_KEY = "$bytes";

export function encodeRemoteJson(value: unknown): string {
  return JSON.stringify(value, function (this: Record<string, unknown>, key, current: unknown) {
    // `this[key]` is the original value: Buffer's toJSON has already replaced `current`.
    const original = key === "" ? value : this[key];
    return original instanceof Uint8Array ? { [BYTES_KEY]: toBase64(original) } : current;
  });
}

export function decodeRemoteJson(text: string): unknown {
  return JSON.parse(text, (_key, current: unknown) => {
    if (current && typeof current === "object" && !Array.isArray(current)) {
      const keys = Object.keys(current);
      const encoded = (current as Record<string, unknown>)[BYTES_KEY];
      if (keys.length === 1 && keys[0] === BYTES_KEY && typeof encoded === "string") return fromBase64(encoded);
    }
    return current;
  });
}

const CHUNK = 0x8000;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

function fromBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

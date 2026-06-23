import { unzlibSync, strFromU8 } from "fflate";

/** Decode a hex string into bytes. Ignores any non-hex characters. */
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "");
  const len = clean.length >> 1;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

/** Find the byte offset of a zlib header (0x78 0x?? with a valid second byte). */
export function findZlibHeader(bytes: Uint8Array, from = 0): number {
  for (let i = from; i < bytes.length - 1; i++) {
    if (bytes[i] === 0x78) {
      const b = bytes[i + 1];
      // Common zlib FLG/CMF second bytes: 0x01, 0x5e, 0x9c, 0xda.
      if (b === 0x01 || b === 0x5e || b === 0x9c || b === 0xda) {
        return i;
      }
    }
  }
  return -1;
}

/**
 * Inflate a zlib stream that begins at `offset` within `bytes`. Returns the
 * decompressed bytes, or null if inflation fails.
 */
export function inflateFrom(bytes: Uint8Array, offset: number): Uint8Array | null {
  try {
    return unzlibSync(bytes.subarray(offset));
  } catch {
    return null;
  }
}

/** Inflate the first zlib stream found at/after `from`, as a string. */
export function inflateZlibText(bytes: Uint8Array, from = 0): string | null {
  const offset = findZlibHeader(bytes, from);
  if (offset < 0) return null;
  const out = inflateFrom(bytes, offset);
  return out ? strFromU8(out, true) : null;
}

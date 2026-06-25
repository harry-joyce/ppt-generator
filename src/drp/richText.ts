import { decompress } from "fzstd";
import { hexToBytes } from "./inflate";

/**
 * Recover the full on-screen text from a Rich Text generator's `EffectFiltersBA`
 * blob.
 *
 * DaVinci stores a Rich Text generator's `Name` truncated to ~45 characters, so
 * the complete text cannot be read from the XML directly. The real text lives in
 * the `EffectFiltersBA` field: a hex-encoded, zstd-compressed serialization of
 * the effect stack whose string payloads are UTF-16LE. Each text field is a
 * sequence of word-wrapped lines followed by its style block (font name, MEPS
 * weight id, and a `#RRGGBB` colour). We decode the blob, pull out the readable
 * UTF-16LE runs, and regroup the lines back into whole paragraphs.
 */

/** Locate the start of a zstd frame (magic `28 b5 2f fd`). */
function findZstdHeader(bytes: Uint8Array, from = 0): number {
  for (let i = from; i < bytes.length - 3; i++) {
    if (
      bytes[i] === 0x28 &&
      bytes[i + 1] === 0xb5 &&
      bytes[i + 2] === 0x2f &&
      bytes[i + 3] === 0xfd
    ) {
      return i;
    }
  }
  return -1;
}

/** Decode a byte buffer as UTF-16LE. */
function decodeUtf16le(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    out += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
  }
  return out;
}

/**
 * Match runs of caption-like characters. Restricting to Latin letters, digits,
 * and common punctuation means binary fields (lengths, ids) that happen to
 * decode as CJK code points are skipped automatically.
 */
const CAPTION_RUN =
  /[A-Za-z0-9\u00c0-\u024f ,.;:'"!?()[\]\-/&%@#\u2018\u2019\u201c\u201d\u2013\u2014\u2026\u00a0]{3,}/g;

/**
 * A run belongs to a style block (and therefore ends the current paragraph) when
 * it is a colour (`#RRGGBB`), a MEPS font id (`Medium #5302`), or a font name
 * immediately followed by such an id.
 */
function isStyleRun(runs: string[], i: number): boolean {
  const run = runs[i];
  if (/^#[0-9a-fA-F]{6}/.test(run)) return true;
  if (/#\d{2,}/.test(run)) return true;
  if (i + 1 < runs.length && /#\d{2,}/.test(runs[i + 1])) return true;
  return false;
}

const HAS_VOWEL = /[aeiou]/i;
const NON_PRINTABLE =
  /[^\x20-\x7e\u2018\u2019\u201c\u201d\u2013\u2014\u2026\u00a0]/g;

/**
 * Reject paragraphs that are leftover binary noise rather than real text. Real
 * caption text has at least a few letters, contains a vowel, and is almost
 * entirely printable.
 */
function isReadable(paragraph: string): boolean {
  if (paragraph.replace(/[^A-Za-z]/g, "").length < 3) return false;
  if (!HAS_VOWEL.test(paragraph)) return false;
  const noise = (paragraph.match(NON_PRINTABLE) || []).length;
  return noise / paragraph.length < 0.2;
}

/**
 * Extract every text field from a Rich Text generator's `EffectFiltersBA` blob,
 * in document order. Returns an empty array when the blob is absent or cannot be
 * decompressed.
 */
export function extractRichTextFields(effectFiltersHex: string): string[] {
  const hex = effectFiltersHex.trim();
  if (!hex) return [];

  const bytes = hexToBytes(hex);
  const offset = findZstdHeader(bytes);
  if (offset < 0) return [];

  let raw: Uint8Array;
  try {
    raw = decompress(bytes.subarray(offset));
  } catch {
    return [];
  }

  const runs = (decodeUtf16le(raw).match(CAPTION_RUN) || [])
    .map((run) => run.trim())
    .filter(Boolean);

  const paragraphs: string[] = [];
  let buffer: string[] = [];

  const flush = (): void => {
    if (buffer.length === 0) return;
    const paragraph = buffer.join(" ").replace(/\s+/g, " ").trim();
    if (isReadable(paragraph)) paragraphs.push(paragraph);
    buffer = [];
  };

  for (let i = 0; i < runs.length; i++) {
    if (isStyleRun(runs, i)) flush();
    else buffer.push(runs[i]);
  }
  flush();

  // Collapse identical fields (a generator may repeat a layer verbatim).
  const seen = new Set<string>();
  return paragraphs.filter((p) => {
    if (seen.has(p)) return false;
    seen.add(p);
    return true;
  });
}

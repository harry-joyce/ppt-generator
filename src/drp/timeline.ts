import { extractFusionTexts, type FusionText } from "./fusionTitle";
import type { TextElement } from "./types";

/** PrettyType values for generators that carry user text (no Fusion comp). */
const TEXT_GENERATOR_RE = /text|rich|title|caption|subtitle/i;

/** Tag names that represent a clip/generator on a track. */
const CLIP_TAGS = ["Sm2TiVideoClip", "Sm2TiGenerator"];

function directChildText(el: Element, tag: string): string | null {
  for (const child of Array.from(el.children)) {
    if (child.tagName === tag) return child.textContent;
  }
  return null;
}

/** A background media clip on a video track (the rendered timeline footage). */
interface MediaClip {
  /** Timeline start position, in frames. */
  start: number;
  /** Decoded frame rate, if recoverable. */
  frameRate?: number;
}

/** Aggregate result of parsing one or more sequence documents. */
export interface ParsedTimeline {
  elements: TextElement[];
  /** Frame rate of the earliest media clip, if found. */
  frameRate?: number;
  /** Timeline frame where the earliest media clip begins, if found. */
  videoBaseFrame?: number;
}

/**
 * Decode a DaVinci `MediaFrameRate` field into frames per second. The value is
 * a hex string whose first 8 bytes are a little-endian IEEE-754 double.
 */
function decodeFrameRate(hex: string | null): number | undefined {
  if (!hex) return undefined;
  const h = hex.trim();
  if (h.length < 16 || !/^[0-9a-fA-F]+$/.test(h.slice(0, 16))) return undefined;
  const buf = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    buf[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  const value = new DataView(buf.buffer).getFloat64(0, true);
  return Number.isFinite(value) && value > 0 && value < 1000 ? value : undefined;
}

/** Map Fusion Text+ tools to primary/secondary lines by their tool name. */
function mapFusionTexts(texts: FusionText[]): {
  primary: string;
  secondary?: string;
} {
  let primary: string | undefined;
  let secondary: string | undefined;
  const leftovers: string[] = [];

  for (const t of texts) {
    if (!t.value.trim()) continue;
    if (/name/i.test(t.tool) && primary === undefined) {
      primary = t.value;
    } else if (/desc/i.test(t.tool) && secondary === undefined) {
      secondary = t.value;
    } else {
      leftovers.push(t.value);
    }
  }

  // Fill any gaps in declaration order.
  for (const v of leftovers) {
    if (primary === undefined) primary = v;
    else if (secondary === undefined) secondary = v;
  }

  return { primary: primary ?? "", secondary };
}

/**
 * Clean a Rich/Text generator clip name into display text. DaVinci appends a
 * template suffix such as " - Custom"; the recovered name is also truncated.
 */
function cleanGeneratorName(name: string): { text: string; truncated: boolean } {
  const stripped = name.replace(/\s*-\s*[A-Za-z][\w ]*$/, "").trim();
  // DaVinci truncates the auto-generated name, so flag generators that look cut.
  const truncated = true;
  return { text: stripped || name.trim(), truncated };
}

/**
 * DaVinci writes invalid XML QNames such as `<ListMgt::LmVersionTable>`. The
 * browser's strict XML parser rejects these and truncates the document, so we
 * rewrite `::` inside element names to `__` before parsing.
 */
function sanitizeXml(xml: string): string {
  let prev: string;
  do {
    prev = xml;
    xml = xml.replace(/(<\/?[A-Za-z_][\w.-]*)::/g, "$1__");
  } while (xml !== prev);
  return xml;
}

/** Parse a single SeqContainer XML document into text elements. */
function parseSequence(xml: string): {
  elements: TextElement[];
  mediaClips: MediaClip[];
} {
  const doc = new DOMParser().parseFromString(
    sanitizeXml(xml),
    "application/xml",
  );

  const elements: TextElement[] = [];
  const mediaClips: MediaClip[] = [];
  const clips = doc.querySelectorAll(CLIP_TAGS.join(","));

  for (const clip of Array.from(clips)) {
    const prettyType = (directChildText(clip, "PrettyType") ?? "").trim();
    const name = (directChildText(clip, "Name") ?? "").trim();
    const startFrames = Number(directChildText(clip, "Start") ?? "0") || 0;

    const compositionBA = clip.querySelector("CompositionBA")?.textContent ?? "";
    const hasComposition = /^[0-9a-fA-F]{16,}$/.test(compositionBA.trim());

    // A real media clip (the rendered footage) carries a MediaFilePath and has
    // no embedded Fusion composition. Record it so we can locate where the
    // uploaded video begins on the timeline and recover the frame rate.
    const mediaFilePath = (directChildText(clip, "MediaFilePath") ?? "").trim();
    if (clip.tagName === "Sm2TiVideoClip" && mediaFilePath && !hasComposition) {
      mediaClips.push({
        start: startFrames,
        frameRate: decodeFrameRate(directChildText(clip, "MediaFrameRate")),
      });
    }

    if (hasComposition) {
      // Fusion Title: pull text from the embedded composition.
      const texts = extractFusionTexts(compositionBA.trim());
      const { primary, secondary } = mapFusionTexts(texts);
      if (primary || secondary) {
        elements.push({
          sourceType: prettyType || "Fusion Title",
          primary,
          secondary,
          startFrames,
          truncated: false,
        });
      }
      continue;
    }

    // Text generator without a Fusion composition (e.g. Rich Text).
    if (
      clip.tagName === "Sm2TiGenerator" &&
      TEXT_GENERATOR_RE.test(prettyType) &&
      name
    ) {
      const { text, truncated } = cleanGeneratorName(name);
      if (text) {
        elements.push({
          sourceType: prettyType || "Text",
          primary: text,
          startFrames,
          truncated,
        });
      }
    }
  }

  return { elements, mediaClips };
}

/** Parse all sequence documents in an archive into ordered text elements. */
export function parseTimelines(sequenceXmls: string[]): ParsedTimeline {
  const elements: TextElement[] = [];
  const mediaClips: MediaClip[] = [];
  for (const xml of sequenceXmls) {
    const parsed = parseSequence(xml);
    elements.push(...parsed.elements);
    mediaClips.push(...parsed.mediaClips);
  }

  // The rendered video begins at the earliest media clip on the timeline.
  let base: MediaClip | undefined;
  for (const clip of mediaClips) {
    if (!base || clip.start < base.start) base = clip;
  }

  return {
    elements,
    frameRate: base?.frameRate,
    videoBaseFrame: base?.start,
  };
}

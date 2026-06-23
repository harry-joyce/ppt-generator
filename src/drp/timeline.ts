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
function parseSequence(xml: string): TextElement[] {
  const doc = new DOMParser().parseFromString(
    sanitizeXml(xml),
    "application/xml",
  );

  const elements: TextElement[] = [];
  const clips = doc.querySelectorAll(CLIP_TAGS.join(","));

  for (const clip of Array.from(clips)) {
    const prettyType = (directChildText(clip, "PrettyType") ?? "").trim();
    const name = (directChildText(clip, "Name") ?? "").trim();
    const startFrames = Number(directChildText(clip, "Start") ?? "0") || 0;

    const compositionBA = clip.querySelector("CompositionBA")?.textContent ?? "";

    if (/^[0-9a-fA-F]{16,}$/.test(compositionBA.trim())) {
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

  return elements;
}

/** Parse all sequence documents in an archive into ordered text elements. */
export function parseTimelines(sequenceXmls: string[]): TextElement[] {
  const all: TextElement[] = [];
  for (const xml of sequenceXmls) {
    all.push(...parseSequence(xml));
  }
  return all;
}

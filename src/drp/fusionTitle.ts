import { strFromU8 } from "fflate";
import { hexToBytes, findZlibHeader, inflateFrom } from "./inflate";

/** A text value pulled from a Fusion Text+ tool, keyed by the tool's name. */
export interface FusionText {
  /** The Fusion tool name (e.g. "Name", "Description"). */
  tool: string;
  /** The StyledText value. */
  value: string;
}

/**
 * Decode the readable text payload(s) inside a Fusion CompositionBA blob.
 *
 * The blob is hex-encoded and zlib-compressed. The outer stream inflates to a
 * Fusion composition preamble which, when `Compressed = true`, embeds a second
 * zlib stream containing the actual tool table. We therefore collect every
 * decompressible layer and return their text for parsing.
 */
function decodeCompositionLayers(compositionHex: string): string[] {
  const bytes = hexToBytes(compositionHex);
  const layers: string[] = [];

  const outerOffset = findZlibHeader(bytes);
  if (outerOffset < 0) return layers;

  const outer = inflateFrom(bytes, outerOffset);
  if (!outer) return layers;
  layers.push(strFromU8(outer, true));

  // Look for additional nested zlib streams inside the outer payload.
  let search = 0;
  while (search < outer.length) {
    const innerOffset = findZlibHeader(outer, search);
    if (innerOffset < 0) break;
    const inner = inflateFrom(outer, innerOffset);
    if (inner && inner.length > 32) {
      layers.push(strFromU8(inner, true));
    }
    search = innerOffset + 2;
  }

  return layers;
}

/**
 * Match `ToolName = TextPlus { ... StyledText = Input { ... Value = "TEXT" } }`.
 * The `[\s\S]*?` is lazy so each tool binds to its own nearest StyledText value.
 */
const TEXTPLUS_RE =
  /(\w+)\s*=\s*TextPlus\s*\{[\s\S]*?StyledText\s*=\s*Input\s*\{[\s\S]*?Value\s*=\s*"((?:[^"\\]|\\.)*)"/g;

/** Unescape Lua-style string escapes used in Fusion comp text. */
function unescapeFusion(value: string): string {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

/**
 * Extract all Fusion Text+ values (with their tool names) from a
 * CompositionBA hex blob.
 */
export function extractFusionTexts(compositionHex: string): FusionText[] {
  const results: FusionText[] = [];
  const seen = new Set<string>();

  for (const layer of decodeCompositionLayers(compositionHex)) {
    TEXTPLUS_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TEXTPLUS_RE.exec(layer)) !== null) {
      const tool = m[1];
      const value = unescapeFusion(m[2]);
      const key = `${tool}\u0000${value}`;
      if (!seen.has(key)) {
        seen.add(key);
        results.push({ tool, value });
      }
    }
  }

  return results;
}

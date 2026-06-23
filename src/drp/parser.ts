import { readArchive } from "./unzip";
import { parseTimelines } from "./timeline";
import type { ParsedProject, TextElement } from "./types";

function extractProjectName(projectXml: string): string {
  const m = projectXml.match(/<ProjectName>([^<]*)<\/ProjectName>/);
  return m ? m[1].trim() : "Untitled";
}

/** Stable identity of an element's text payload, for deduplication. */
function payloadKey(e: TextElement): string {
  return `${e.primary}\u0000${e.secondary ?? ""}`;
}

/** Sort by timeline position, then merge identical consecutive elements. */
function orderAndDedup(elements: TextElement[]): TextElement[] {
  const sorted = [...elements].sort((a, b) => a.startFrames - b.startFrames);
  const out: TextElement[] = [];
  for (const el of sorted) {
    const prev = out[out.length - 1];
    if (prev && payloadKey(prev) === payloadKey(el)) continue;
    out.push(el);
  }
  return out;
}

/** Parse a `.drp` / `.drt` archive into an ordered list of text elements. */
export function parseProject(data: Uint8Array): ParsedProject {
  const archive = readArchive(data);
  const elements = orderAndDedup(parseTimelines(archive.sequenceXmls));
  return {
    projectName: extractProjectName(archive.projectXml),
    elements,
  };
}

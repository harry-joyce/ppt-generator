import { unzipSync, strFromU8 } from "fflate";

/** The decompressed contents of a `.drp` / `.drt` archive. */
export interface ResolveArchive {
  /** project.xml as text (project-level metadata). */
  projectXml: string;
  /** Each SeqContainer/<uuid>.xml timeline document, as text. */
  sequenceXmls: string[];
}

/**
 * Unzip a DaVinci Resolve `.drp` / `.drt` archive (both are ZIP files) and
 * return the XML documents needed for text extraction.
 */
export function readArchive(data: Uint8Array): ResolveArchive {
  const files = unzipSync(data);

  let projectXml = "";
  const sequenceXmls: string[] = [];

  for (const [path, bytes] of Object.entries(files)) {
    const normalized = path.replace(/\\/g, "/");
    if (normalized === "project.xml" || normalized.endsWith("/project.xml")) {
      projectXml = strFromU8(bytes);
    } else if (
      normalized.includes("SeqContainer/") &&
      normalized.toLowerCase().endsWith(".xml")
    ) {
      sequenceXmls.push(strFromU8(bytes));
    }
  }

  return { projectXml, sequenceXmls };
}

/** A single text element extracted from the timeline. */
export interface TextElement {
  /** Where the text came from, e.g. "Fusion Title", "Rich". */
  sourceType: string;
  /** Primary line (Fusion `Name` tool, or the generator name). */
  primary: string;
  /** Secondary line (Fusion `Description` tool), if any. */
  secondary?: string;
  /** Timeline start position, in frames. Used for ordering. */
  startFrames: number;
  /**
   * True when the text could only be partially recovered from the project
   * file (e.g. Rich Text generators store a truncated clip name).
   */
  truncated: boolean;
}

/** Result of parsing a `.drp` / `.drt` archive. */
export interface ParsedProject {
  projectName: string;
  elements: TextElement[];
}

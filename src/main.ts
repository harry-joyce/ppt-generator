import "./style.css";
import { parseProject } from "./drp/parser";
import { generatePptx, type SlideExtras } from "./pptx/build";
import { FrameExtractor } from "./video/frames";
import type { TextElement } from "./drp/types";

/** A review-table row: the parsed element plus user edits. */
interface Row {
  include: boolean;
  primary: string;
  secondary: string;
  sourceType: string;
  startFrames: number;
  truncated: boolean;
}

const dropzone = document.getElementById("dropzone") as HTMLElement;
const fileInput = document.getElementById("fileInput") as HTMLInputElement;
const statusEl = document.getElementById("status") as HTMLElement;
const reviewEl = document.getElementById("review") as HTMLElement;
const reviewBody = document.getElementById("reviewBody") as HTMLElement;
const generateBtn = document.getElementById("generateBtn") as HTMLButtonElement;
const videoInput = document.getElementById("videoInput") as HTMLInputElement;
const videoName = document.getElementById("videoName") as HTMLElement;
const fpsInput = document.getElementById("fpsInput") as HTMLInputElement;
const nudgeInput = document.getElementById("nudgeInput") as HTMLInputElement;

let rows: Row[] = [];
let projectName = "OST";
let frameRate: number | undefined;
let videoBaseFrame: number | undefined;
let videoFile: File | undefined;

function setStatus(message: string, isError = false): void {
  statusEl.textContent = message;
  statusEl.classList.toggle("status--error", isError);
}

function formatTimecode(frames: number): string {
  // Display frames as a rough position; project frame rate is not needed for order.
  return `${frames} f`;
}

function toRows(elements: TextElement[]): Row[] {
  return elements.map((e) => ({
    include: true,
    primary: e.primary,
    secondary: e.secondary ?? "",
    sourceType: e.sourceType,
    startFrames: e.startFrames,
    truncated: e.truncated,
  }));
}

function renderTable(): void {
  reviewBody.replaceChildren();

  rows.forEach((row, index) => {
    const tr = document.createElement("tr");
    tr.classList.toggle("row--excluded", !row.include);

    // Include checkbox.
    const tdInclude = document.createElement("td");
    tdInclude.className = "col-include";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = row.include;
    checkbox.addEventListener("change", () => {
      row.include = checkbox.checked;
      tr.classList.toggle("row--excluded", !row.include);
      updateGenerateState();
    });
    tdInclude.appendChild(checkbox);

    // Type (+ truncated badge).
    const tdType = document.createElement("td");
    tdType.className = "col-type";
    const typeTag = document.createElement("span");
    typeTag.className = "type-tag";
    typeTag.textContent = row.sourceType;
    tdType.appendChild(typeTag);
    if (row.truncated) {
      const badge = document.createElement("span");
      badge.className = "badge badge--warn";
      badge.textContent = "truncated";
      tdType.appendChild(badge);
    }

    // Primary text input.
    const tdPrimary = document.createElement("td");
    tdPrimary.className = "col-primary";
    tdPrimary.appendChild(
      makeInput(row.primary, (v) => {
        row.primary = v;
      }),
    );

    // Secondary text input.
    const tdSecondary = document.createElement("td");
    tdSecondary.className = "col-secondary";
    tdSecondary.appendChild(
      makeInput(row.secondary, (v) => {
        row.secondary = v;
      }),
    );

    // Timeline position.
    const tdPos = document.createElement("td");
    tdPos.className = "col-pos";
    tdPos.textContent = formatTimecode(row.startFrames);

    tr.append(tdInclude, tdType, tdPrimary, tdSecondary, tdPos);
    reviewBody.appendChild(tr);
    void index;
  });

  reviewEl.hidden = rows.length === 0;
  updateGenerateState();
}

function makeInput(value: string, onChange: (v: string) => void): HTMLInputElement {
  const input = document.createElement("input");
  input.className = "cell-input";
  input.type = "text";
  input.value = value;
  input.addEventListener("input", () => onChange(input.value));
  return input;
}

function updateGenerateState(): void {
  const anyIncluded = rows.some((r) => r.include);
  generateBtn.disabled = !anyIncluded;
}

async function handleFile(file: File): Promise<void> {
  try {
    setStatus(`Reading ${file.name}…`);
    const buffer = new Uint8Array(await file.arrayBuffer());
    const parsed = parseProject(buffer);
    projectName = parsed.projectName || file.name.replace(/\.[^.]+$/, "");
    rows = toRows(parsed.elements);
    frameRate = parsed.frameRate;
    videoBaseFrame = parsed.videoBaseFrame;

    if (frameRate) {
      fpsInput.value = frameRate.toFixed(3);
    }

    if (rows.length === 0) {
      reviewEl.hidden = true;
      setStatus("No text elements were found in this project.", true);
      return;
    }

    renderTable();
    const truncatedCount = rows.filter((r) => r.truncated).length;
    setStatus(
      `Found ${rows.length} text element${rows.length === 1 ? "" : "s"} in “${projectName}”.` +
        (truncatedCount
          ? ` ${truncatedCount} may be truncated — please review.`
          : ""),
    );
  } catch (err) {
    console.error(err);
    reviewEl.hidden = true;
    setStatus(
      `Could not read this file. Make sure it is a valid .drp or .drt project.`,
      true,
    );
  }
}

async function handleGenerate(): Promise<void> {
  const selected = rows
    .filter((r) => r.include && (r.primary.trim() || r.secondary.trim()))
    .map<TextElement>((r) => ({
      sourceType: r.sourceType,
      primary: r.primary,
      secondary: r.secondary.trim() ? r.secondary : undefined,
      startFrames: r.startFrames,
      truncated: r.truncated,
    }));

  if (selected.length === 0) {
    setStatus("Nothing to export — select at least one element.", true);
    return;
  }

  try {
    generateBtn.disabled = true;

    const { extras, failures } = await buildBackgrounds(selected);

    setStatus(`Generating PowerPoint with ${selected.length} slide(s)…`);
    await generatePptx(selected, projectName, extras);
    setStatus(
      failures > 0
        ? `Done. ${failures} of ${selected.length} slide(s) kept a solid background because the video frame could not be decoded.`
        : `Done. Your PowerPoint has been downloaded.`,
    );
  } catch (err) {
    console.error(err);
    const detail = err instanceof Error ? err.message : String(err);
    setStatus(`Failed to generate the PowerPoint: ${detail}`, true);
  } finally {
    updateGenerateState();
  }
}

/**
 * When a timeline video is supplied, extract one background frame per slide at
 * the moment its text appears. Returns an empty array (solid backgrounds) when
 * no video is selected or the frame rate is unknown.
 *
 * The ffmpeg WebAssembly core can crash while seeking deep into very large
 * professional sources; rather than letting one bad frame freeze the whole
 * export, a failed decode falls back to a solid background for that slide and
 * the core is rebuilt before the next frame.
 */
async function buildBackgrounds(
  selected: TextElement[],
): Promise<{ extras: SlideExtras[]; failures: number }> {
  if (!videoFile) return { extras: [], failures: 0 };

  const fps = Number(fpsInput.value);
  if (!Number.isFinite(fps) || fps <= 0) {
    setStatus("Enter a valid frame rate to use video backgrounds.", true);
    throw new Error("invalid frame rate");
  }

  const nudge = Number(nudgeInput.value) || 0;
  // Frame 0 of the rendered video is where the timeline's video content starts.
  // Fall back to the earliest selected element if no media clip was detected.
  const base =
    videoBaseFrame ??
    selected.reduce((min, e) => Math.min(min, e.startFrames), Infinity);

  const extractor = new FrameExtractor();
  const extras: SlideExtras[] = [];
  let failures = 0;
  try {
    setStatus("Loading video decoder…");
    await extractor.init(videoFile);

    for (let i = 0; i < selected.length; i++) {
      setStatus(`Extracting frame ${i + 1} of ${selected.length}…`);
      const seconds = (selected[i].startFrames - base) / fps + nudge;
      try {
        extras[i] = { backgroundDataUrl: await extractor.extractFrame(seconds) };
      } catch (err) {
        // The decoder likely crashed on this frame. Keep a solid background for
        // this slide and rebuild the core so the remaining frames still work.
        console.warn(`Frame ${i + 1} could not be decoded:`, err);
        extras[i] = {};
        failures++;
        if (i < selected.length - 1) {
          setStatus(`Recovering video decoder after frame ${i + 1}…`);
          await extractor.reset();
        }
      }
    }
  } finally {
    extractor.terminate();
  }

  return { extras, failures };
}

// --- Event wiring -----------------------------------------------------------

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) void handleFile(file);
});

videoInput.addEventListener("change", () => {
  videoFile = videoInput.files?.[0] ?? undefined;
  videoName.textContent = videoFile
    ? videoFile.name
    : "No video selected (slides use a solid background)";
});

["dragenter", "dragover"].forEach((type) =>
  dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    dropzone.classList.add("dropzone--over");
  }),
);

["dragleave", "drop"].forEach((type) =>
  dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    dropzone.classList.remove("dropzone--over");
  }),
);

dropzone.addEventListener("drop", (e) => {
  const file = (e as DragEvent).dataTransfer?.files?.[0];
  if (file) void handleFile(file);
});

generateBtn.addEventListener("click", () => void handleGenerate());

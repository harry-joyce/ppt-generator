import "./style.css";
import { parseProject } from "./drp/parser";
import { generatePptx } from "./pptx/build";
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

let rows: Row[] = [];
let projectName = "OST";

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
    setStatus(`Generating PowerPoint with ${selected.length} slide(s)…`);
    await generatePptx(selected, projectName);
    setStatus(`Done. Your PowerPoint has been downloaded.`);
  } catch (err) {
    console.error(err);
    setStatus("Failed to generate the PowerPoint.", true);
  } finally {
    updateGenerateState();
  }
}

// --- Event wiring -----------------------------------------------------------

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) void handleFile(file);
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

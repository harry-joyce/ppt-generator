import PptxGenJS from "pptxgenjs";
import type { TextElement } from "../drp/types";

/**
 * Slide style derived from the reference deck (jwb13608O.pptx). Sizes are in
 * inches; the original used EMU (1 inch = 914400 EMU) on a 16:9 canvas.
 */
const STYLE = {
  slideWidth: 20,
  slideHeight: 11.25,
  /** Background fill behind the (white) on-screen text. */
  background: "1A1A1A",
  primary: {
    x: 3.838,
    y: 8.685,
    w: 14.757,
    h: 0.825,
    fontSize: 43,
    bold: true,
    fontFace: "JW Knoll Display Bold",
    color: "FAFAFA",
  },
  secondary: {
    x: 3.826,
    y: 9.484,
    w: 14.757,
    h: 0.707,
    fontSize: 36,
    bold: false,
    fontFace: "JW Knoll Medium",
    color: "FAFAFA",
  },
} as const;

const LAYOUT_NAME = "OST_16x9";

/** Build a PowerPoint from the extracted text elements and trigger a download. */
export async function generatePptx(
  elements: TextElement[],
  projectName: string,
): Promise<void> {
  const pptx = new PptxGenJS();
  pptx.defineLayout({
    name: LAYOUT_NAME,
    width: STYLE.slideWidth,
    height: STYLE.slideHeight,
  });
  pptx.layout = LAYOUT_NAME;

  for (const el of elements) {
    const slide = pptx.addSlide();
    slide.background = { color: STYLE.background };

    slide.addText(el.primary, {
      x: STYLE.primary.x,
      y: STYLE.primary.y,
      w: STYLE.primary.w,
      h: STYLE.primary.h,
      fontSize: STYLE.primary.fontSize,
      bold: STYLE.primary.bold,
      fontFace: STYLE.primary.fontFace,
      color: STYLE.primary.color,
      align: "left",
      valign: "top",
    });

    if (el.secondary && el.secondary.trim()) {
      slide.addText(el.secondary, {
        x: STYLE.secondary.x,
        y: STYLE.secondary.y,
        w: STYLE.secondary.w,
        h: STYLE.secondary.h,
        fontSize: STYLE.secondary.fontSize,
        bold: STYLE.secondary.bold,
        fontFace: STYLE.secondary.fontFace,
        color: STYLE.secondary.color,
        align: "left",
        valign: "top",
      });
    }
  }

  const safeName = (projectName || "OST").replace(/[^\w.-]+/g, "_");
  await pptx.writeFile({ fileName: `${safeName}.pptx` });
}

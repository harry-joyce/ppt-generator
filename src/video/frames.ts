import { FFmpeg, FFFSType } from "@ffmpeg/ffmpeg";
import {
  buildSampleMov,
  isAllIntra,
  locateSample,
  parseMovIndex,
  type MovIndex,
} from "./mov";

/** Absolute URL to a core asset served under the app's base path. */
function coreAsset(name: string): string {
  const base = import.meta.env.BASE_URL || "/";
  return new URL(`${base}ffmpeg/${name}`, window.location.href).href;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

const MOUNT_DIR = "/mounted";

/**
 * Width to scale extracted frames to. The single-threaded ffmpeg.wasm MJPEG
 * encoder (core 5.1.4) aborts its WebAssembly runtime on some full-resolution
 * (1920-wide) frames; encoding at 1280 wide avoids the crash and keeps the
 * decoded backgrounds small. Aspect ratio is preserved (`-2` rounds height to
 * an even number).
 */
const FRAME_WIDTH = 1280;

/**
 * How many frames to decode per ffmpeg pass. All frames in a chunk are wrapped
 * in one synthetic `.mov` and decoded together, then the core is rebuilt for
 * the next chunk to bound decoder memory.
 */
const SLICE_CHUNK = 16;

/** Raised when a frame could not be decoded within the allotted time. */
export class FrameTimeoutError extends Error {
  constructor(seconds: number) {
    super(`Timed out decoding the frame at ${seconds.toFixed(2)}s.`);
    this.name = "FrameTimeoutError";
  }
}

/** Optional progress reporter: how many frames are done out of the total. */
export type FrameProgress = (done: number, total: number) => void;

/**
 * Decodes single frames from an uploaded video entirely in the browser using
 * ffmpeg.wasm. Handles professional codecs (e.g. ProRes) that the native
 * `<video>` element cannot.
 *
 * For all-intra sources (ProRes, DNxHD/HR) the MOV container index is parsed in
 * JavaScript and only the exact bytes of each requested coded frame are sliced
 * out of the `File`. A tiny self-contained `.mov` is synthesised around those
 * bytes and decoded, so ffmpeg never seeks inside the multi-gigabyte source —
 * which is what makes deep seeks into huge files crash the core.
 *
 * For long-GOP or unparseable sources it falls back to mounting the whole file
 * via WORKERFS and fast input seeking (`-ss` before `-i`). The single-threaded
 * core can still abort on that path, so each decode is guarded by a watchdog
 * and the whole core is rebuilt on failure via {@link reset}.
 */
export class FrameExtractor {
  private ffmpeg = new FFmpeg();
  private inputPath = "";
  private file?: File;
  private loaded = false;
  private mounted = false;
  /** Present when the fast MOV-index slice path is usable for this source. */
  private index?: MovIndex;

  /** Load the ffmpeg core and prepare the source video for extraction. */
  async init(file: File): Promise<void> {
    this.file = file;
    await this.load();

    // Prefer the MOV-index slice path for all-intra codecs; fall back to a
    // full-file WORKERFS mount for anything we cannot parse or cannot decode
    // one frame at a time (e.g. long-GOP H.264/H.265).
    this.index = undefined;
    try {
      const idx = await parseMovIndex(file);
      if (isAllIntra(idx.format)) this.index = idx;
    } catch (err) {
      console.warn("MOV index unavailable; using full-file seeking.", err);
    }

    if (!this.index) await this.mount(file);
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    await this.ffmpeg.load({
      coreURL: coreAsset("ffmpeg-core.js"),
      wasmURL: coreAsset("ffmpeg-core.wasm"),
    });
    this.loaded = true;
  }

  private async mount(file: File): Promise<void> {
    await this.ffmpeg.createDir(MOUNT_DIR).catch(() => {});
    await this.ffmpeg.mount(FFFSType.WORKERFS, { files: [file] }, MOUNT_DIR);
    this.mounted = true;
    this.inputPath = `${MOUNT_DIR}/${file.name}`;
  }

  /**
   * Tear down a (possibly crashed) core and build a fresh one prepared for the
   * same source. Used between decode chunks to reclaim decoder memory and to
   * recover after a failed decode — a worker whose runtime has aborted cannot
   * be reused.
   */
  async reset(): Promise<void> {
    const file = this.file;
    const index = this.index;
    this.terminate();
    this.ffmpeg = new FFmpeg();
    this.loaded = false;
    this.mounted = false;
    if (!file) return;
    await this.load();
    this.index = index;
    if (!index) await this.mount(file);
  }

  /**
   * Extract one background frame per timestamp (in `seconds`), returning a JPEG
   * `data:` URL for each, or `undefined` where a frame could not be decoded.
   */
  async extractFrames(
    secondsList: number[],
    onProgress?: FrameProgress,
    timeoutMs = 30000,
  ): Promise<(string | undefined)[]> {
    if (this.index && this.file) {
      return this.extractAllViaSlice(secondsList, this.index, this.file, onProgress, timeoutMs);
    }
    return this.extractAllViaSeek(secondsList, onProgress, timeoutMs);
  }

  /**
   * Slice every requested coded frame out of the source, batch each chunk into
   * one synthetic `.mov`, and decode the chunk in a single ffmpeg pass. The
   * decoder only ever sees a few hundred KB at offset ~0, so deep frames decode
   * exactly like shallow ones.
   */
  private async extractAllViaSlice(
    list: number[],
    index: MovIndex,
    file: File,
    onProgress: FrameProgress | undefined,
    timeoutMs: number,
  ): Promise<(string | undefined)[]> {
    const results = new Array<string | undefined>(list.length).fill(undefined);
    let done = 0;
    for (let start = 0; start < list.length; start += SLICE_CHUNK) {
      if (start > 0) await this.reset(); // fresh core bounds decoder memory
      const group = list.slice(start, start + SLICE_CHUNK);
      try {
        const urls = await this.decodeGroup(group, index, file, timeoutMs);
        for (let i = 0; i < urls.length; i++) results[start + i] = urls[i];
      } catch (err) {
        // The chunk failed; those slides keep a solid background.
        console.warn(`Frame batch starting at ${start + 1} could not be decoded:`, err);
      }
      done += group.length;
      onProgress?.(done, list.length);
    }
    return results;
  }

  /** Build the chunk's `.mov`, decode it in one pass, and read out each JPEG. */
  private async decodeGroup(
    group: number[],
    index: MovIndex,
    file: File,
    timeoutMs: number,
  ): Promise<string[]> {
    const samples: Array<{ bytes: Uint8Array; delta: number }> = [];
    for (const seconds of group) {
      const loc = locateSample(index, Math.max(0, seconds));
      const bytes = new Uint8Array(
        await file.slice(loc.offset, loc.offset + loc.size).arrayBuffer(),
      );
      samples.push({ bytes, delta: loc.delta });
    }

    const input = "batch.mov";
    await this.ffmpeg.writeFile(input, buildSampleMov(index, samples));
    try {
      await this.runGuarded(
        ["-i", input, "-vf", `scale=${FRAME_WIDTH}:-2`, "-q:v", "4", "-y", "f_%03d.jpg"],
        group[0],
        timeoutMs,
      );
    } finally {
      await this.ffmpeg.deleteFile(input).catch(() => {});
    }

    const urls: string[] = [];
    for (let i = 0; i < group.length; i++) {
      const name = `f_${String(i + 1).padStart(3, "0")}.jpg`;
      urls.push(await this.readJpeg(name));
    }
    return urls;
  }

  /**
   * Fall-back path: fast input seeking into the WORKERFS-mounted source, one
   * frame at a time, rebuilding the core after any failure.
   */
  private async extractAllViaSeek(
    list: number[],
    onProgress: FrameProgress | undefined,
    timeoutMs: number,
  ): Promise<(string | undefined)[]> {
    const results = new Array<string | undefined>(list.length).fill(undefined);
    for (let i = 0; i < list.length; i++) {
      const seconds = Math.max(0, list[i]);
      try {
        await this.runGuarded(
          ["-ss", seconds.toFixed(3), "-i", this.inputPath, "-frames:v", "1",
            "-vf", `scale=${FRAME_WIDTH}:-2`, "-q:v", "4", "-y", "f_001.jpg"],
          seconds,
          timeoutMs,
        );
        results[i] = await this.readJpeg("f_001.jpg");
      } catch (err) {
        console.warn(`Frame ${i + 1} could not be decoded:`, err);
        if (i < list.length - 1) await this.reset();
      }
      onProgress?.(i + 1, list.length);
    }
    return results;
  }

  /** Run an ffmpeg command, aborting (and reporting) if it hangs. */
  private async runGuarded(args: string[], seconds: number, timeoutMs: number): Promise<void> {
    // A crashed ffmpeg worker never replies, so race the decode against a
    // watchdog that aborts the pending call.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      await this.ffmpeg.exec(args, -1, { signal: controller.signal });
    } catch {
      throw new FrameTimeoutError(seconds);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Read a decoded JPEG out of the ffmpeg FS and return it as a `data:` URL. */
  private async readJpeg(name: string): Promise<string> {
    const data = (await this.ffmpeg.readFile(name)) as Uint8Array;
    await this.ffmpeg.deleteFile(name).catch(() => {});
    // Copy into a plain ArrayBuffer-backed view (the ffmpeg buffer may be
    // SharedArrayBuffer-backed, which Blob does not accept).
    const bytes = new Uint8Array(data.byteLength);
    bytes.set(data);
    return blobToDataUrl(new Blob([bytes], { type: "image/jpeg" }));
  }

  /** Release ffmpeg resources. */
  terminate(): void {
    if (this.mounted) {
      this.ffmpeg.unmount(MOUNT_DIR).catch(() => {});
      this.mounted = false;
    }
    if (this.loaded) this.ffmpeg.terminate();
    this.loaded = false;
  }
}

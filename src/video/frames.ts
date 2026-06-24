import { FFmpeg, FFFSType } from "@ffmpeg/ffmpeg";

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

/** Raised when a frame could not be decoded within the allotted time. */
export class FrameTimeoutError extends Error {
  constructor(seconds: number) {
    super(`Timed out decoding the frame at ${seconds.toFixed(2)}s.`);
    this.name = "FrameTimeoutError";
  }
}

/**
 * Decodes single frames from an uploaded video entirely in the browser using
 * ffmpeg.wasm. Handles professional codecs (e.g. ProRes) that the native
 * `<video>` element cannot.
 *
 * The video is mounted via WORKERFS (which reads the underlying File lazily by
 * slicing), so multi-gigabyte sources work without loading the whole file into
 * memory.
 *
 * The single-threaded ffmpeg core can abort its WebAssembly runtime ("memory
 * access out of bounds") while seeking deep into very large sources. A crashed
 * worker never resolves its pending call, so every decode is guarded by a
 * watchdog and the whole core is rebuilt on failure via {@link reset}.
 */
export class FrameExtractor {
  private ffmpeg = new FFmpeg();
  private inputPath = "";
  private file?: File;
  private loaded = false;
  private mounted = false;

  /** Load the ffmpeg core and mount the source video into its filesystem. */
  async init(file: File): Promise<void> {
    this.file = file;
    if (!this.loaded) {
      await this.ffmpeg.load({
        coreURL: coreAsset("ffmpeg-core.js"),
        wasmURL: coreAsset("ffmpeg-core.wasm"),
      });
      this.loaded = true;
    }
    await this.ffmpeg.createDir(MOUNT_DIR).catch(() => {});
    await this.ffmpeg.mount(FFFSType.WORKERFS, { files: [file] }, MOUNT_DIR);
    this.mounted = true;
    this.inputPath = `${MOUNT_DIR}/${file.name}`;
  }

  /**
   * Tear down a (possibly crashed) core and build a fresh one mounted to the
   * same source. Call this after a failed {@link extractFrame} before decoding
   * any further frames — a worker whose runtime has aborted cannot recover.
   */
  async reset(): Promise<void> {
    const file = this.file;
    this.terminate();
    this.ffmpeg = new FFmpeg();
    this.loaded = false;
    this.mounted = false;
    if (file) await this.init(file);
  }

  /**
   * Extract a single JPEG frame at `seconds` into the video and return it as a
   * `data:` URL. Uses fast input seeking (`-ss` before `-i`).
   *
   * Rejects with {@link FrameTimeoutError} if the decode does not finish within
   * `timeoutMs` (the core has almost certainly crashed); the caller should then
   * {@link reset} before extracting the next frame.
   */
  async extractFrame(seconds: number, timeoutMs = 20000): Promise<string> {
    const t = Math.max(0, seconds);
    const out = "frame.jpg";

    // A crashed ffmpeg worker never replies, so race the decode against a
    // watchdog that aborts the pending call.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      await this.ffmpeg.exec(
        [
          "-ss",
          t.toFixed(3),
          "-i",
          this.inputPath,
          "-frames:v",
          "1",
          "-q:v",
          "3",
          "-y",
          out,
        ],
        -1,
        { signal: controller.signal },
      );
    } catch {
      throw new FrameTimeoutError(t);
    } finally {
      clearTimeout(timer);
    }

    const data = (await this.ffmpeg.readFile(out)) as Uint8Array;
    await this.ffmpeg.deleteFile(out).catch(() => {});
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

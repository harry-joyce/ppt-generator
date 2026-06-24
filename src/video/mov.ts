/**
 * Minimal QuickTime/MOV container reader and writer used to pull a single coded
 * frame out of a multi-gigabyte source without seeking inside it.
 *
 * The strategy: parse the `moov` index in JavaScript, compute the exact byte
 * range of one sample, `Blob.slice()` it out of the `File`, then synthesise a
 * tiny self-contained `.mov` around those bytes. The tiny file is what gets fed
 * to ffmpeg.wasm, so the decoder only ever seeks at offset ~0 and never trips
 * the "memory access out of bounds" crash that deep seeks cause.
 *
 * Only all-intra codecs (ProRes, DNxHD/HR …) can be decoded one frame at a
 * time; see {@link isAllIntra}.
 */

/** Codecs whose every sample is independently decodable (all-intra). */
const ALL_INTRA = new Set([
  "apcn", // ProRes 422
  "apch", // ProRes 422 HQ
  "apcs", // ProRes 422 LT
  "apco", // ProRes 422 Proxy
  "ap4h", // ProRes 4444
  "ap4x", // ProRes 4444 XQ
  "AVdn", // DNxHD / DNxHR
  "AVdh",
]);

/** True when a `stsd` format 4cc identifies an all-intra codec. */
export function isAllIntra(format: string): boolean {
  return ALL_INTRA.has(format);
}

interface SttsRun {
  count: number;
  delta: number;
}

interface StscRun {
  firstChunk: number; // 1-based
  samplesPerChunk: number;
  descIndex: number;
}

/** Parsed index of the video track needed to locate any sample. */
export interface MovIndex {
  /** Video sample-entry 4cc, e.g. `apch`. */
  format: string;
  /** The `stsd` sample-entry bytes, copied verbatim (carries colr/fiel/pasp). */
  sampleEntry: Uint8Array;
  width: number;
  height: number;
  /** Media timescale (units per second). */
  timescale: number;
  /** Total media duration in timescale units. */
  duration: number;
  sampleCount: number;
  stts: SttsRun[];
  stsc: StscRun[];
  /** Uniform sample size, or 0 when per-sample sizes are used. */
  uniformSampleSize: number;
  /** Per-sample sizes (length 0 when {@link uniformSampleSize} is non-zero). */
  sampleSizes: number[];
  /** Absolute file offset of each chunk. */
  chunkOffsets: number[];
}

/** A located sample's byte range within the source file. */
export interface SampleLocation {
  index: number;
  offset: number;
  size: number;
  /** Duration of this sample in timescale units. */
  delta: number;
}

// --- Binary readers ---------------------------------------------------------

function u32(b: Uint8Array, o: number): number {
  return b[o] * 0x1000000 + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
}

function u16(b: Uint8Array, o: number): number {
  return (b[o] << 8) + b[o + 1];
}

function u64(b: Uint8Array, o: number): number {
  // Safe for offsets well under 2^53 (file sizes up to ~9 PB).
  return u32(b, o) * 0x100000000 + u32(b, o + 4);
}

function fourcc(b: Uint8Array, o: number): string {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}

async function sliceBytes(file: Blob, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

interface Atom {
  type: string;
  /** Offset of the atom header within its buffer/file. */
  start: number;
  /** Offset of the atom payload (after the header). */
  dataStart: number;
  /** Offset just past the atom. */
  end: number;
}

/** Walk the immediate child atoms within `[start, end)` of an in-memory buffer. */
function* childAtoms(buf: Uint8Array, start: number, end: number): Generator<Atom> {
  let p = start;
  while (p + 8 <= end) {
    let size = u32(buf, p);
    const type = fourcc(buf, p + 4);
    let headerSize = 8;
    if (size === 1) {
      size = u64(buf, p + 8);
      headerSize = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < headerSize || p + size > end) break;
    yield { type, start: p, dataStart: p + headerSize, end: p + size };
    p += size;
  }
}

function findChild(buf: Uint8Array, start: number, end: number, type: string): Atom | undefined {
  for (const atom of childAtoms(buf, start, end)) {
    if (atom.type === type) return atom;
  }
  return undefined;
}

// --- Top-level walk (reads the file lazily, never loads mdat) ----------------

/** Locate the `moov` atom by walking top-level headers, skipping `mdat` by size. */
async function findMoov(file: File): Promise<Atom> {
  let pos = 0;
  const fileSize = file.size;
  while (pos + 8 <= fileSize) {
    const header = await sliceBytes(file, pos, Math.min(pos + 16, fileSize));
    let size = u32(header, 0);
    const type = fourcc(header, 4);
    let headerSize = 8;
    if (size === 1) {
      size = u64(header, 8);
      headerSize = 16;
    } else if (size === 0) {
      size = fileSize - pos;
    }
    if (type === "moov") {
      return { type, start: pos, dataStart: pos + headerSize, end: pos + size };
    }
    if (size < headerSize) break;
    pos += size;
  }
  throw new Error("moov atom not found");
}

// --- moov parsing -----------------------------------------------------------

/** Parse the source file's `moov` index for its first video track. */
export async function parseMovIndex(file: File): Promise<MovIndex> {
  const moovAtom = await findMoov(file);
  const moov = await sliceBytes(file, moovAtom.start, moovAtom.end);
  // Re-walk inside the in-memory buffer (header is at offset 0).
  const root = childAtoms(moov, 0, moov.length).next().value as Atom | undefined;
  if (!root || root.type !== "moov") throw new Error("invalid moov");

  for (const trak of childAtoms(moov, root.dataStart, root.end)) {
    if (trak.type !== "trak") continue;
    const mdia = findChild(moov, trak.dataStart, trak.end, "mdia");
    if (!mdia) continue;
    const hdlr = findChild(moov, mdia.dataStart, mdia.end, "hdlr");
    if (!hdlr || fourcc(moov, hdlr.dataStart + 8) !== "vide") continue;

    return parseVideoTrak(moov, trak, mdia);
  }
  throw new Error("no video track found");
}

function parseVideoTrak(moov: Uint8Array, trak: Atom, mdia: Atom): MovIndex {
  const mdhd = findChild(moov, mdia.dataStart, mdia.end, "mdhd");
  if (!mdhd) throw new Error("missing mdhd");
  const version = moov[mdhd.dataStart];
  let p = mdhd.dataStart + 4; // skip version + flags
  let timescale: number;
  let duration: number;
  if (version === 1) {
    p += 16; // creation + modification (8 each)
    timescale = u32(moov, p);
    duration = u64(moov, p + 4);
  } else {
    p += 8; // creation + modification (4 each)
    timescale = u32(moov, p);
    duration = u32(moov, p + 4);
  }

  const minf = findChild(moov, mdia.dataStart, mdia.end, "minf");
  if (!minf) throw new Error("missing minf");
  const stbl = findChild(moov, minf.dataStart, minf.end, "stbl");
  if (!stbl) throw new Error("missing stbl");

  const stsd = required(moov, stbl, "stsd");
  const stts = required(moov, stbl, "stts");
  const stsc = required(moov, stbl, "stsc");
  const stsz = findChild(moov, stbl.dataStart, stbl.end, "stsz");
  const stz2 = findChild(moov, stbl.dataStart, stbl.end, "stz2");
  const stco = findChild(moov, stbl.dataStart, stbl.end, "stco");
  const co64 = findChild(moov, stbl.dataStart, stbl.end, "co64");

  // stsd: version+flags(4) + entry_count(4), then the first sample entry.
  const entryStart = stsd.dataStart + 8;
  const entrySize = u32(moov, entryStart);
  const sampleEntry = moov.slice(entryStart, entryStart + entrySize);
  const format = fourcc(moov, entryStart + 4);
  const width = u16(moov, entryStart + 32);
  const height = u16(moov, entryStart + 34);

  // stts.
  const sttsCount = u32(moov, stts.dataStart + 4);
  const sttsRuns: SttsRun[] = [];
  let q = stts.dataStart + 8;
  for (let i = 0; i < sttsCount; i++, q += 8) {
    sttsRuns.push({ count: u32(moov, q), delta: u32(moov, q + 4) });
  }

  // stsc.
  const stscCount = u32(moov, stsc.dataStart + 4);
  const stscRuns: StscRun[] = [];
  q = stsc.dataStart + 8;
  for (let i = 0; i < stscCount; i++, q += 12) {
    stscRuns.push({
      firstChunk: u32(moov, q),
      samplesPerChunk: u32(moov, q + 4),
      descIndex: u32(moov, q + 8),
    });
  }

  // stsz / stz2.
  let uniformSampleSize = 0;
  let sampleSizes: number[] = [];
  let sampleCount = 0;
  if (stsz) {
    uniformSampleSize = u32(moov, stsz.dataStart + 4);
    sampleCount = u32(moov, stsz.dataStart + 8);
    if (uniformSampleSize === 0) {
      q = stsz.dataStart + 12;
      sampleSizes = new Array(sampleCount);
      for (let i = 0; i < sampleCount; i++, q += 4) sampleSizes[i] = u32(moov, q);
    }
  } else if (stz2) {
    const fieldSize = moov[stz2.dataStart + 7];
    sampleCount = u32(moov, stz2.dataStart + 8);
    sampleSizes = new Array(sampleCount);
    q = stz2.dataStart + 12;
    if (fieldSize === 16) {
      for (let i = 0; i < sampleCount; i++, q += 2) sampleSizes[i] = u16(moov, q);
    } else if (fieldSize === 8) {
      for (let i = 0; i < sampleCount; i++, q += 1) sampleSizes[i] = moov[q];
    } else if (fieldSize === 4) {
      for (let i = 0; i < sampleCount; i++) {
        const byte = moov[q + (i >> 1)];
        sampleSizes[i] = i & 1 ? byte & 0x0f : byte >> 4;
      }
    } else {
      throw new Error(`unsupported stz2 field size ${fieldSize}`);
    }
  } else {
    throw new Error("missing stsz/stz2");
  }

  // stco / co64.
  const chunkOffsets: number[] = [];
  if (co64) {
    const n = u32(moov, co64.dataStart + 4);
    q = co64.dataStart + 8;
    for (let i = 0; i < n; i++, q += 8) chunkOffsets.push(u64(moov, q));
  } else if (stco) {
    const n = u32(moov, stco.dataStart + 4);
    q = stco.dataStart + 8;
    for (let i = 0; i < n; i++, q += 4) chunkOffsets.push(u32(moov, q));
  } else {
    throw new Error("missing stco/co64");
  }

  void trak;
  return {
    format,
    sampleEntry,
    width,
    height,
    timescale,
    duration,
    sampleCount,
    stts: sttsRuns,
    stsc: stscRuns,
    uniformSampleSize,
    sampleSizes,
    chunkOffsets,
  };
}

function required(moov: Uint8Array, stbl: Atom, type: string): Atom {
  const atom = findChild(moov, stbl.dataStart, stbl.end, type);
  if (!atom) throw new Error(`missing ${type}`);
  return atom;
}

// --- Sample location --------------------------------------------------------

function sampleSizeOf(idx: MovIndex, sample: number): number {
  return idx.uniformSampleSize || idx.sampleSizes[sample];
}

function sampleDeltaOf(idx: MovIndex, sample: number): number {
  let s = 0;
  for (const run of idx.stts) {
    if (sample < s + run.count) return run.delta;
    s += run.count;
  }
  return idx.stts.length ? idx.stts[idx.stts.length - 1].delta : 0;
}

/** Find the sample index whose media time covers `seconds`. */
function sampleAtTime(idx: MovIndex, seconds: number): number {
  const mediaTime = Math.round(seconds * idx.timescale);
  let sample = 0;
  let time = 0;
  for (const run of idx.stts) {
    const runDur = run.count * run.delta;
    if (mediaTime < time + runDur) {
      return sample + Math.floor((mediaTime - time) / run.delta);
    }
    time += runDur;
    sample += run.count;
  }
  return idx.sampleCount - 1;
}

/** Resolve a sample index to its absolute file offset and size. */
function sampleByteRange(idx: MovIndex, sampleIndex: number): { offset: number; size: number } {
  const numChunks = idx.chunkOffsets.length;
  let sampleBase = 0;
  for (let i = 0; i < idx.stsc.length; i++) {
    const { firstChunk, samplesPerChunk } = idx.stsc[i];
    const nextFirst = i + 1 < idx.stsc.length ? idx.stsc[i + 1].firstChunk : numChunks + 1;
    const samplesInRun = (nextFirst - firstChunk) * samplesPerChunk;
    if (sampleIndex < sampleBase + samplesInRun) {
      const within = sampleIndex - sampleBase;
      const chunkInRun = Math.floor(within / samplesPerChunk);
      const chunkIndex = firstChunk + chunkInRun; // 1-based
      const sampleInChunk = within - chunkInRun * samplesPerChunk;
      const firstSampleOfChunk = sampleIndex - sampleInChunk;
      let offset = idx.chunkOffsets[chunkIndex - 1];
      for (let s = firstSampleOfChunk; s < sampleIndex; s++) offset += sampleSizeOf(idx, s);
      return { offset, size: sampleSizeOf(idx, sampleIndex) };
    }
    sampleBase += samplesInRun;
  }
  throw new Error(`sample ${sampleIndex} out of range`);
}

/** Locate the sample to extract for a playback time in seconds. */
export function locateSample(idx: MovIndex, seconds: number): SampleLocation {
  let index = sampleAtTime(idx, Math.max(0, seconds));
  index = Math.min(Math.max(index, 0), idx.sampleCount - 1);
  const { offset, size } = sampleByteRange(idx, index);
  return { index, offset, size, delta: sampleDeltaOf(idx, index) };
}

// --- Minimal single-sample .mov synthesis -----------------------------------

function str4(s: string): Uint8Array {
  return new Uint8Array([s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)]);
}

function be32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0);
  return b;
}

function be16(n: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n & 0xffff);
  return b;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = concat(payload);
  return concat([be32(body.length + 8), str4(type), body]);
}

/** 3×3 video transformation matrix (identity), 9 × 16.16 fixed-point. */
const IDENTITY_MATRIX = concat([
  be32(0x00010000), be32(0), be32(0),
  be32(0), be32(0x00010000), be32(0),
  be32(0), be32(0), be32(0x40000000),
]);

/**
 * Build a self-contained `.mov` around one or more coded frames, reusing the
 * source track's sample-entry, timescale and dimensions. All samples are placed
 * in a single chunk in the order given; decoding the result yields the frames
 * in that same order. Used to extract many frames in a single ffmpeg pass — the
 * single-threaded ffmpeg.wasm core hangs if `exec` is called repeatedly, so all
 * frames are decoded together.
 */
export function buildSampleMov(
  idx: MovIndex,
  samples: Array<{ bytes: Uint8Array; delta: number }>,
): Uint8Array {
  const ftyp = box("ftyp", str4("qt  "), be32(0x00000200), str4("qt  "));
  const mdat = box("mdat", ...samples.map((s) => s.bytes));
  // Sample data sits just past the ftyp + mdat header in the output file.
  const mdatDataOffset = ftyp.length + 8;
  const totalDuration = samples.reduce((n, s) => n + s.delta, 0);

  const mvhd = box(
    "mvhd",
    be32(0), // version + flags
    be32(0), be32(0), // creation, modification
    be32(idx.timescale),
    be32(totalDuration),
    be32(0x00010000), // rate 1.0
    be16(0x0100), // volume 1.0
    be16(0), be32(0), be32(0), // reserved
    IDENTITY_MATRIX,
    concat([be32(0), be32(0), be32(0), be32(0), be32(0), be32(0)]), // predefined
    be32(2), // next track id
  );

  const tkhd = box(
    "tkhd",
    be32(0x00000007), // version 0, flags: enabled | in movie | in preview
    be32(0), be32(0), // creation, modification
    be32(1), // track id
    be32(0), // reserved
    be32(totalDuration),
    be32(0), be32(0), // reserved
    be16(0), // layer
    be16(0), // alternate group
    be16(0), // volume (0 for video)
    be16(0), // reserved
    IDENTITY_MATRIX,
    be32(idx.width << 16),
    be32(idx.height << 16),
  );

  const mdhd = box(
    "mdhd",
    be32(0), // version + flags
    be32(0), be32(0), // creation, modification
    be32(idx.timescale),
    be32(totalDuration),
    be16(0x55c4), // language 'und'
    be16(0), // quality
  );

  const hdlr = box(
    "hdlr",
    be32(0), // version + flags
    be32(0), // predefined
    str4("vide"),
    be32(0), be32(0), be32(0), // reserved
    new Uint8Array([0]), // empty handler name
  );

  const vmhd = box(
    "vmhd",
    be32(0x00000001), // version + flags
    be16(0), be16(0), be16(0), be16(0), // graphics mode + opcolor
  );

  const dref = box(
    "dref",
    be32(0), // version + flags
    be32(1), // entry count
    box("url ", be32(0x00000001)), // self-contained
  );
  const dinf = box("dinf", dref);

  const stsd = box(
    "stsd",
    be32(0), // version + flags
    be32(1), // entry count
    idx.sampleEntry,
  );
  // One time-to-sample entry per sample keeps presentation order explicit.
  const sttsEntries = samples.flatMap((s) => [be32(1), be32(s.delta)]);
  const stts = box("stts", be32(0), be32(samples.length), ...sttsEntries);
  // A single chunk holding every sample, contiguous in the mdat.
  const stsc = box("stsc", be32(0), be32(1), be32(1), be32(samples.length), be32(1));
  const stsz = box(
    "stsz",
    be32(0),
    be32(0), // sample size (0 = table)
    be32(samples.length),
    ...samples.map((s) => be32(s.bytes.length)),
  );
  const stco = box("stco", be32(0), be32(1), be32(mdatDataOffset));
  const stbl = box("stbl", stsd, stts, stsc, stsz, stco);
  const minf = box("minf", vmhd, dinf, stbl);
  const mdia = box("mdia", mdhd, hdlr, minf);
  const trak = box("trak", tkhd, mdia);
  const moov = box("moov", mvhd, trak);

  return concat([ftyp, mdat, moov]);
}

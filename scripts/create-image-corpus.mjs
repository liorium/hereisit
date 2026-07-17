import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson, parseCliArguments } from "./image-lab-common.mjs";

const require = createRequire(import.meta.url);
const sharp = require("../apps/image-engine/node_modules/sharp");
const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const corpusRoot = join(root, "tests/image-corpus");
const publicRoot = join(corpusRoot, "public");
const manifestPath = join(corpusRoot, "manifest.json");
const glyphPath = join(corpusRoot, "glyphs/korean-basic.json");

const owned = Object.freeze({ owner: "HereIsIt", license: "HereIsIt-Owned-1.0", sourceUrl: null });

function seededBytes(width, height, channels, seed, kind = "photo") {
  const bytes = Buffer.allocUnsafe(width * height * channels);
  let state = seed >>> 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      const noise = state & 255;
      const offset = (y * width + x) * channels;
      if (kind === "gradient") {
        bytes[offset] = Math.round((x / Math.max(1, width - 1)) * 255);
        bytes[offset + 1] = Math.round((y / Math.max(1, height - 1)) * 255);
        bytes[offset + 2] = Math.round(((x + y) / Math.max(1, width + height - 2)) * 255);
      } else if (kind === "night") {
        bytes[offset] = Math.min(80, noise >> 2);
        bytes[offset + 1] = Math.min(95, ((noise + x) & 255) >> 2);
        bytes[offset + 2] = Math.min(150, ((noise + y * 3) & 255) >> 1);
      } else if (kind === "flat") {
        const block = ((x >> 4) + (y >> 4) * 3) % 5;
        bytes[offset] = [30, 45, 245, 250, 18][block];
        bytes[offset + 1] = [35, 190, 90, 180, 18][block];
        bytes[offset + 2] = [45, 230, 70, 30, 18][block];
      } else {
        bytes[offset] = (noise + x * 3 + y) & 255;
        bytes[offset + 1] = ((noise >> 1) + x + y * 2) & 255;
        bytes[offset + 2] = ((noise >> 2) + x * 2 + y * 3) & 255;
      }
      if (channels === 4) bytes[offset + 3] = kind === "alpha" ? (x * 7 + y * 11) & 255 : 255;
    }
  }
  return bytes;
}

function drawGlyphScene(width, height, glyphTable, variant) {
  const data = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    data[index * 4] = 255;
    data[index * 4 + 1] = 255;
    data[index * 4 + 2] = 255;
    data[index * 4 + 3] = variant === "logo" ? 0 : 255;
  }
  const glyphs = Object.values(glyphTable.glyphs);
  const scale = variant === "logo" ? 5 : 3;
  const ink = variant === "code" ? [40, 210, 130] : variant === "ui" ? [35, 45, 65] : [15, 15, 20];
  for (let line = 0; line < 4; line += 1) {
    for (let column = 0; column < 7; column += 1) {
      const glyph = glyphs[(line * 7 + column + variant.length) % glyphs.length];
      const originX = 16 + column * 27;
      const originY = 16 + line * 34;
      for (let row = 0; row < 7; row += 1) {
        for (let cell = 0; cell < 5; cell += 1) {
          if (glyph[row][cell] !== "1") continue;
          for (let sy = 0; sy < scale; sy += 1) {
            for (let sx = 0; sx < scale; sx += 1) {
              const x = originX + cell * scale + sx;
              const y = originY + row * scale + sy;
              if (x >= width || y >= height) continue;
              const offset = (y * width + x) * 4;
              data[offset] = ink[0];
              data[offset + 1] = ink[1];
              data[offset + 2] = ink[2];
              data[offset + 3] = 255;
            }
          }
        }
      }
    }
  }
  if (variant === "ui") {
    for (let y = height - 42; y < height - 14; y += 1) {
      for (let x = 18; x < width - 18; x += 1) {
        const offset = (y * width + x) * 4;
        data[offset] = 63;
        data[offset + 1] = 94;
        data[offset + 2] = 251;
      }
    }
  }
  return data;
}

const definitions = [
  ["photo-ordinary-jpeg", "jpeg", 640, 427, "photo", [], "photo", 11],
  ["photo-portrait-jpeg", "jpeg", 427, 640, "portrait", [], "photo", 12],
  ["photo-night-noisy-jpeg", "jpeg", 641, 429, "night-noisy", [], "night", 13],
  ["photo-oriented-jpeg", "jpeg", 321, 481, "photo", [], "photo", 14, { orientation: 6 }],
  ["photo-wide-gamut-jpeg", "jpeg", 513, 343, "photo", [], "photo", 15, { profile: "wide-gamut" }],
  ["photo-gray-jpeg", "jpeg", 511, 341, "photo", [], "photo", 16, { colorSpace: "gray" }],
  ["photo-cmyk-jpeg", "jpeg", 509, 339, "photo", [], "photo", 17, { colorSpace: "cmyk" }],
  [
    "photo-cmyk-profile-jpeg",
    "jpeg",
    507,
    337,
    "photo",
    [],
    "photo",
    18,
    { colorSpace: "cmyk", profile: "cmyk" },
  ],
  [
    "photo-ycck-jpeg",
    "jpeg",
    505,
    335,
    "photo",
    [],
    "photo",
    19,
    { colorSpace: "cmyk", adobeTransform: 2 },
  ],
  [
    "photo-conflicting-adobe-jpeg",
    "jpeg",
    503,
    333,
    "photo",
    [],
    "photo",
    20,
    { colorSpace: "cmyk", adobeTransform: 1 },
  ],
  ["korean-text-png", "png", 241, 167, "screenshot-text", ["korean-text"], "korean", 21],
  ["korean-text-webp", "webp", 243, 169, "screenshot-text", ["korean-text"], "korean", 22],
  ["korean-text-jpeg", "jpeg", 245, 171, "screenshot-text", ["korean-text"], "korean", 23],
  ["ui-controls-png", "png", 257, 181, "ui", ["ui"], "ui", 31],
  ["ui-controls-webp", "webp", 259, 183, "ui", ["ui"], "ui", 32],
  ["ui-controls-jpeg", "jpeg", 261, 185, "ui", ["ui"], "ui", 33],
  ["code-dark-png", "png", 263, 187, "code", ["code"], "code", 41],
  ["code-dark-webp", "webp", 265, 189, "code", ["code"], "code", 42],
  ["code-dark-jpeg", "jpeg", 267, 191, "code", ["code"], "code", 43],
  ["logo-alpha-png", "png", 269, 193, "logo", ["logo"], "logo", 51],
  ["logo-alpha-webp", "webp", 271, 195, "logo", ["logo"], "logo", 52],
  ["logo-flat-jpeg", "jpeg", 273, 197, "logo", ["logo"], "logo", 53],
  ["flat-graphic-png", "png", 275, 199, "flat-graphic", ["flat-graphic"], "flat", 61],
  ["flat-graphic-webp", "webp", 277, 201, "flat-graphic", ["flat-graphic"], "flat", 62],
  ["flat-graphic-jpeg", "jpeg", 279, 203, "flat-graphic", ["flat-graphic"], "flat", 63],
  ["korean-poster-png", "png", 281, 205, "screenshot-text", ["korean-text"], "korean", 64],
  ["ui-dialog-png", "png", 283, 207, "ui", ["ui"], "ui", 65],
  ["code-terminal-png", "png", 285, 209, "code", ["code"], "code", 66],
  ["logo-badge-png", "png", 287, 211, "logo", ["logo"], "logo", 67],
  ["flat-poster-png", "png", 289, 213, "flat-graphic", ["flat-graphic"], "flat", 68],
  ["gradient-png", "png", 291, 215, "gradient", [], "gradient", 71],
  ["illustration-webp", "webp", 293, 217, "illustration", [], "flat", 72],
  ["transparent-fringe-png", "png", 295, 219, "illustration", [], "alpha", 73],
  ["transparent-fringe-webp", "webp", 297, 221, "illustration", [], "alpha", 74],
  ["gradient-16bit-png", "png", 299, 223, "gradient", [], "gradient", 75, { bitDepth: 16 }],
  ["odd-large-png", "png", 2049, 1501, "photo", [], "gradient", 81],
  ["medium-noise-png", "png", 1024, 1024, "photo", [], "photo", 82],
  ["large-noise-png", "png", 2048, 2048, "photo", [], "photo", 83],
  ["already-optimized-webp", "webp", 319, 213, "photo", [], "photo", 84],
];

async function encodeDefinition(definition, glyphTable) {
  const [id, format, width, height, contentClass, strategicTags, pattern, seed, options = {}] =
    definition;
  const channels = pattern === "alpha" || (pattern === "logo" && format !== "jpeg") ? 4 : 3;
  let raw;
  if (["korean", "ui", "code", "logo"].includes(pattern)) {
    raw = drawGlyphScene(width, height, glyphTable, pattern === "korean" ? "text" : pattern);
  } else {
    raw = seededBytes(width, height, channels, seed, pattern);
  }
  let pipeline = sharp(raw, {
    raw: { width, height, channels: raw.length === width * height * 4 ? 4 : 3 },
  });
  if (channels === 3 && raw.length === width * height * 4) pipeline = pipeline.removeAlpha();
  if (options.orientation) pipeline = pipeline.withMetadata({ orientation: options.orientation });
  if (options.colorSpace === "gray") pipeline = pipeline.greyscale();
  if (options.colorSpace === "cmyk") pipeline = pipeline.toColourspace("cmyk");
  if (options.bitDepth === 16) pipeline = pipeline.toColourspace("rgb16");
  if (options.profile === "wide-gamut") pipeline = pipeline.withIccProfile("p3");
  if (options.profile === "cmyk") pipeline = pipeline.withIccProfile("cmyk");
  if (format === "jpeg")
    pipeline = pipeline.jpeg({
      quality: id === "already-optimized-webp" ? 88 : 91,
      chromaSubsampling: "4:4:4",
      mozjpeg: false,
    });
  if (format === "png")
    pipeline = pipeline.png({
      compressionLevel: 9,
      adaptiveFiltering: false,
      ...(options.bitDepth === 16 ? { bitdepth: 16 } : {}),
    });
  if (format === "webp") pipeline = pipeline.webp({ quality: 88, effort: 6, smartSubsample: true });
  const bytes = Buffer.from(await pipeline.toBuffer());
  if (options.adobeTransform !== undefined) {
    const marker = bytes.indexOf(Buffer.from("Adobe"));
    if (marker < 0) throw new Error("generated CMYK JPEG has no Adobe marker");
    bytes[marker + 11] = options.adobeTransform;
  }
  return {
    id,
    extension: format === "jpeg" ? "jpg" : format,
    bytes,
    entry: {
      id,
      relativePath: "",
      sha256: "",
      provenance: owned,
      expected: {
        format,
        width,
        height,
        bitDepth: options.bitDepth ?? 8,
        alpha: channels === 4,
        orientation: options.orientation ?? 1,
        profile:
          options.profile === "cmyk"
            ? "wide-gamut"
            : options.colorSpace === "cmyk"
              ? "none"
              : (options.profile ?? "srgb"),
        animated: false,
        class: contentClass,
      },
      strategicTags,
      assertions: ["signature", "dimensions", ...(channels === 4 ? ["alpha-composite"] : [])],
    },
  };
}

function adversarialFixtures() {
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const bomb = Buffer.alloc(33);
  pngSignature.copy(bomb);
  bomb.writeUInt32BE(13, 8);
  bomb.write("IHDR", 12, "ascii");
  bomb.writeUInt32BE(0x7fffffff, 16);
  bomb.writeUInt32BE(0x7fffffff, 20);
  bomb[24] = 8;
  bomb[25] = 6;
  return [
    [
      "malformed-png",
      Buffer.concat([pngSignature, Buffer.from("not-a-valid-chunk")]),
      "malformed",
      1,
      1,
    ],
    ["truncated-jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]), "truncated", 1, 1],
    ["bomb-declaration-png", bomb, "bomb-regression", 0x7fffffff, 0x7fffffff],
  ].map(([id, bytes, contentClass, width, height]) => ({
    id,
    extension: id.endsWith("jpeg") ? "jpg" : "png",
    bytes,
    entry: {
      id,
      relativePath: "",
      sha256: "",
      provenance: owned,
      expected: {
        format: id.endsWith("jpeg") ? "jpeg" : "png",
        width,
        height,
        bitDepth: 8,
        alpha: id.includes("png"),
        orientation: 1,
        profile: "none",
        animated: false,
        class: contentClass,
      },
      strategicTags: [],
      assertions: ["bounded-rejection", "no-declared-pixel-allocation"],
    },
  }));
}

function requiredStrata() {
  return [
    ["jpeg-tiny-opaque-photo", "jpeg", "tiny", false, "photo"],
    ["png-tiny-opaque-flat", "png", "tiny", false, "flat-graphic"],
    ["png-tiny-alpha-logo", "png", "tiny", true, "logo"],
    ["webp-tiny-opaque-ui", "webp", "tiny", false, "ui"],
    ["webp-tiny-alpha-logo", "webp", "tiny", true, "logo"],
  ].map(([id, mime, sizeBand, alpha, contentClass]) => ({
    id,
    mime,
    sizeBand,
    alpha,
    contentClass,
    minimumSuccessfulSamples: 3,
  }));
}

export async function createImageCorpus({ verifyClean = false } = {}) {
  const glyphTable = JSON.parse(await readFile(glyphPath, "utf8"));
  const generated = [];
  for (const definition of definitions)
    generated.push(await encodeDefinition(definition, glyphTable));
  generated.push(...adversarialFixtures());
  for (const fixture of generated) {
    fixture.entry.relativePath = `public/${fixture.id}.${fixture.extension}`;
    fixture.entry.sha256 = createHash("sha256").update(fixture.bytes).digest("hex");
  }
  const manifest = {
    version: 1,
    entries: generated.map((fixture) => fixture.entry),
    requiredStrata: requiredStrata(),
  };
  if (verifyClean) {
    const existing = await readFile(manifestPath, "utf8").catch(() => null);
    if (existing === null || canonicalJson(JSON.parse(existing)) !== canonicalJson(manifest))
      throw new Error("image corpus drift detected; regenerate and review the committed corpus");
    for (const fixture of generated) {
      const actual = await readFile(join(corpusRoot, fixture.entry.relativePath)).catch(() => null);
      if (actual === null || !actual.equals(fixture.bytes))
        throw new Error(`image corpus drift detected for ${fixture.id}`);
    }
    return manifest;
  }
  await rm(publicRoot, { recursive: true, force: true });
  await mkdir(publicRoot, { recursive: true });
  for (const fixture of generated)
    await writeFile(join(corpusRoot, fixture.entry.relativePath), fixture.bytes);
  await writeFile(manifestPath, canonicalJson(manifest));
  return manifest;
}

async function main() {
  const args = parseCliArguments(
    process.argv.slice(2).filter((value) => value !== "--verify-clean"),
  );
  const verifyClean = process.argv.slice(2).includes("--verify-clean");
  const permitted = new Set(["runtime-image"]);
  for (const key of Object.keys(args))
    if (!permitted.has(key)) throw new TypeError(`unknown argument --${key}`);
  const manifest = await createImageCorpus({ verifyClean });
  process.stdout.write(
    `${JSON.stringify({ entries: manifest.entries.length, verified: verifyClean })}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

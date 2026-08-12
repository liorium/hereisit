import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";
import {
  decodePDFRawStream,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFString,
  rgb,
  StandardFonts,
} from "@cantoo/pdf-lib";
import {
  assertExactKeys,
  assertObject,
  assertSha256,
  canonicalJson,
  parseCliArguments,
} from "./image-lab-common.mjs";

export const REQUIRED_PDF_CORPUS_STRATA = Object.freeze([
  "text-vector",
  "link",
  "annotation",
  "form",
  "outline",
  "attachment",
  "layer",
  "duplicate-resource",
  "flate-heavy",
  "jpeg-heavy",
  "non-jpeg-image",
  "scan",
  "mixed",
  "encrypted",
  "corrupt",
  "expansion",
  "decompression-bomb",
]);

const SCHEMA = "hereisit.pdf-compression-corpus@1";
const GENERATOR = "hereisit-pdf-corpus@1";
const SEED = 2_026_081_100;
const MAX_CORPUS_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_PAGES = 100;
const SAFE_TOKEN = /^HIS_[A-Z0-9_]{3,48}$/u;
const VERDICTS = new Set(["measure", "reject", "original-retained"]);

function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new TypeError(`${label} is invalid`);
  return value;
}

function exactString(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function hasLeak(value) {
  return /(?:https?:\/\/|file:\/\/|(?:^|[\\/])(?:home|tmp|users|private)(?:[\\/]|$)|\.\.[\\/])/iu.test(
    value,
  );
}

export function validatePdfCorpusManifest(raw) {
  const manifest = assertObject(raw, "PDF corpus manifest");
  assertExactKeys(
    manifest,
    ["schema", "generator", "seed", "limits", "entries"],
    "PDF corpus manifest",
  );
  if (manifest.schema !== SCHEMA || manifest.generator !== GENERATOR || manifest.seed !== SEED)
    throw new TypeError("PDF corpus identity is invalid");
  const limits = assertObject(manifest.limits, "PDF corpus limits");
  assertExactKeys(
    limits,
    ["maximumCorpusBytes", "maximumFileBytes", "maximumPages", "maximumInflatedBytes"],
    "PDF corpus limits",
  );
  integer(limits.maximumCorpusBytes, 1, MAX_CORPUS_BYTES, "maximum corpus bytes");
  if (limits.maximumFileBytes !== MAX_FILE_BYTES || limits.maximumPages !== MAX_PAGES)
    throw new TypeError("PDF corpus product limits are invalid");
  integer(limits.maximumInflatedBytes, 1, 64 * 1024 * 1024, "maximum inflated bytes");
  if (!Array.isArray(manifest.entries)) throw new TypeError("PDF corpus entries must be an array");
  if (manifest.entries.length !== REQUIRED_PDF_CORPUS_STRATA.length)
    throw new TypeError("PDF corpus strata are incomplete");
  const seen = new Set();
  let total = 0;
  for (const entryRaw of manifest.entries) {
    const entry = assertObject(entryRaw, "PDF corpus entry");
    assertExactKeys(
      entry,
      ["stratum", "artifact", "sha256", "byteLength", "pageCount", "expected", "safety", "probe"],
      "PDF corpus entry",
    );
    if (!REQUIRED_PDF_CORPUS_STRATA.includes(entry.stratum) || seen.has(entry.stratum))
      throw new TypeError("PDF corpus stratum is invalid or duplicated");
    seen.add(entry.stratum);
    if (
      typeof entry.artifact !== "string" ||
      !/^s\d{2}\.pdf$/u.test(entry.artifact) ||
      basename(entry.artifact) !== entry.artifact ||
      hasLeak(entry.artifact)
    )
      throw new TypeError("PDF corpus artifact locator is invalid");
    assertSha256(entry.sha256, "PDF corpus SHA-256");
    total += integer(entry.byteLength, 1, limits.maximumFileBytes, "PDF corpus byte length");
    if (entry.pageCount !== null)
      integer(entry.pageCount, 1, limits.maximumPages, "PDF page count");
    const expected = assertObject(entry.expected, "PDF corpus expected verdicts");
    assertExactKeys(expected, ["local", "native"], "PDF corpus expected verdicts");
    if (!VERDICTS.has(expected.local) || !VERDICTS.has(expected.native))
      throw new TypeError("PDF corpus expected verdict is invalid");
    const safety = assertObject(entry.safety, "PDF corpus safety");
    assertExactKeys(
      safety,
      ["maximumSourceBytes", "maximumOutputBytes", "maximumInflatedBytes", "maximumPages"],
      "PDF corpus safety",
    );
    integer(safety.maximumSourceBytes, entry.byteLength, limits.maximumFileBytes, "source ceiling");
    integer(safety.maximumOutputBytes, 1, limits.maximumFileBytes, "output ceiling");
    integer(safety.maximumInflatedBytes, 1, limits.maximumInflatedBytes, "inflated ceiling");
    integer(safety.maximumPages, 1, limits.maximumPages, "page ceiling");
    const probe = assertObject(entry.probe, "PDF corpus feature probe");
    assertExactKeys(probe, ["kind", "token", "signature"], "PDF corpus feature probe");
    exactString(probe.kind, /^[a-z][a-z0-9-]{2,40}$/u, "feature probe kind");
    exactString(probe.token, SAFE_TOKEN, "feature probe token");
    if (hasLeak(probe.token)) throw new TypeError("PDF corpus probe leaks unsafe data");
    if (canonicalJson(probe.signature).length > 1024)
      throw new TypeError("PDF corpus signature is invalid");
  }
  if (total > limits.maximumCorpusBytes)
    throw new RangeError("PDF corpus exceeds its byte ceiling");
  if (REQUIRED_PDF_CORPUS_STRATA.some((stratum) => !seen.has(stratum)))
    throw new TypeError("PDF corpus stratum is missing");
  return manifest;
}

function addProbe(document, token) {
  document.catalog.set(PDFName.of("HereIsItProbe"), PDFName.of(token));
}

async function baseDocument(token, draw = true) {
  const document = await PDFDocument.create({ updateMetadata: false });
  const page = document.addPage([360, 240]);
  addProbe(document, token);
  if (draw) {
    const font = await document.embedFont(StandardFonts.Helvetica);
    page.drawText("HereIsIt generated PDF corpus", { x: 24, y: 190, size: 14, font });
    page.drawRectangle({
      x: 24,
      y: 70,
      width: 150,
      height: 80,
      borderWidth: 2,
      color: rgb(0.9, 0.9, 0.9),
    });
  }
  return { document, page };
}

async function save(document, options = {}) {
  return Buffer.from(
    await document.save({
      useObjectStreams: options.useObjectStreams ?? false,
      addDefaultPage: false,
      objectsPerTick: 50,
      updateFieldAppearances: false,
    }),
  );
}

function addAnnotation(document, page, subtype, token, action) {
  const values = {
    Type: "Annot",
    Subtype: subtype,
    Rect: [24, 24, 190, 55],
    Contents: PDFString.of(token),
    Border: [0, 0, 1],
    ...(action === undefined ? {} : { A: action }),
  };
  page.node.addAnnot(document.context.register(document.context.obj(values)));
}

const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAABAAIBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==",
  "base64",
);
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function generate(stratum, token) {
  const { document, page } = await baseDocument(token, !["expansion", "scan"].includes(stratum));
  if (stratum === "text-vector") {
    for (let index = 0; index < 8; index += 1)
      page.drawLine({
        start: { x: 24, y: 58 + index * 8 },
        end: { x: 330, y: 58 + index * 8 },
        thickness: 1,
      });
  } else if (stratum === "link") {
    addAnnotation(
      document,
      page,
      "Link",
      token,
      document.context.obj({ S: "URI", URI: PDFString.of("urn:hereisit:generated") }),
    );
  } else if (stratum === "annotation") {
    addAnnotation(document, page, "Text", token);
  } else if (stratum === "form") {
    const field = document.getForm().createTextField("generated_field");
    field.setText("generated value");
    field.addToPage(page, { x: 24, y: 24, width: 160, height: 30 });
  } else if (stratum === "outline") {
    const item = document.context.obj({
      Title: PDFHexString.fromText(token),
      Parent: null,
      Dest: [page.ref, "Fit"],
    });
    const itemRef = document.context.register(item);
    const outlines = document.context.obj({
      Type: "Outlines",
      First: itemRef,
      Last: itemRef,
      Count: 1,
    });
    const outlinesRef = document.context.register(outlines);
    item.set(PDFName.of("Parent"), outlinesRef);
    document.catalog.set(PDFName.of("Outlines"), outlinesRef);
  } else if (stratum === "attachment") {
    await document.attach(Buffer.from(`${token}\n`, "ascii"), "generated.bin", {
      mimeType: "application/octet-stream",
    });
  } else if (stratum === "layer") {
    const ocg = document.context.obj({ Type: "OCG", Name: PDFString.of(token) });
    const ocgRef = document.context.register(ocg);
    document.catalog.set(
      PDFName.of("OCProperties"),
      document.context.obj({ OCGs: [ocgRef], D: { Order: [ocgRef], ON: [ocgRef] } }),
    );
    const resources = page.node.Resources();
    resources?.set(PDFName.of("Properties"), document.context.obj({ GeneratedLayer: ocgRef }));
    page.node.addContentStream(
      document.context.register(
        document.context.stream(Buffer.from("/OC /GeneratedLayer BDC 0 0 20 20 re f EMC", "ascii")),
      ),
    );
  } else if (stratum === "duplicate-resource") {
    const payload = Buffer.from(token.repeat(2048), "ascii");
    const one = document.context.register(
      document.context.stream(payload, { Type: "XObject", Subtype: "Form", BBox: [0, 0, 1, 1] }),
    );
    const two = document.context.register(
      document.context.stream(payload, { Type: "XObject", Subtype: "Form", BBox: [0, 0, 1, 1] }),
    );
    page.node.setXObject(PDFName.of("UnusedOne"), one);
    page.node.setXObject(PDFName.of("UnusedTwo"), two);
  } else if (stratum === "flate-heavy") {
    const payload = Buffer.alloc(256 * 1024, 65);
    Buffer.from(token, "ascii").copy(payload);
    page.node.setXObject(
      PDFName.of("UnusedFlateProbe"),
      document.context.register(
        document.context.stream(deflateSync(payload), {
          Type: "XObject",
          Subtype: "Form",
          Filter: "FlateDecode",
          BBox: [0, 0, 1, 1],
        }),
      ),
    );
  } else if (["jpeg-heavy", "scan", "mixed"].includes(stratum)) {
    const image = await document.embedJpg(JPEG);
    for (let index = 0; index < (stratum === "jpeg-heavy" ? 12 : 1); index += 1)
      page.drawImage(image, { x: 24 + index * 10, y: 24 + index * 6, width: 240, height: 160 });
  } else if (stratum === "non-jpeg-image") {
    const image = await document.embedPng(PNG);
    page.drawImage(image, { x: 24, y: 24, width: 240, height: 160 });
  } else if (stratum === "encrypted") {
    const pad = (value) => Buffer.from(value.padEnd(32, "0").slice(0, 32), "ascii");
    const encryption = document.context.obj({
      Filter: "Standard",
      V: 1,
      R: 2,
      O: pad(token),
      U: pad(`U${token}`),
      P: -4,
    });
    document.context.trailerInfo.Encrypt = document.context.register(encryption);
    document.context.trailerInfo.ID = document.context.obj([
      PDFHexString.of("00112233445566778899aabbccddeeff"),
      PDFHexString.of("00112233445566778899aabbccddeeff"),
    ]);
  } else if (stratum === "decompression-bomb") {
    const inflated = Buffer.alloc(4 * 1024 * 1024, 66);
    Buffer.from(token, "ascii").copy(inflated);
    const compressed = deflateSync(inflated, { level: 9 });
    page.node.setXObject(
      PDFName.of("BombEnvelope"),
      document.context.register(
        document.context.stream(compressed, {
          Type: "XObject",
          Subtype: "Form",
          Filter: "FlateDecode",
          HereIsItInflatedBytes: inflated.byteLength,
          BBox: [0, 0, 1, 1],
        }),
      ),
    );
  }
  let bytes = await save(document, { useObjectStreams: stratum === "expansion" });
  if (stratum === "corrupt")
    bytes = Buffer.from(
      `%PDF-1.7\n%${token}\n1 0 obj\n<< /Type /Catalog /Pages 99 0 R >>\nendobj\n`,
      "ascii",
    );
  return bytes;
}

function expected(stratum) {
  if (["encrypted", "corrupt", "decompression-bomb"].includes(stratum))
    return { local: "reject", native: "reject" };
  if (stratum === "expansion") return { local: "original-retained", native: "original-retained" };
  return { local: "measure", native: "measure" };
}

function probeKind(stratum) {
  return stratum === "decompression-bomb" ? "inflated-byte-envelope" : `${stratum}-object`;
}

export async function createPdfCompressionCorpus(outputRoot) {
  const root = resolve(outputRoot);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true, mode: 0o700 });
  const entries = [];
  for (const [index, stratum] of REQUIRED_PDF_CORPUS_STRATA.entries()) {
    const token = `HIS_${stratum.toUpperCase().replaceAll("-", "_")}`;
    const bytes = await generate(stratum, token);
    const artifact = `s${String(index + 1).padStart(2, "0")}.pdf`;
    await writeFile(join(root, artifact), bytes, { mode: 0o600 });
    entries.push({
      stratum,
      artifact,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.byteLength,
      pageCount: stratum === "corrupt" ? null : 1,
      expected: expected(stratum),
      safety: {
        maximumSourceBytes: MAX_FILE_BYTES,
        maximumOutputBytes: MAX_FILE_BYTES,
        maximumInflatedBytes: stratum === "decompression-bomb" ? 1024 * 1024 : 8 * 1024 * 1024,
        maximumPages: MAX_PAGES,
      },
      probe: {
        kind: probeKind(stratum),
        token,
        signature: await probePdfCorpusFeature(bytes, stratum, {
          maximumInflatedBytes: stratum === "decompression-bomb" ? 1024 * 1024 : 8 * 1024 * 1024,
        }),
      },
    });
  }
  const manifest = validatePdfCorpusManifest({
    schema: SCHEMA,
    generator: GENERATOR,
    seed: SEED,
    limits: {
      maximumCorpusBytes: MAX_CORPUS_BYTES,
      maximumFileBytes: MAX_FILE_BYTES,
      maximumPages: MAX_PAGES,
      maximumInflatedBytes: 8 * 1024 * 1024,
    },
    entries,
  });
  await writeFile(join(root, "manifest.json"), canonicalJson(manifest), { mode: 0o600 });
  return manifest;
}

export async function verifyPdfCorpusFiles(manifest, root) {
  validatePdfCorpusManifest(manifest);
  for (const entry of manifest.entries) {
    const bytes = await readFile(join(resolve(root), entry.artifact));
    if (
      bytes.byteLength !== entry.byteLength ||
      createHash("sha256").update(bytes).digest("hex") !== entry.sha256 ||
      canonicalJson(await probePdfCorpusFeature(bytes, entry.stratum, entry.safety)) !==
        canonicalJson(entry.probe.signature)
    )
      throw new TypeError("PDF corpus artifact verification failed");
  }
  return manifest;
}

function occurrences(value, pattern) {
  return [...value.matchAll(pattern)].length;
}

export async function probePdfCorpusFeature(bytes, stratum, safety = {}) {
  const raw = Buffer.from(bytes).toString("latin1");
  if (stratum === "corrupt") {
    const danglingPages = /\/Pages\s+99\s+0\s+R\b/u.test(raw);
    if (!danglingPages || raw.includes("%%EOF")) throw new TypeError("corrupt PDF probe failed");
    return { kind: "corrupt", danglingPages: true, eof: false };
  }
  if (stratum === "encrypted") {
    let rejected = false;
    try {
      await PDFDocument.load(bytes, { throwOnInvalidObject: true });
    } catch {
      rejected = true;
    }
    if (!rejected || !/\/Encrypt\b/u.test(raw)) throw new TypeError("encrypted PDF probe failed");
    return { kind: "encrypted", parseRejected: true, encryptDictionary: true };
  }
  const document = await PDFDocument.load(bytes, {
    updateMetadata: false,
    throwOnInvalidObject: true,
    ignoreEncryption: true,
  });
  const objectText = [];
  const decoded = [];
  for (const [, object] of document.context.enumerateIndirectObjects()) {
    objectText.push(object.toString());
    if (object instanceof PDFRawStream) {
      try {
        decoded.push(Buffer.from(decodePDFRawStream(object).decode()).toString("latin1"));
      } catch {}
    }
  }
  const catalog = document.catalog.toString();
  const objects = objectText.join("\n");
  const streams = decoded.join("\n");
  const pageCount = document.getPageCount();
  const imageCount = occurrences(objects, /\/Subtype\s*\/Image\b/gu);
  const textBlocks = occurrences(streams, /\bBT\b/gu);
  const signature = { pageCount };
  const requireFeature = (condition, feature) => {
    if (!condition) throw new TypeError(`${feature} PDF probe failed`);
    return { ...signature, kind: feature };
  };
  if (stratum === "text-vector")
    return {
      ...requireFeature(textBlocks > 0 && /\b(?:m|l)\b/u.test(streams), "text-vector"),
      textBlocks,
    };
  if (stratum === "link")
    return {
      ...requireFeature(
        /\/Subtype\s*\/Link\b/u.test(objects) && /\/S\s*\/URI\b/u.test(objects),
        "link",
      ),
      uriAnnotations: occurrences(objects, /\/Subtype\s*\/Link\b/gu),
    };
  if (stratum === "annotation")
    return {
      ...requireFeature(/\/Subtype\s*\/Text\b/u.test(objects), "annotation"),
      textAnnotations: occurrences(objects, /\/Subtype\s*\/Text\b/gu),
    };
  if (stratum === "form")
    return requireFeature(/\/AcroForm\b/u.test(catalog) && /\/FT\s*\/Tx\b/u.test(objects), "form");
  if (stratum === "outline") return requireFeature(/\/Outlines\b/u.test(catalog), "outline");
  if (stratum === "attachment")
    return requireFeature(
      /\/EmbeddedFiles\b/u.test(objects) && /\/Type\s*\/Filespec\b/u.test(objects),
      "attachment",
    );
  if (stratum === "layer")
    return requireFeature(
      /\/OCProperties\b/u.test(catalog) && /\/Type\s*\/OCG\b/u.test(objects),
      "layer",
    );
  if (stratum === "duplicate-resource") {
    const duplicateStreams = occurrences(objects, /\/Subtype\s*\/Form\b/gu);
    const sourceFeature =
      duplicateStreams === 2 && occurrences(raw, /HIS_DUPLICATE_RESOURCE/gu) >= 4096;
    const optimizedFeature =
      safety.allowDeduplicated === true &&
      duplicateStreams <= 2 &&
      occurrences(raw, /HIS_DUPLICATE_RESOURCE/gu) < 4096;
    return {
      ...requireFeature(sourceFeature || optimizedFeature, "duplicate-resource"),
      duplicateStreams,
    };
  }
  if (stratum === "flate-heavy")
    return requireFeature(
      /\/Filter\s*\/FlateDecode\b/u.test(objects) && streams.includes("HIS_FLATE_HEAVY"),
      "flate-heavy",
    );
  if (stratum === "jpeg-heavy")
    return {
      ...requireFeature(imageCount > 0 && /\/DCTDecode\b/u.test(objects), "jpeg-heavy"),
      imageCount,
      imageEncoding: "dct",
    };
  if (stratum === "non-jpeg-image")
    return {
      ...requireFeature(imageCount > 0 && !/\/DCTDecode\b/u.test(objects), "non-jpeg-image"),
      imageCount,
      imageEncoding: "non-dct",
    };
  if (stratum === "scan")
    return {
      ...requireFeature(imageCount > 0 && textBlocks === 0, "scan"),
      imageCount,
      textBlocks,
    };
  if (stratum === "mixed")
    return { ...requireFeature(imageCount > 0 && textBlocks > 0, "mixed"), imageCount, textBlocks };
  if (stratum === "expansion") return requireFeature(pageCount === 1, "expansion");
  if (stratum === "decompression-bomb") {
    const marker = /\/HereIsItInflatedBytes\s+(\d+)/u.exec(objects);
    const inflatedBytes = Number(marker?.[1]);
    if (
      !Number.isSafeInteger(inflatedBytes) ||
      inflatedBytes <= (safety.maximumInflatedBytes ?? 0) ||
      !/\/FlateDecode\b/u.test(objects)
    )
      throw new TypeError("decompression-bomb PDF probe failed");
    return {
      kind: "decompression-bomb",
      pageCount,
      inflatedBytes,
      maximumInflatedBytes: safety.maximumInflatedBytes,
    };
  }
  throw new TypeError("unknown PDF corpus stratum");
}

function help() {
  return "Usage: node scripts/create-pdf-compression-corpus.mjs --output <directory>\n";
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes("--help")) process.stdout.write(help());
  else {
    const args = parseCliArguments(process.argv.slice(2));
    assertExactKeys(args, ["output"], "PDF corpus CLI arguments");
    const manifest = await createPdfCompressionCorpus(args.output);
    process.stdout.write(`${JSON.stringify({ ok: true, entries: manifest.entries.length })}\n`);
  }
}

import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFString,
  StandardFonts,
} from "@cantoo/pdf-lib";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPdfCompressionCorpus,
  probePdfCorpusFeature,
  REQUIRED_PDF_CORPUS_STRATA,
  validatePdfCorpusManifest,
  verifyPdfCorpusFiles,
} from "../scripts/create-pdf-compression-corpus.mjs";

const roots: string[] = [];

async function root(label: string) {
  const path = join(tmpdir(), `hereisit-pdf-corpus-${label}-${crypto.randomUUID()}`);
  roots.push(path);
  return path;
}

async function mutatePdf(
  bytes: Uint8Array,
  mutate: (document: PDFDocument) => void | Promise<void>,
) {
  const document = await PDFDocument.load(bytes, { ignoreEncryption: true });
  await mutate(document);
  return document.save({ useObjectStreams: false, updateFieldAppearances: false });
}

function objectWith(document: PDFDocument, key: string, value: string) {
  for (const [, object] of document.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict)) continue;
    if (object.get(PDFName.of(key))?.toString() === value) return object;
  }
  throw new Error(`fixture object ${key}=${value} is missing`);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("generated PDF compression corpus", () => {
  it("generates every machine-probed stratum deterministically within fixed ceilings", async () => {
    const firstRoot = await root("first");
    const secondRoot = await root("second");
    const first = await createPdfCompressionCorpus(firstRoot);
    const second = await createPdfCompressionCorpus(secondRoot);

    expect(first).toEqual(second);
    expect(first.entries.map((entry) => entry.stratum)).toEqual(REQUIRED_PDF_CORPUS_STRATA);
    expect(first.entries.reduce((sum, entry) => sum + entry.byteLength, 0)).toBeLessThanOrEqual(
      first.limits.maximumCorpusBytes,
    );

    for (const entry of first.entries) {
      const bytes = await readFile(join(firstRoot, entry.artifact));
      expect(createHash("sha256").update(bytes).digest("hex"), entry.stratum).toBe(entry.sha256);
      expect(bytes.byteLength).toBe(entry.byteLength);
      await expect(probePdfCorpusFeature(bytes, entry.stratum, entry.safety)).resolves.toEqual(
        entry.probe.signature,
      );
    }
  });

  it("generates a realistic deterministic JPEG stratum for image optimization", async () => {
    const firstRoot = await root("visual-first");
    const secondRoot = await root("visual-second");
    const first = await createPdfCompressionCorpus(firstRoot);
    const second = await createPdfCompressionCorpus(secondRoot);
    const firstJpeg = first.entries.find((entry) => entry.stratum === "jpeg-heavy");
    const secondJpeg = second.entries.find((entry) => entry.stratum === "jpeg-heavy");

    expect(firstJpeg).toBeDefined();
    expect(secondJpeg).toBeDefined();
    expect(firstJpeg).toEqual(secondJpeg);
    expect(firstJpeg?.probe.signature).toMatchObject({
      imageCount: 1,
      imageEncoding: "dct",
      imageWidth: 1_200,
      imageHeight: 1_600,
    });
    expect(firstJpeg?.byteLength).toBeGreaterThan(100_000);
    expect(firstJpeg?.byteLength).toBeLessThanOrEqual(first.limits.maximumFileBytes);

    if (firstJpeg === undefined) throw new Error("visual JPEG fixture is missing");
    const source = await readFile(join(firstRoot, firstJpeg.artifact));
    const changed = await mutatePdf(source, (document) => {
      for (const [, object] of document.context.enumerateIndirectObjects()) {
        if (
          object instanceof PDFRawStream &&
          object.dict.get(PDFName.of("Subtype"))?.toString() === "/Image"
        ) {
          object.dict.set(PDFName.of("Height"), PDFNumber.of(1_599));
          return;
        }
      }
      throw new Error("visual JPEG image object is missing");
    });
    await expect(
      probePdfCorpusFeature(changed, "jpeg-heavy", firstJpeg.safety),
    ).resolves.not.toEqual(firstJpeg.probe.signature);
  });

  it("rejects swapped labels when the bytes do not contain that stratum's defining feature", async () => {
    const output = await root("swapped");
    const manifest = await createPdfCompressionCorpus(output);
    const link = manifest.entries.find((entry) => entry.stratum === "link");
    const form = manifest.entries.find((entry) => entry.stratum === "form");
    expect(link).toBeDefined();
    expect(form).toBeDefined();
    if (link === undefined || form === undefined) throw new Error("swapped fixture is missing");
    const swapped = {
      ...manifest,
      entries: manifest.entries.map((entry) =>
        entry === link
          ? {
              ...form,
              stratum: "link",
              artifact: link.artifact,
              sha256: link.sha256,
              byteLength: link.byteLength,
            }
          : entry === form
            ? {
                ...link,
                stratum: "form",
                artifact: form.artifact,
                sha256: form.sha256,
                byteLength: form.byteLength,
              }
            : entry,
      ),
    };
    await expect(verifyPdfCorpusFiles(swapped, output)).rejects.toThrow();
  });

  it("binds defining token, form value, and embedded content by digest", async () => {
    const output = await root("semantic-digests");
    const manifest = await createPdfCompressionCorpus(output);
    for (const entry of manifest.entries.filter(
      (item) => !["corrupt", "encrypted"].includes(item.stratum),
    ))
      expect(entry.probe.signature.tokenDigest, entry.stratum).toMatch(/^[a-f0-9]{64}$/);
    expect(
      manifest.entries.find((entry) => entry.stratum === "form")?.probe.signature,
    ).toMatchObject({
      valueDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(
      manifest.entries.find((entry) => entry.stratum === "attachment")?.probe.signature,
    ).toMatchObject({ contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it.each([
    [
      "link URI",
      "link",
      (document: PDFDocument) => {
        const annotation = objectWith(document, "Subtype", "/Link");
        annotation
          .lookup(PDFName.of("A"), PDFDict)
          .set(PDFName.of("URI"), PDFString.of("urn:hereisit:mutated"));
      },
    ],
    [
      "annotation contents",
      "annotation",
      (document: PDFDocument) =>
        objectWith(document, "Subtype", "/Text").set(
          PDFName.of("Contents"),
          PDFString.of("mutated"),
        ),
    ],
    [
      "outline title",
      "outline",
      (document: PDFDocument) => {
        const outlines = objectWith(document, "Type", "/Outlines");
        const item = outlines.lookup(PDFName.of("First"), PDFDict);
        item.set(PDFName.of("Title"), PDFString.of("mutated"));
      },
    ],
    [
      "outline destination",
      "outline",
      (document: PDFDocument) => {
        const outlines = objectWith(document, "Type", "/Outlines");
        const item = outlines.lookup(PDFName.of("First"), PDFDict);
        item.lookup(PDFName.of("Dest"), PDFArray).set(1, PDFName.of("XYZ"));
      },
    ],
    [
      "layer name",
      "layer",
      (document: PDFDocument) =>
        objectWith(document, "Type", "/OCG").set(PDFName.of("Name"), PDFString.of("mutated")),
    ],
    [
      "layer membership",
      "layer",
      (document: PDFDocument) => {
        document.catalog
          .lookup(PDFName.of("OCProperties"), PDFDict)
          .lookup(PDFName.of("OCGs"), PDFArray)
          .remove(0);
      },
    ],
    [
      "layer marked-content reference",
      "layer",
      (document: PDFDocument) => {
        for (const [, object] of document.context.enumerateIndirectObjects()) {
          if (!(object instanceof PDFRawStream)) continue;
          const decoded = Buffer.from(decodePDFRawStream(object).decode());
          if (!decoded.includes(Buffer.from("/GeneratedLayer", "ascii"))) continue;
          object.updateContents(
            Buffer.from(decoded.toString("ascii").replace("/GeneratedLayer", "/DetachedLayer")),
          );
        }
      },
    ],
    [
      "text page content",
      "text-vector",
      async (document: PDFDocument) => {
        const font = await document.embedFont(StandardFonts.Helvetica);
        const page = document.getPages()[0];
        page?.drawText("Changed semantic text", { x: 20, y: 20, size: 10, font });
      },
    ],
    [
      "vector page operators",
      "text-vector",
      (document: PDFDocument) => {
        const page = document.getPages()[0];
        page?.drawLine({ start: { x: 1, y: 2 }, end: { x: 3, y: 4 }, thickness: 3 });
      },
    ],
  ])("binds the actual %s while the catalog marker remains unchanged", async (_, stratum, mutate) => {
    const output = await root(`actual-${stratum}`);
    const manifest = await createPdfCompressionCorpus(output);
    const entry = manifest.entries.find((item) => item.stratum === stratum);
    if (entry === undefined) throw new Error("fixture entry is missing");
    const source = await readFile(join(output, entry.artifact));
    const changed = await mutatePdf(source, mutate);
    const changedDocument = await PDFDocument.load(changed, { ignoreEncryption: true });
    expect(changedDocument.catalog.get(PDFName.of("HereIsItProbe"))?.toString()).toBe(
      `/${entry.probe.token}`,
    );
    const result = await probePdfCorpusFeature(changed, stratum, entry.safety).then(
      (signature) => ({ accepted: true, signature }),
      () => ({ accepted: false, signature: null }),
    );
    if (result.accepted) expect(result.signature).not.toEqual(entry.probe.signature);
    else expect(result.accepted).toBe(false);
  });

  it("rejects duplicate, missing, tampered, extra, unsafe, or path-leaking manifest data", async () => {
    const output = await root("validation");
    const manifest = await createPdfCompressionCorpus(output);
    const entry = manifest.entries[0];
    expect(entry).toBeDefined();

    const invalid = [
      { ...manifest, entries: manifest.entries.slice(1) },
      { ...manifest, entries: [...manifest.entries, entry] },
      { ...manifest, extra: true },
      {
        ...manifest,
        entries: [{ ...entry, byteLength: Number.NaN }, ...manifest.entries.slice(1)],
      },
      {
        ...manifest,
        entries: [{ ...entry, artifact: "/tmp/private.pdf" }, ...manifest.entries.slice(1)],
      },
      {
        ...manifest,
        entries: [
          { ...entry, probe: { ...entry.probe, token: "https://x" } },
          ...manifest.entries.slice(1),
        ],
      },
    ];
    for (const candidate of invalid) expect(() => validatePdfCorpusManifest(candidate)).toThrow();
    await expect(
      verifyPdfCorpusFiles(
        {
          ...manifest,
          entries: [{ ...entry, sha256: "0".repeat(64) }, ...manifest.entries.slice(1)],
        },
        output,
      ),
    ).rejects.toThrow();
  });
});

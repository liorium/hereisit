import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

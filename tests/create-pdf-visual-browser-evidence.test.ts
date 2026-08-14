import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writePdfVisualInputBundle } from "../scripts/benchmark-pdf-engine.mjs";
import {
  createPdfVisualBrowserEvidence,
  createPdfVisualProjectReceipt,
  validatePdfVisualBrowserEvidence,
  validatePdfVisualBrowserEvidenceSchema,
} from "../scripts/create-pdf-visual-browser-evidence.mjs";
import { canonicalJson, sha256Bytes } from "../scripts/image-lab-common.mjs";

const roots: string[] = [];
const gitSha = "a".repeat(40);
const sourceSha256 = "b".repeat(64);
const checkRunId = 42;
const projects = ["chromium", "firefox", "webkit"] as const;

function pdf(label: string, padding = 0) {
  return Buffer.from(`%PDF-1.7\n%${label}\n${"x".repeat(padding)}\n%%EOF\n`);
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hereisit-pdf-browser-evidence-"));
  roots.push(root);
  const inputRoot = join(root, "input");
  const receiptRoot = join(root, "receipts");
  await mkdir(receiptRoot);
  const input = await writePdfVisualInputBundle({
    output: inputRoot,
    engineImageDigest: `sha256:${"c".repeat(64)}`,
    corpusManifestSha256: "d".repeat(64),
    stratum: "jpeg-heavy",
    source: pdf("source", 200),
    pageCount: 1,
    results: [0, 1, 2].map((repeat) => ({
      repeat,
      output: pdf(`result-${repeat}`),
      verdict: "reduced",
      profile: "image-optimized",
      semantic: "passed",
      visual: "passed",
    })),
  });
  const inputManifestSha256 = sha256Bytes(await readFile(join(inputRoot, "manifest.json")));
  for (const project of projects) {
    const receipt = createPdfVisualProjectReceipt({
      gitSha,
      sourceSha256,
      checkRunId,
      project,
      inputManifestSha256,
      input,
    });
    await writeFile(join(receiptRoot, `${project}.json`), canonicalJson(receipt));
  }
  return { root, inputRoot, receiptRoot, input, inputManifestSha256 };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("PDF browser visual evidence", () => {
  it("binds three real browser projects to the exact private input and engine", async () => {
    const value = await fixture();
    const output = join(value.root, "evidence.json");
    const evidence = await createPdfVisualBrowserEvidence({
      inputRoot: value.inputRoot,
      receiptRoot: value.receiptRoot,
      output,
      gitSha,
      sourceSha256,
      checkRunId,
    });

    expect(validatePdfVisualBrowserEvidence(evidence)).toEqual(evidence);
    expect(evidence).toMatchObject({
      schema: "hereisit.pdf-browser-visual-evidence@1",
      passed: true,
      gitSha,
      sourceSha256,
      checkRunId,
      inputManifestSha256: value.inputManifestSha256,
      engineImageDigest: value.input.engineImageDigest,
      corpusManifestSha256: value.input.corpusManifestSha256,
      projects: projects.map((project) => ({ project, passed: true })),
      visualProfilesMeasured: 9,
    });
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual(evidence);
    await expect(
      validatePdfVisualBrowserEvidenceSchema(
        evidence,
        JSON.parse(
          await readFile("docs/deployment/pdf-browser-visual-evidence.schema.json", "utf8"),
        ),
      ),
    ).resolves.toBeUndefined();
  });

  it.each([
    "missing project",
    "duplicate project",
    "wrong result hash",
    "wrong engine",
    "unknown field",
  ])("rejects incomplete or drifted evidence: %s", async (mutation) => {
    const value = await fixture();
    if (mutation === "missing project") await rm(join(value.receiptRoot, "webkit.json"));
    else if (mutation === "duplicate project") {
      const receipt = JSON.parse(await readFile(join(value.receiptRoot, "webkit.json"), "utf8"));
      receipt.project = "firefox";
      await writeFile(join(value.receiptRoot, "webkit.json"), canonicalJson(receipt));
    } else {
      const path = join(value.receiptRoot, "chromium.json");
      const receipt = JSON.parse(await readFile(path, "utf8"));
      if (mutation === "wrong result hash") receipt.results[0].sha256 = "e".repeat(64);
      else if (mutation === "wrong engine") receipt.engineImageDigest = `sha256:${"e".repeat(64)}`;
      else receipt.privatePath = "/tmp/input.pdf";
      await writeFile(path, canonicalJson(receipt));
    }
    await expect(
      createPdfVisualBrowserEvidence({
        inputRoot: value.inputRoot,
        receiptRoot: value.receiptRoot,
        output: join(value.root, "evidence.json"),
        gitSha,
        sourceSha256,
        checkRunId,
      }),
    ).rejects.toThrow();
  });

  it("does not expose paths, URLs, bytes, or rendered pixels in sanitized evidence", async () => {
    const value = await fixture();
    const evidence = await createPdfVisualBrowserEvidence({
      inputRoot: value.inputRoot,
      receiptRoot: value.receiptRoot,
      output: join(value.root, "evidence.json"),
      gitSha,
      sourceSha256,
      checkRunId,
    });
    const serialized = canonicalJson(evidence);
    expect(serialized).not.toMatch(/(?:https?:|file:|\/tmp\/|source\.pdf|result-\d\.pdf)/u);
    expect(serialized).not.toContain(pdf("source").toString("base64"));
    expect(createHash("sha256").update(serialized).digest("hex")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects browser projects that verified different result bytes", async () => {
    const value = await fixture();
    const evidence = await createPdfVisualBrowserEvidence({
      inputRoot: value.inputRoot,
      receiptRoot: value.receiptRoot,
      output: join(value.root, "evidence.json"),
      gitSha,
      sourceSha256,
      checkRunId,
    });
    const drifted = structuredClone(evidence);
    drifted.projects[2].results[0].sha256 = "e".repeat(64);

    expect(() => validatePdfVisualBrowserEvidence(drifted)).toThrow(/result|browser/i);
  });
});

import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyPdfEngineLicenses } from "../scripts/verify-pdf-engine-licenses.mjs";

const root = "apps/pdf-engine";
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true }))));

describe("PDF engine supply-chain policy", () => {
  it("pins the one official qpdf source and exact digest", async () => {
    const lock = JSON.parse(await readFile(`${root}/native/sources.lock.json`, "utf8"));
    expect(lock).toEqual({
      schemaVersion: 1,
      sources: [
        {
          name: "qpdf",
          version: "12.4.0",
          url: "https://github.com/qpdf/qpdf/releases/download/v12.4.0/qpdf-12.4.0.tar.gz",
          sha256: "2783a032f443cc886dad41aa6d5fae3dabf23dec00ee7ec2cfb27ef67ebcf529",
          license: "Apache-2.0",
          noticePaths: ["LICENSE.txt", "NOTICE.md"],
        },
      ],
    });
  });

  it("requires Apache license material, runtime artifacts, non-root UID, and no prohibited components", async () => {
    await expect(verifyPdfEngineLicenses({ root })).resolves.toMatchObject({
      schema: "hereisit-pdf-engine-license-gate@1",
      passed: true,
      qpdfVersion: "12.4.0",
    });
  });

  it("binds the build and application supply-chain gates", async () => {
    const [dockerfile, build, supplyChain, workflow] = await Promise.all([
      readFile(`${root}/Dockerfile`, "utf8"),
      readFile(`${root}/native/build-qpdf.sh`, "utf8"),
      readFile("scripts/application-supply-chain.mjs", "utf8"),
      readFile(".github/workflows/ci.yml", "utf8"),
    ]);
    expect(build).toContain("sha256sum --check");
    expect(build).toContain("sources.lock.json");
    expect(build).not.toMatch(/^\s*(?:VERSION=[0-9]|URL=https?:|SHA256=[0-9a-f]{64}\s*$)/mu);
    expect(build).not.toMatch(/git clone|apt-get|\bpip\b|\bcargo\b/u);
    expect(dockerfile).toContain("USER 10001:10001");
    expect(dockerfile).toContain("/tmp/hereisit-pdf-engine");
    expect(dockerfile).not.toMatch(/ghostscript|mupdf|poppler|pdfcpu|python/u);
    expect(supplyChain).toContain('"@hereisit/pdf-engine..."');
    expect(workflow).toContain("verify-pdf-engine-licenses.mjs");
  });

  it("rejects a build script that duplicates a drifting source digest", async () => {
    const copy = await mkdtemp(join(tmpdir(), "hereisit-pdf-license-"));
    roots.push(copy);
    await cp(root, copy, { recursive: true });
    await writeFile(
      join(copy, "native/build-qpdf.sh"),
      `${await readFile(join(copy, "native/build-qpdf.sh"), "utf8")}\nSHA256=${"0".repeat(64)}\n`,
    );
    await expect(verifyPdfEngineLicenses({ root: copy })).rejects.toThrow();
  });
});

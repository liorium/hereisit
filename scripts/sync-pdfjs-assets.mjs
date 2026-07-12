import assert from "node:assert/strict";
import { access, cp, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PDFJS_VERSION = "6.1.200";
const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");
const packageRoot = path.join(repositoryRoot, "packages/browser-runtime/node_modules/pdfjs-dist");
const outputRoot = path.join(repositoryRoot, "apps/web/public/pdfjs", PDFJS_VERSION);

async function assertPackageFile(relativePath) {
  try {
    await access(path.join(packageRoot, relativePath));
  } catch {
    assert.fail(
      `Missing pdfjs-dist@${PDFJS_VERSION} package file: ${relativePath}. Run pnpm install.`,
    );
  }
}

export async function syncPdfjsAssets() {
  await assertPackageFile("package.json");

  const packageJson = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  assert.equal(
    packageJson.version,
    PDFJS_VERSION,
    `Expected pdfjs-dist@${PDFJS_VERSION}, received ${String(packageJson.version)}.`,
  );

  await Promise.all([
    assertPackageFile("build/pdf.worker.min.mjs"),
    assertPackageFile("cmaps/LICENSE"),
    assertPackageFile("standard_fonts/LICENSE_FOXIT"),
  ]);

  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
  await Promise.all([
    cp(
      path.join(packageRoot, "build/pdf.worker.min.mjs"),
      path.join(outputRoot, "pdf.worker.min.mjs"),
    ),
    cp(path.join(packageRoot, "cmaps"), path.join(outputRoot, "cmaps"), { recursive: true }),
    cp(path.join(packageRoot, "standard_fonts"), path.join(outputRoot, "standard_fonts"), {
      recursive: true,
    }),
  ]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await syncPdfjsAssets();
}

import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toolImplementationConfig } from "../apps/web/src/lib/tool-implementations.ts";
import {
  availableToolEntries,
  plannedToolEntries,
} from "../packages/tool-registry/src/tool-catalog.ts";

const PDFJS_VERSION = "6.2.108";
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(repositoryRoot, "apps/web/out");
const pdfjsPackageRoot = path.join(
  repositoryRoot,
  "packages/browser-runtime/node_modules/pdfjs-dist",
);
const pdfjsOutputRoot = path.join(outputRoot, "pdfjs", PDFJS_VERSION);

const IMAGE_WORKER_MARKER = "hereisit-image-worker";
const IMAGE_SERVER_RUNTIME_MARKER = "hereisit-server-runtime";
const IMAGE_WATERMARK_WORKER_MARKER = "hereisit-image-watermark-worker";
const PDF_WORKER_MARKER = "hereisit-pdf-worker";
const PDF_INSPECTION_WORKER_MARKER = "hereisit-pdf-inspection-worker";
const PDF_TO_IMAGES_WORKER_MARKER = "hereisit-pdf-to-images-worker";
const PDF_COMPRESS_SCANNED_WORKER_MARKER = "hereisit-pdf-compress-scanned-worker";
const PDF_OPTIMIZE_VERIFY_WORKER_MARKER = "hereisit-pdf-optimize-verifier";
const PDFJS_MARKER = "pdf.worker.min.mjs";
const DEPLOYED_ORIGIN = "https://hereisit.app";
const REMOTE_URL_PATTERN = /https?:\/\/[^"'`\s<>()\\]+/gi;
const PDFJS_REMOTE_ASSET_PATTERN =
  /(?:pdfjs(?:-dist)?|pdf\.js|pdf\.worker(?:\.min)?\.mjs|\/cmaps\/|\/standard_fonts\/)/i;

function routeHtmlFile(route) {
  return `${route.replace(/^\/+|\/+$/g, "")}.html`;
}

const toolPages = availableToolEntries.map((tool) => ({
  file: routeHtmlFile(tool.route),
  path: tool.route,
  title: tool.name,
  description: tool.shortDescription,
  bundleProfile: toolImplementationConfig[tool.id].bundleProfile,
}));
const discoveryPages = [
  { file: routeHtmlFile("/tools"), path: "/tools", indexable: true },
  { file: routeHtmlFile("/my-tools"), path: "/my-tools", indexable: false },
  { file: routeHtmlFile("/workflows"), path: "/workflows", indexable: false },
];
const plannedRouteFiles = plannedToolEntries.map((tool) => ({
  file: routeHtmlFile(`/${tool.id.replaceAll(".", "/")}`),
  path: `/${tool.id.replaceAll(".", "/")}`,
}));

const ALL_PROCESSING_MARKERS = [
  IMAGE_WORKER_MARKER,
  IMAGE_SERVER_RUNTIME_MARKER,
  IMAGE_WATERMARK_WORKER_MARKER,
  PDF_WORKER_MARKER,
  PDF_INSPECTION_WORKER_MARKER,
  PDF_TO_IMAGES_WORKER_MARKER,
  PDF_COMPRESS_SCANNED_WORKER_MARKER,
  PDF_OPTIMIZE_VERIFY_WORKER_MARKER,
  PDFJS_MARKER,
];
const DISCOVERY_PROCESSING_MARKERS = [
  ...ALL_PROCESSING_MARKERS,
  "ImageWorkbench",
  "ImageWatermarkWorkbench",
  "PdfWorkbench",
  "PdfCompressWorkbench",
  "PdfToImageWorkbench",
  "pdfjs-dist",
  "@hereisit/browser-runtime",
  "@hereisit/image-tool",
  "@hereisit/pdf-tool",
  "@hereisit/tool-contracts",
  "@cantoo/pdf-lib",
  "fflate",
  "/codec/",
  ".codec.",
  "-codec-",
  "/editor/",
  ".editor.",
  "-editor-",
  "/wasm/",
  ".wasm",
  "-wasm-",
];
const bundleProfileMarkers = {
  image: [IMAGE_WORKER_MARKER],
  "image-compression-server": [IMAGE_SERVER_RUNTIME_MARKER, IMAGE_WORKER_MARKER],
  "image-watermark": [IMAGE_WATERMARK_WORKER_MARKER],
  "pdf-editing": [PDF_WORKER_MARKER, PDF_INSPECTION_WORKER_MARKER],
  "pdf-organize": [PDF_WORKER_MARKER, PDF_INSPECTION_WORKER_MARKER, PDFJS_MARKER],
  "pdf-to-images": [PDF_INSPECTION_WORKER_MARKER, PDF_TO_IMAGES_WORKER_MARKER, PDFJS_MARKER],
  "pdf-compress-scanned": [
    IMAGE_SERVER_RUNTIME_MARKER,
    PDF_INSPECTION_WORKER_MARKER,
    PDF_COMPRESS_SCANNED_WORKER_MARKER,
    PDF_OPTIMIZE_VERIFY_WORKER_MARKER,
    PDFJS_MARKER,
  ],
};

async function collectJavaScript(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectJavaScript(absolute)));
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push(absolute);
  }
  return files;
}

async function collectRelativeFiles(directory, relativeDirectory = "") {
  const entries = await readdir(path.join(directory, relativeDirectory), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectRelativeFiles(directory, relativePath)));
    else if (entry.isFile()) files.push(relativePath.split(path.sep).join("/"));
  }
  return files.sort();
}

function readPageScriptPaths(pageHtml) {
  return Array.from(
    new Set(
      Array.from(
        pageHtml.matchAll(/<script[^>]+src="(\/_next\/[^"?#]+\.js)(?:["?#])/g),
        (match) => match[1],
      ),
    ),
  );
}

function readLiteralNextScriptPaths(scriptSource) {
  const references = scriptSource.match(
    /\/_next\/[A-Za-z0-9._~/-]+\.js|static\/[A-Za-z0-9._~/-]+\.js/g,
  );
  return Array.from(
    new Set(
      (references ?? []).map((reference) =>
        reference.startsWith("/_next/") ? reference : `/_next/${reference}`,
      ),
    ),
  );
}

async function createJavaScriptInventory() {
  const scripts = await collectJavaScript(path.join(outputRoot, "_next"));
  return new Map(
    await Promise.all(
      scripts.map(async (script) => [
        `/${path.relative(outputRoot, script).split(path.sep).join("/")}`,
        await readFile(script, "utf8"),
      ]),
    ),
  );
}

function collectRouteClosure(pageHtml, javaScriptInventory) {
  const pending = [...readPageScriptPaths(pageHtml)];
  const closure = new Set();

  while (pending.length > 0) {
    const scriptPath = pending.shift();
    if (scriptPath === undefined || closure.has(scriptPath)) continue;

    const source = javaScriptInventory.get(scriptPath);
    assert.ok(source !== undefined, "An exported page references a missing JavaScript asset.");
    closure.add(scriptPath);

    for (const referencedPath of readLiteralNextScriptPaths(source)) {
      if (javaScriptInventory.has(referencedPath) && !closure.has(referencedPath)) {
        pending.push(referencedPath);
      }
    }
  }

  return Array.from(closure, (scriptPath) => javaScriptInventory.get(scriptPath));
}

function assertClosureHas(sources, marker, message) {
  assert.ok(
    sources.some((source) => source?.includes(marker)),
    message,
  );
}

function assertClosureLacks(sources, marker, message) {
  assert.ok(
    sources.every((source) => !source?.includes(marker)),
    message,
  );
}

function assertSameRelativeFiles(sourceFiles, exportedFiles, label) {
  assert.equal(exportedFiles.length, sourceFiles.length, `${label} file counts must match.`);
  assert.ok(
    sourceFiles.every((relativePath, index) => relativePath === exportedFiles[index]),
    `${label} relative file sets must match exactly.`,
  );
}

await Promise.all([
  access(path.join(outputRoot, "index.html")),
  access(path.join(outputRoot, "404.html")),
  access(path.join(outputRoot, "_headers")),
  access(path.join(outputRoot, "sitemap.xml")),
  access(path.join(outputRoot, "robots.txt")),
  access(path.join(pdfjsOutputRoot, "pdf.worker.min.mjs")),
  ...discoveryPages.map((page) => access(path.join(outputRoot, page.file))),
  ...toolPages.map((tool) => access(path.join(outputRoot, tool.file))),
]);

const [html, headers, sitemap, robots] = await Promise.all([
  readFile(path.join(outputRoot, "index.html"), "utf8"),
  readFile(path.join(outputRoot, "_headers"), "utf8"),
  readFile(path.join(outputRoot, "sitemap.xml"), "utf8"),
  readFile(path.join(outputRoot, "robots.txt"), "utf8"),
]);
const discoveryHtmlPages = await Promise.all(
  discoveryPages.map((page) => readFile(path.join(outputRoot, page.file), "utf8")),
);
const toolHtmlPages = await Promise.all(
  toolPages.map((tool) => readFile(path.join(outputRoot, tool.file), "utf8")),
);
assert.match(html, /파일 작업/);
assert.match(html, /href="\/image\/compress"/);
assert.match(html, /href="\/pdf\/merge"/);
assert.match(headers, /Content-Security-Policy:/);
assert.match(headers, /connect-src \x27self\x27/);

for (const [index, tool] of toolPages.entries()) {
  const toolHtml = toolHtmlPages[index];
  assert.ok(toolHtml, `Missing exported HTML for ${tool.path}`);
  assert.ok(toolHtml.includes(`<title>${tool.title} | HereIsIt</title>`));
  assert.ok(toolHtml.includes(tool.description));
  assert.ok(toolHtml.includes(`rel="canonical" href="https://hereisit.app${tool.path}"`));
  assert.ok(sitemap.includes(`<loc>https://hereisit.app${tool.path}</loc>`));
}

for (const [index, page] of discoveryPages.entries()) {
  const pageHtml = discoveryHtmlPages[index];
  assert.ok(pageHtml, `Missing exported HTML for ${page.path}`);
  assert.ok(
    pageHtml.includes(`rel="canonical" href="https://hereisit.app${page.path}"`),
    `${page.path} must have one fixed canonical URL.`,
  );
  if (page.indexable) {
    assert.ok(
      sitemap.includes(`<loc>https://hereisit.app${page.path}</loc>`),
      `${page.path} must be present in the sitemap.`,
    );
  } else {
    assert.ok(
      pageHtml.includes('name="robots" content="noindex, follow"'),
      `${page.path} must be noindex,follow.`,
    );
    assert.ok(
      !sitemap.includes(`<loc>https://hereisit.app${page.path}</loc>`),
      `${page.path} must stay out of the sitemap.`,
    );
  }
}
assert.match(
  sitemap,
  /<loc>https:\/\/hereisit\.app\/tools<\/loc>\s*<changefreq>weekly<\/changefreq>\s*<priority>0\.8<\/priority>/,
);

for (const plannedRoute of plannedRouteFiles) {
  await assert.rejects(access(path.join(outputRoot, plannedRoute.file)), { code: "ENOENT" });
  assert.ok(
    !sitemap.includes(`<loc>https://hereisit.app${plannedRoute.path}</loc>`),
    `${plannedRoute.path} must not be published before it is available.`,
  );
}

assert.match(robots, /Sitemap: https:\/\/hereisit\.app\/sitemap\.xml/);

const exportedHtml = [html, ...discoveryHtmlPages, ...toolHtmlPages].join("\n");
const assetPaths = Array.from(
  new Set(
    Array.from(
      exportedHtml.matchAll(/(?:src|href)="(\/_next\/[^"?#]+)["?#]/g),
      (match) => match[1],
    ),
  ),
);
assert.ok(assetPaths.length > 0, "The exported pages must reference Next.js assets.");
await Promise.all(assetPaths.map((assetPath) => access(path.join(outputRoot, assetPath.slice(1)))));

const scripts = await collectJavaScript(path.join(outputRoot, "_next"));
const scriptSources = await Promise.all(scripts.map((script) => readFile(script, "utf8")));
assert.ok(
  scriptSources.some((source) => source.includes(IMAGE_WORKER_MARKER)),
  "The static export must include the image Worker bundle.",
);
assert.ok(
  scriptSources.some((source) => source.includes(IMAGE_WATERMARK_WORKER_MARKER)),
  "The static export must include the image watermark Worker bundle.",
);
assert.ok(
  scriptSources.some((source) => source.includes(PDF_WORKER_MARKER)),
  "The static export must include the PDF Worker bundle.",
);
assert.ok(
  scriptSources.some((source) => source.includes(PDF_INSPECTION_WORKER_MARKER)),
  "The static export must include the PDF inspection Worker bundle.",
);
assert.ok(
  scriptSources.some((source) => source.includes(PDF_TO_IMAGES_WORKER_MARKER)),
  "The static export must include the PDF-to-images Worker bundle.",
);
assert.ok(
  scriptSources.some((source) => source.includes(PDF_COMPRESS_SCANNED_WORKER_MARKER)),
  "The static export must include the scanned PDF compression Worker bundle.",
);
assert.ok(
  scriptSources.some((source) => source.includes(PDF_OPTIMIZE_VERIFY_WORKER_MARKER)),
  "The static export must include the server PDF verification Worker bundle.",
);
assert.ok(
  scriptSources.some((source) => source.includes(PDFJS_MARKER)),
  "The static export must include the PDF.js parser Worker marker.",
);

const [sourceCMaps, exportedCMaps, sourceStandardFonts, exportedStandardFonts] = await Promise.all([
  collectRelativeFiles(path.join(pdfjsPackageRoot, "cmaps")),
  collectRelativeFiles(path.join(pdfjsOutputRoot, "cmaps")),
  collectRelativeFiles(path.join(pdfjsPackageRoot, "standard_fonts")),
  collectRelativeFiles(path.join(pdfjsOutputRoot, "standard_fonts")),
]);
assertSameRelativeFiles(sourceCMaps, exportedCMaps, "PDF.js CMap");
assertSameRelativeFiles(sourceStandardFonts, exportedStandardFonts, "PDF.js standard-font");

const javaScriptInventory = await createJavaScriptInventory();
const homeClosure = collectRouteClosure(html, javaScriptInventory);
const discoveryClosures = discoveryPages.map((page, index) => {
  const pageHtml = discoveryHtmlPages[index];
  assert.ok(pageHtml !== undefined, `The ${page.path} route must have exported HTML.`);
  return { page, closure: collectRouteClosure(pageHtml, javaScriptInventory) };
});
const routeClosures = toolPages.map((tool, index) => {
  const pageHtml = toolHtmlPages[index];
  assert.ok(pageHtml !== undefined, `The ${tool.path} route must have exported HTML.`);
  return { tool, closure: collectRouteClosure(pageHtml, javaScriptInventory) };
});

for (const marker of DISCOVERY_PROCESSING_MARKERS) {
  assertClosureLacks(homeClosure, marker, `The home route loaded ${marker}.`);
}

for (const { page, closure } of discoveryClosures) {
  for (const marker of DISCOVERY_PROCESSING_MARKERS) {
    assertClosureLacks(closure, marker, `${page.path} unexpectedly loaded ${marker}.`);
  }
}

for (const { tool, closure } of routeClosures) {
  const required = bundleProfileMarkers[tool.bundleProfile];
  assert.ok(required !== undefined, `Unknown bundle profile for ${tool.path}`);
  for (const marker of required) {
    assertClosureHas(closure, marker, `${tool.path} is missing ${marker}.`);
  }
  for (const marker of ALL_PROCESSING_MARKERS.filter(
    (candidate) => !required.includes(candidate),
  )) {
    assertClosureLacks(closure, marker, `${tool.path} unexpectedly loaded ${marker}.`);
  }
}

const exportedCodeFiles = (await collectRelativeFiles(outputRoot)).filter(
  (relativePath) =>
    relativePath.endsWith(".html") || relativePath.endsWith(".js") || relativePath.endsWith(".mjs"),
);
const exportedHtmlAndJavaScript = (
  await Promise.all(
    exportedCodeFiles.map((relativePath) => readFile(path.join(outputRoot, relativePath), "utf8")),
  )
).join("\n");
const remoteUrls = exportedHtmlAndJavaScript.match(REMOTE_URL_PATTERN) ?? [];
for (const remoteUrl of remoteUrls.filter((value) => PDFJS_REMOTE_ASSET_PATTERN.test(value))) {
  const parsed = new URL(remoteUrl);
  assert.equal(parsed.origin, DEPLOYED_ORIGIN, "The static export referenced a PDF.js CDN URL.");
  assert.ok(
    parsed.pathname.startsWith(`/pdfjs/${PDFJS_VERSION}/`),
    "An absolute PDF.js URL must use the pinned same-origin asset path.",
  );
}

console.log("Static export verified.");

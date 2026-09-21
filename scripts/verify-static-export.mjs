import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toolImplementationConfig } from "../apps/web/src/lib/tool-implementations.ts";
import {
  availableToolEntries,
  plannedToolEntries,
} from "../packages/tool-registry/src/tool-catalog.ts";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(repositoryRoot, "apps/web/out");
const IMAGE_WORKER_MARKER = "hereisit-image-worker";
const IMAGE_SERVER_RUNTIME_MARKER = "hereisit-server-runtime";
const IMAGE_WATERMARK_WORKER_MARKER = "hereisit-image-watermark-worker";
const REMOVED_PDF_MARKERS = [
  "hereisit-pdf-",
  "pdf.worker.min.mjs",
  "pdfjs-dist",
  "@cantoo/pdf-lib",
];

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
];
const DISCOVERY_PROCESSING_MARKERS = [
  ...ALL_PROCESSING_MARKERS,
  "ImageWorkbench",
  "ImageWatermarkWorkbench",
  "@hereisit/browser-runtime",
  "@hereisit/image-tool",
  "@hereisit/tool-contracts",
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
  "json-quick": [],
  image: [IMAGE_WORKER_MARKER],
  "image-compression-server": [IMAGE_SERVER_RUNTIME_MARKER, IMAGE_WORKER_MARKER],
  "image-extra": [],
  "image-watermark": [IMAGE_WATERMARK_WORKER_MARKER],
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

const exportedFiles = await collectRelativeFiles(outputRoot);
assert.ok(
  exportedFiles.every((file) => !/^pdf(?:js)?(?:\/|\.|$)/i.test(file) && !file.endsWith(".pdf")),
  "The static export must not publish removed PDF routes or assets.",
);

await Promise.all([
  access(path.join(outputRoot, "index.html")),
  access(path.join(outputRoot, "404.html")),
  access(path.join(outputRoot, "_headers")),
  access(path.join(outputRoot, "sitemap.xml")),
  access(path.join(outputRoot, "robots.txt")),
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
assert.doesNotMatch(sitemap, /<loc>[^<]*\/pdf(?:\/|<)/);
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
for (const marker of REMOVED_PDF_MARKERS) {
  assertClosureLacks(
    scriptSources,
    marker,
    `The static export contains removed PDF code: ${marker}`,
  );
}

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

console.log("Static export verified.");

import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PDFJS_VERSION = "6.1.200";
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(repositoryRoot, "apps/web/out");
const pdfjsPackageRoot = path.join(
  repositoryRoot,
  "packages/browser-runtime/node_modules/pdfjs-dist",
);
const pdfjsOutputRoot = path.join(outputRoot, "pdfjs", PDFJS_VERSION);

const IMAGE_WORKER_MARKER = "hereisit-image-worker";
const IMAGE_WATERMARK_WORKER_MARKER = "hereisit-image-watermark-worker";
const PDF_WORKER_MARKER = "hereisit-pdf-worker";
const PDF_INSPECTION_WORKER_MARKER = "hereisit-pdf-inspection-worker";
const PDF_TO_IMAGES_WORKER_MARKER = "hereisit-pdf-to-images-worker";
const PDF_COMPRESS_SCANNED_WORKER_MARKER = "hereisit-pdf-compress-scanned-worker";
const PDFJS_MARKER = "pdf.worker.min.mjs";
const DEPLOYED_ORIGIN = "https://hereisit.pages.dev";
const REMOTE_URL_PATTERN = /https?:\/\/[^"'`\s<>()\\]+/gi;
const PDFJS_REMOTE_ASSET_PATTERN =
  /(?:pdfjs(?:-dist)?|pdf\.js|pdf\.worker(?:\.min)?\.mjs|\/cmaps\/|\/standard_fonts\/)/i;

const toolPages = [
  {
    file: "image/compress.html",
    path: "/image/compress",
    routeClass: "image",
    title: "이미지 용량 줄이기",
    description: "JPG, PNG, WebP, HEIC 이미지를 무료로 압축하세요.",
  },
  {
    file: "image/resize.html",
    path: "/image/resize",
    routeClass: "image",
    title: "이미지 크기 조절",
    description: "사진의 가로·세로 크기를 빠르게 바꾸세요.",
  },
  {
    file: "image/convert.html",
    path: "/image/convert",
    routeClass: "image",
    title: "이미지 형식 변환",
    description: "JPG, PNG, WebP, HEIC 이미지를 원하는 형식으로 변환하세요.",
  },
  {
    file: "image/watermark.html",
    path: "/image/watermark",
    routeClass: "image-watermark",
    title: "이미지에 워터마크 넣기",
    description: "사진과 이미지에 문구 또는 로고를 넣으세요.",
  },
  {
    file: "pdf/merge.html",
    path: "/pdf/merge",
    routeClass: "editing",
    title: "PDF 합치기",
    description: "여러 PDF 파일을 원하는 순서대로 하나로 합치세요.",
  },
  {
    file: "pdf/split.html",
    path: "/pdf/split",
    routeClass: "editing",
    title: "PDF 페이지 분할",
    description: "PDF를 페이지별로 나누거나 필요한 페이지만 추출하세요.",
  },
  {
    file: "pdf/image-to-pdf.html",
    path: "/pdf/image-to-pdf",
    routeClass: "editing",
    title: "이미지를 PDF로 변환",
    description: "JPG와 PNG 이미지를 원하는 순서대로 한 PDF로 만드세요.",
  },
  {
    file: "pdf/organize.html",
    path: "/pdf/organize",
    routeClass: "editing",
    title: "PDF 페이지 정리",
    description: "PDF 페이지 순서를 바꾸고 90도씩 회전하거나 필요 없는 페이지를 빼세요.",
  },
  {
    file: "pdf/watermark.html",
    path: "/pdf/watermark",
    routeClass: "editing",
    title: "PDF 워터마크 넣기",
    description: "PDF 모든 페이지 또는 지정한 페이지에 원하는 문구의 워터마크를 넣으세요.",
  },
  {
    file: "pdf/to-image.html",
    path: "/pdf/to-image",
    routeClass: "pdf-to-images",
    title: "PDF를 JPG·PNG로 변환",
    description:
      "PDF 페이지를 JPG 또는 PNG 이미지로 변환하세요. 업로드 없이 브라우저에서 처리합니다.",
  },
  {
    file: "pdf/compress.html",
    path: "/pdf/compress",
    routeClass: "pdf-compress-scanned",
    title: "스캔 PDF 용량 줄이기",
    description:
      "스캔한 PDF 페이지를 가볍게 다시 만들어 용량을 줄이세요. 파일은 서버로 전송되지 않습니다.",
  },
];

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
  ...toolPages.map((tool) => access(path.join(outputRoot, tool.file))),
]);

const [html, headers, sitemap, robots, ...toolHtmlPages] = await Promise.all([
  readFile(path.join(outputRoot, "index.html"), "utf8"),
  readFile(path.join(outputRoot, "_headers"), "utf8"),
  readFile(path.join(outputRoot, "sitemap.xml"), "utf8"),
  readFile(path.join(outputRoot, "robots.txt"), "utf8"),
  ...toolPages.map((tool) => readFile(path.join(outputRoot, tool.file), "utf8")),
]);
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
  assert.ok(toolHtml.includes(`rel="canonical" href="https://hereisit.pages.dev${tool.path}"`));
  assert.ok(sitemap.includes(`<loc>https://hereisit.pages.dev${tool.path}</loc>`));
}

assert.match(robots, /Sitemap: https:\/\/hereisit\.pages\.dev\/sitemap\.xml/);

const exportedHtml = [html, ...toolHtmlPages].join("\n");
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
const routeClosures = toolPages.map((tool, index) => {
  const pageHtml = toolHtmlPages[index];
  assert.ok(pageHtml !== undefined, `The ${tool.path} route must have exported HTML.`);
  return { tool, closure: collectRouteClosure(pageHtml, javaScriptInventory) };
});
const imageClosures = routeClosures.filter(({ tool }) => tool.routeClass === "image");
const imageWatermarkClosures = routeClosures.filter(
  ({ tool }) => tool.routeClass === "image-watermark",
);
const pdfEditingClosures = routeClosures.filter(({ tool }) => tool.routeClass === "editing");
const toImageClosures = routeClosures.filter(({ tool }) => tool.routeClass === "pdf-to-images");
const compressionClosures = routeClosures.filter(
  ({ tool }) => tool.routeClass === "pdf-compress-scanned",
);

assert.ok(imageClosures.length > 0, "The export inventory must classify image routes.");
assert.equal(
  imageClosures.length,
  3,
  "The export inventory must classify three established image routes.",
);
assert.equal(
  imageWatermarkClosures.length,
  1,
  "The export inventory must classify one image watermark route.",
);
const imageRoutePaths = [...imageClosures, ...imageWatermarkClosures].map(({ tool }) => tool.path);
assert.equal(imageRoutePaths.length, 4, "The export inventory must include four image routes.");
assert.equal(new Set(imageRoutePaths).size, 4, "Every exported image route path must be unique.");
assert.ok(pdfEditingClosures.length > 0, "The export inventory must classify PDF editing routes.");
assert.equal(
  toImageClosures.length,
  1,
  "The export inventory must classify one PDF-to-images route.",
);
assert.equal(
  compressionClosures.length,
  1,
  "The export inventory must classify one scanned PDF compression route.",
);
assert.equal(
  imageClosures.length +
    imageWatermarkClosures.length +
    pdfEditingClosures.length +
    toImageClosures.length +
    compressionClosures.length,
  toolPages.length,
  "Every exported tool route must use a supported route class.",
);

for (const { closure } of imageClosures) {
  assertClosureHas(closure, IMAGE_WORKER_MARKER, "An image route is missing its Worker.");
  assertClosureLacks(
    closure,
    IMAGE_WATERMARK_WORKER_MARKER,
    "An established image route loaded the image watermark Worker.",
  );
  assertClosureLacks(closure, PDF_WORKER_MARKER, "An image route loaded a PDF Worker.");
  assertClosureLacks(
    closure,
    PDF_INSPECTION_WORKER_MARKER,
    "An image route loaded the PDF inspection Worker.",
  );
  assertClosureLacks(
    closure,
    PDF_TO_IMAGES_WORKER_MARKER,
    "An image route loaded the PDF-to-images Worker.",
  );
  assertClosureLacks(
    closure,
    PDF_COMPRESS_SCANNED_WORKER_MARKER,
    "An image route loaded the scanned PDF compression Worker.",
  );
  assertClosureLacks(closure, PDFJS_MARKER, "An image route loaded PDF.js.");
}

for (const { closure } of imageWatermarkClosures) {
  assertClosureHas(
    closure,
    IMAGE_WATERMARK_WORKER_MARKER,
    "The image watermark route is missing its Worker.",
  );
  assertClosureLacks(
    closure,
    IMAGE_WORKER_MARKER,
    "The image watermark route loaded the established image Worker.",
  );
  assertClosureLacks(closure, PDF_WORKER_MARKER, "The image watermark route loaded a PDF Worker.");
  assertClosureLacks(
    closure,
    PDF_INSPECTION_WORKER_MARKER,
    "The image watermark route loaded the PDF inspection Worker.",
  );
  assertClosureLacks(
    closure,
    PDF_TO_IMAGES_WORKER_MARKER,
    "The image watermark route loaded the PDF-to-images Worker.",
  );
  assertClosureLacks(
    closure,
    PDF_COMPRESS_SCANNED_WORKER_MARKER,
    "The image watermark route loaded the scanned PDF compression Worker.",
  );
  assertClosureLacks(closure, PDFJS_MARKER, "The image watermark route loaded PDF.js.");
}

for (const { closure } of pdfEditingClosures) {
  assertClosureHas(closure, PDF_WORKER_MARKER, "A PDF editing route is missing its Worker.");
  assertClosureHas(
    closure,
    PDF_INSPECTION_WORKER_MARKER,
    "A PDF editing route is missing its inspection Worker.",
  );
  assertClosureLacks(closure, IMAGE_WORKER_MARKER, "A PDF editing route loaded the image Worker.");
  assertClosureLacks(
    closure,
    IMAGE_WATERMARK_WORKER_MARKER,
    "A PDF editing route loaded the image watermark Worker.",
  );
  assertClosureLacks(
    closure,
    PDF_TO_IMAGES_WORKER_MARKER,
    "A PDF editing route loaded the PDF-to-images Worker.",
  );
  assertClosureLacks(
    closure,
    PDF_COMPRESS_SCANNED_WORKER_MARKER,
    "A PDF editing route loaded the scanned PDF compression Worker.",
  );
  assertClosureLacks(closure, PDFJS_MARKER, "A PDF editing route loaded PDF.js.");
}

for (const { closure } of toImageClosures) {
  assertClosureLacks(
    closure,
    PDF_WORKER_MARKER,
    "The PDF-to-images route loaded the PDF editing Worker.",
  );
  assertClosureHas(
    closure,
    PDF_INSPECTION_WORKER_MARKER,
    "The PDF-to-images route is missing its inspection Worker.",
  );
  assertClosureHas(
    closure,
    PDF_TO_IMAGES_WORKER_MARKER,
    "The PDF-to-images route is missing its renderer Worker.",
  );
  assertClosureHas(closure, PDFJS_MARKER, "The PDF-to-images route is missing PDF.js.");
  assertClosureLacks(
    closure,
    IMAGE_WORKER_MARKER,
    "The PDF-to-images route loaded the image Worker.",
  );
  assertClosureLacks(
    closure,
    IMAGE_WATERMARK_WORKER_MARKER,
    "The PDF-to-images route loaded the image watermark Worker.",
  );
  assertClosureLacks(
    closure,
    PDF_COMPRESS_SCANNED_WORKER_MARKER,
    "The PDF-to-images route loaded the scanned PDF compression Worker.",
  );
}

for (const { closure } of compressionClosures) {
  assertClosureLacks(
    closure,
    PDF_WORKER_MARKER,
    "The scanned PDF compression route loaded the PDF editing Worker.",
  );
  assertClosureHas(
    closure,
    PDF_INSPECTION_WORKER_MARKER,
    "The scanned PDF compression route is missing its inspection Worker.",
  );
  assertClosureHas(
    closure,
    PDF_COMPRESS_SCANNED_WORKER_MARKER,
    "The scanned PDF compression route is missing its compression Worker.",
  );
  assertClosureHas(closure, PDFJS_MARKER, "The scanned PDF compression route is missing PDF.js.");
  assertClosureLacks(
    closure,
    IMAGE_WORKER_MARKER,
    "The scanned PDF compression route loaded the image Worker.",
  );
  assertClosureLacks(
    closure,
    IMAGE_WATERMARK_WORKER_MARKER,
    "The scanned PDF compression route loaded the image watermark Worker.",
  );
  assertClosureLacks(
    closure,
    PDF_TO_IMAGES_WORKER_MARKER,
    "The scanned PDF compression route loaded the PDF-to-images Worker.",
  );
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

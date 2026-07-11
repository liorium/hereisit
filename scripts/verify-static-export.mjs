import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(repositoryRoot, "apps/web/out");

const toolPages = [
  {
    file: "image/compress.html",
    path: "/image/compress",
    title: "이미지 용량 줄이기",
    description: "JPG, PNG, WebP, HEIC 이미지를 무료로 압축하세요.",
  },
  {
    file: "image/resize.html",
    path: "/image/resize",
    title: "이미지 크기 조절",
    description: "사진의 가로·세로 크기를 빠르게 바꾸세요.",
  },
  {
    file: "image/convert.html",
    path: "/image/convert",
    title: "이미지 형식 변환",
    description: "JPG, PNG, WebP, HEIC 이미지를 원하는 형식으로 변환하세요.",
  },
  {
    file: "pdf/merge.html",
    path: "/pdf/merge",
    title: "PDF 합치기",
    description: "여러 PDF 파일을 원하는 순서대로 하나로 합치세요.",
  },
  {
    file: "pdf/split.html",
    path: "/pdf/split",
    title: "PDF 페이지 분할",
    description: "PDF를 페이지별로 나누거나 필요한 페이지만 추출하세요.",
  },
  {
    file: "pdf/image-to-pdf.html",
    path: "/pdf/image-to-pdf",
    title: "이미지를 PDF로 변환",
    description: "JPG와 PNG 이미지를 원하는 순서대로 한 PDF로 만드세요.",
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

async function readReferencedJavaScript(pageHtml) {
  const scriptPaths = Array.from(
    new Set(
      Array.from(
        pageHtml.matchAll(/<script[^>]+src="(\/_next\/[^"?#]+)["?#]/g),
        (match) => match[1],
      ),
    ),
  );
  return (
    await Promise.all(
      scriptPaths.map((scriptPath) => readFile(path.join(outputRoot, scriptPath.slice(1)), "utf8")),
    )
  ).join("\n");
}

await Promise.all([
  access(path.join(outputRoot, "index.html")),
  access(path.join(outputRoot, "404.html")),
  access(path.join(outputRoot, "_headers")),
  access(path.join(outputRoot, "sitemap.xml")),
  access(path.join(outputRoot, "robots.txt")),
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
  assert.ok(toolHtml.includes(`<title>${tool.title} | HereItIs</title>`));
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
  scriptSources.some((source) => source.includes("hereisit-image-worker")),
  "The static export must include the image Worker bundle.",
);
assert.ok(
  scriptSources.some((source) => source.includes("hereisit-pdf-worker")),
  "The static export must include the PDF Worker bundle.",
);

const imagePageScripts = (
  await Promise.all(toolHtmlPages.slice(0, 3).map(readReferencedJavaScript))
).join("\n");
const pdfPageScripts = (
  await Promise.all(toolHtmlPages.slice(3).map(readReferencedJavaScript))
).join("\n");
assert.match(imagePageScripts, /hereisit-image-worker/);
assert.doesNotMatch(imagePageScripts, /hereisit-pdf-worker/);
assert.match(pdfPageScripts, /hereisit-pdf-worker/);
assert.doesNotMatch(pdfPageScripts, /hereisit-image-worker/);

console.log("Static export verified.");

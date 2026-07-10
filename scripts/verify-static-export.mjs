import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(repositoryRoot, "apps/web/out");

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

await Promise.all([
  access(path.join(outputRoot, "index.html")),
  access(path.join(outputRoot, "404.html")),
  access(path.join(outputRoot, "_headers")),
]);

const [html, headers] = await Promise.all([
  readFile(path.join(outputRoot, "index.html"), "utf8"),
  readFile(path.join(outputRoot, "_headers"), "utf8"),
]);
assert.match(html, /이미지 작업/);
assert.match(headers, /Content-Security-Policy:/);
assert.match(headers, /connect-src \x27self\x27/);

const assetPaths = Array.from(
  html.matchAll(/(?:src|href)="(\/_next\/[^"?#]+)["?#]/g),
  (match) => match[1],
);
assert.ok(assetPaths.length > 0, "The exported page must reference Next.js assets.");
await Promise.all(assetPaths.map((assetPath) => access(path.join(outputRoot, assetPath.slice(1)))));

const scripts = await collectJavaScript(path.join(outputRoot, "_next"));
const workerBundleFound = (
  await Promise.all(scripts.map((script) => readFile(script, "utf8")))
).some((source) => source.includes("hereisit-image-worker"));
assert.ok(workerBundleFound, "The static export must include the image Worker bundle.");

console.log("Static export verified.");

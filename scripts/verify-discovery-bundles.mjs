import assert from "node:assert/strict";
import { access, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const DISCOVERY_ROUTES = ["/", "/tools", "/my-tools", "/workflows"];
const ROUTE_ABSOLUTE_LIMIT = 76_800;
const DISCOVERY_SHARED_ABSOLUTE_LIMIT = 122_880;
const MAXIMUM_GROWTH_BYTES = 10_240;
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = path.join(repositoryRoot, "apps/web");
const nextRoot = path.join(webRoot, ".next");
const outputRoot = path.join(webRoot, "out");
const baselinePath = path.join(repositoryRoot, "scripts/discovery-bundle-baseline.json");

const FORBIDDEN_PROCESSOR_MARKERS = [
  "ImageWorkbench",
  "ImageWatermarkWorkbench",
  "PdfWorkbench",
  "PdfCompressWorkbench",
  "PdfToImageWorkbench",
  "hereisit-image-worker",
  "hereisit-image-watermark-worker",
  "hereisit-pdf-worker",
  "hereisit-pdf-inspection-worker",
  "hereisit-pdf-to-images-worker",
  "hereisit-pdf-compress-scanned-worker",
  "pdf.worker.min.mjs",
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

function routeHtmlFile(route) {
  return route === "/" ? "index.html" : `${route.replace(/^\/+|\/+$/g, "")}.html`;
}

function sumChunkSizes(chunks, gzipSizes) {
  let total = 0;
  for (const chunk of chunks) {
    const size = gzipSizes[chunk];
    assert.ok(
      Number.isSafeInteger(size) && size >= 0,
      `Missing a non-negative gzip measurement for ${chunk}.`,
    );
    total += size;
  }
  return total;
}

export function calculateBundleMeasurement(discoveryRoutes, allBuiltRoutes, gzipSizes) {
  assert.ok(allBuiltRoutes.length > 0, "At least one built app route is required.");
  for (const route of DISCOVERY_ROUTES) {
    assert.ok(Array.isArray(discoveryRoutes[route]), `Missing discovery route ${route}.`);
  }

  const frameworkShared = new Set(allBuiltRoutes[0]);
  for (const chunks of allBuiltRoutes.slice(1)) {
    for (const chunk of frameworkShared) {
      if (!chunks.includes(chunk)) frameworkShared.delete(chunk);
    }
  }

  const discoveryMembership = new Map();
  for (const route of DISCOVERY_ROUTES) {
    for (const chunk of new Set(discoveryRoutes[route])) {
      if (frameworkShared.has(chunk)) continue;
      const routes = discoveryMembership.get(chunk) ?? [];
      routes.push(route);
      discoveryMembership.set(chunk, routes);
    }
  }

  const discoveryShared = [];
  const routeOwned = Object.fromEntries(DISCOVERY_ROUTES.map((route) => [route, []]));
  for (const [chunk, routes] of discoveryMembership) {
    if (routes.length > 1) discoveryShared.push(chunk);
    else routeOwned[routes[0]].push(chunk);
  }

  return {
    schemaVersion: 1,
    routes: Object.fromEntries(
      DISCOVERY_ROUTES.map((route) => [route, sumChunkSizes(routeOwned[route], gzipSizes)]),
    ),
    discoveryShared: sumChunkSizes(discoveryShared, gzipSizes),
    frameworkSharedReported: sumChunkSizes(frameworkShared, gzipSizes),
  };
}

function assertMeasurementShape(measurement, label) {
  assert.equal(measurement?.schemaVersion, 1, `${label} has an unsupported schema version.`);
  assert.ok(measurement.routes !== null && typeof measurement.routes === "object");
  for (const route of DISCOVERY_ROUTES) {
    assert.ok(
      Number.isSafeInteger(measurement.routes[route]) && measurement.routes[route] >= 0,
      `${label} has an invalid ${route} measurement.`,
    );
  }
  assert.ok(
    Number.isSafeInteger(measurement.discoveryShared) && measurement.discoveryShared >= 0,
    `${label} has an invalid discovery-shared measurement.`,
  );
  assert.ok(
    Number.isSafeInteger(measurement.frameworkSharedReported) &&
      measurement.frameworkSharedReported >= 0,
    `${label} has an invalid framework-shared measurement.`,
  );
}

function growthAllowance(baseline) {
  return Math.min(MAXIMUM_GROWTH_BYTES, Math.floor(baseline * 0.1));
}

export function validateBundleMeasurement(measurement, baseline) {
  assertMeasurementShape(measurement, "Bundle measurement");
  for (const route of DISCOVERY_ROUTES) {
    assert.ok(
      measurement.routes[route] <= ROUTE_ABSOLUTE_LIMIT,
      `${route} exceeded the route-owned absolute limit.`,
    );
  }
  assert.ok(
    measurement.discoveryShared <= DISCOVERY_SHARED_ABSOLUTE_LIMIT,
    "The discovery-shared layer exceeded its absolute limit.",
  );

  if (baseline === undefined) return;
  assertMeasurementShape(baseline, "Bundle baseline");
  for (const route of DISCOVERY_ROUTES) {
    assert.ok(
      measurement.routes[route] <= baseline.routes[route] + growthAllowance(baseline.routes[route]),
      `${route} exceeded its baseline growth allowance.`,
    );
  }
  assert.ok(
    measurement.discoveryShared <=
      baseline.discoveryShared + growthAllowance(baseline.discoveryShared),
    "The discovery-shared layer exceeded its baseline growth allowance.",
  );
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
  const chunksRoot = path.join(outputRoot, "_next/static/chunks");
  const entries = await readdir(chunksRoot, { recursive: true, withFileTypes: true });
  const inventory = new Map();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
    const absolutePath = path.join(entry.parentPath, entry.name);
    const chunkPath = `/${path.relative(outputRoot, absolutePath).split(path.sep).join("/")}`;
    const bytes = await readFile(absolutePath);
    inventory.set(chunkPath, {
      gzipBytes: gzipSync(bytes, { level: 9 }).byteLength,
      source: bytes.toString("utf8"),
    });
  }
  return inventory;
}

function collectRouteClosure(pageHtml, inventory) {
  const pending = [...readPageScriptPaths(pageHtml)];
  const closure = new Set();
  while (pending.length > 0) {
    const chunk = pending.shift();
    if (chunk === undefined || closure.has(chunk)) continue;
    const asset = inventory.get(chunk);
    assert.ok(asset !== undefined, `Exported HTML references a missing chunk: ${chunk}.`);
    closure.add(chunk);
    for (const referencedChunk of readLiteralNextScriptPaths(asset.source)) {
      if (inventory.has(referencedChunk) && !closure.has(referencedChunk)) {
        pending.push(referencedChunk);
      }
    }
  }
  return [...closure];
}

async function readBuiltRouteClosures(inventory) {
  const [appRouteManifest, buildManifest] = await Promise.all([
    readFile(path.join(nextRoot, "app-path-routes-manifest.json"), "utf8").then(JSON.parse),
    readFile(path.join(nextRoot, "build-manifest.json"), "utf8").then(JSON.parse),
  ]);
  const routeClosures = new Map();
  for (const [internalRoute, publicRoute] of Object.entries(appRouteManifest)) {
    if (!internalRoute.endsWith("/page")) continue;
    let html;
    try {
      html = await readFile(path.join(outputRoot, routeHtmlFile(publicRoute)), "utf8");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      html = await readFile(path.join(nextRoot, "server/app", routeHtmlFile(publicRoute)), "utf8");
    }
    routeClosures.set(publicRoute, collectRouteClosure(html, inventory));
  }

  const manifestShared = [...buildManifest.polyfillFiles, ...buildManifest.rootMainFiles].map(
    (chunk) => `/_next/${chunk}`,
  );
  for (const [route, closure] of routeClosures) {
    for (const chunk of manifestShared) {
      assert.ok(closure.includes(chunk), `${route} is missing a Next build-manifest shared chunk.`);
    }
  }
  return routeClosures;
}

export function findForbiddenProcessorMarkers(routeClosures, chunkSources) {
  const findings = [];
  for (const route of DISCOVERY_ROUTES) {
    const closure = routeClosures[route];
    assert.ok(closure !== undefined, `The production build is missing ${route}.`);
    const routeMarkers = new Set();
    for (const chunk of closure) {
      const source = chunkSources[chunk] ?? "";
      for (const marker of FORBIDDEN_PROCESSOR_MARKERS) {
        if (source.includes(marker)) routeMarkers.add(marker);
      }
    }
    for (const marker of routeMarkers) findings.push({ route, marker });
  }
  return findings;
}

function assertNoProcessorMarkers(routeClosures, inventory) {
  const closures = Object.fromEntries(
    DISCOVERY_ROUTES.map((route) => [route, routeClosures.get(route)]),
  );
  const sources = Object.fromEntries([...inventory].map(([chunk, asset]) => [chunk, asset.source]));
  const findings = findForbiddenProcessorMarkers(closures, sources);
  assert.deepEqual(
    findings,
    [],
    findings.map(({ route, marker }) => `${route}: ${marker}`).join("\n"),
  );
}

async function measureProductionBuild() {
  await Promise.all([
    access(path.join(nextRoot, "BUILD_ID")),
    access(path.join(outputRoot, "index.html")),
    ...DISCOVERY_ROUTES.slice(1).map((route) =>
      access(path.join(outputRoot, routeHtmlFile(route))),
    ),
  ]);
  const inventory = await createJavaScriptInventory();
  const routeClosures = await readBuiltRouteClosures(inventory);
  assertNoProcessorMarkers(routeClosures, inventory);
  const gzipSizes = Object.fromEntries(
    [...inventory].map(([chunk, asset]) => [chunk, asset.gzipBytes]),
  );
  return calculateBundleMeasurement(
    Object.fromEntries(DISCOVERY_ROUTES.map((route) => [route, routeClosures.get(route)])),
    [...routeClosures.values()],
    gzipSizes,
  );
}

async function main() {
  const writeBaseline = process.argv.slice(2).includes("--write-baseline");
  const unknownArguments = process.argv
    .slice(2)
    .filter((argument) => argument !== "--write-baseline");
  assert.deepEqual(unknownArguments, [], "Unknown discovery bundle verifier argument.");

  const measurement = await measureProductionBuild();
  if (writeBaseline) {
    validateBundleMeasurement(measurement);
    await writeFile(baselinePath, `${JSON.stringify(measurement, null, 2)}\n`, "utf8");
    console.log("Discovery bundle baseline written.");
    return;
  }

  const baseline = await readFile(baselinePath, "utf8").then(JSON.parse);
  validateBundleMeasurement(measurement, baseline);
  console.log("Discovery bundle budgets verified.");
  console.log(JSON.stringify(measurement));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

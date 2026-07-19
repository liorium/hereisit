import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertExactKeys,
  assertObject,
  assertSha256,
  canonicalize,
  parseCliArguments,
  writeCanonicalJsonAtomic,
} from "./image-lab-common.mjs";

const require = createRequire(import.meta.url);
const sharp = require("../apps/image-engine/node_modules/sharp");
const mimeByFormat = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

export async function recordCompetitorBaseline({ manifest, observations }) {
  if (
    !Array.isArray(manifest?.entries) ||
    !Array.isArray(observations) ||
    observations.length === 0
  ) {
    throw new TypeError("manifest and local competitor observations are required");
  }
  const corpus = new Map(manifest.entries.map((entry) => [entry.id, entry]));
  const records = [];
  for (const observation of observations) {
    const value = assertObject(observation, "competitor observation");
    assertExactKeys(
      value,
      [
        "vendor",
        "tool",
        "toolVersionOrObservedBuild",
        "observedAt",
        "settings",
        "authorization",
        "corpusId",
        "outputPath",
        "metricBuildIds",
        "ssimulacra2",
        "butteraugli",
        "normalizedPixelMatch",
      ],
      "competitor observation",
    );
    const entry = corpus.get(value.corpusId);
    if (!entry) throw new TypeError(`unknown corpus ID ${value.corpusId}`);
    const authorization = assertObject(value.authorization, "authorization");
    assertExactKeys(authorization, ["owner", "basis", "referenceHash"], "authorization");
    if (!["owned-input", "written-permission"].includes(authorization.basis))
      throw new TypeError("competitor input authorization is required");
    assertSha256(authorization.referenceHash, "authorization.referenceHash");
    if (authorization.basis === "owned-input" && authorization.referenceHash !== entry.sha256)
      throw new TypeError("owned-input authorization must bind the corpus input hash");
    if (typeof value.outputPath !== "string" || /^https?:/i.test(value.outputPath))
      throw new TypeError("only manually downloaded local outputs are accepted");
    const bytes = await readFile(value.outputPath);
    const metadata = await sharp(bytes, {
      failOn: "error",
      limitInputPixels: 40_000_000,
    }).metadata();
    const outputMime = mimeByFormat[metadata.format];
    if (
      !outputMime ||
      metadata.width !== entry.expected.width ||
      metadata.height !== entry.expected.height
    )
      throw new TypeError("competitor output format or dimensions are not comparable");
    const metricBuildIds = assertObject(value.metricBuildIds, "metricBuildIds");
    assertExactKeys(metricBuildIds, ["ssimulacra2", "butteraugli"], "metricBuildIds");
    for (const build of Object.values(metricBuildIds))
      if (typeof build !== "string" || !build.includes("0.11.2"))
        throw new TypeError("pinned libjxl 0.11.2 metric build IDs are required");
    records.push({
      vendor: value.vendor,
      tool: value.tool,
      toolVersionOrObservedBuild: value.toolVersionOrObservedBuild,
      observedAt: value.observedAt,
      settings: value.settings,
      authorization,
      corpusId: value.corpusId,
      inputSha256: entry.sha256,
      outputSha256: createHash("sha256").update(bytes).digest("hex"),
      outputMime,
      outputBytes: bytes.byteLength,
      width: metadata.width,
      height: metadata.height,
      metricBuildIds,
      ssimulacra2: value.ssimulacra2,
      butteraugli: value.butteraugli,
      normalizedPixelMatch: value.normalizedPixelMatch,
    });
  }
  return canonicalize(records.sort((left, right) => left.corpusId.localeCompare(right.corpusId)));
}

async function main() {
  const args = parseCliArguments(process.argv.slice(2));
  if (!args.manifest || !args.observations || !args.output || Object.keys(args).length !== 3)
    throw new TypeError(
      "usage: record-competitor-baseline --manifest <json> --observations <json> --output <json>",
    );
  const manifest = JSON.parse(await readFile(args.manifest, "utf8"));
  const input = JSON.parse(await readFile(args.observations, "utf8"));
  const observations = input.map((entry) => ({
    ...entry,
    outputPath: resolve(dirname(args.observations), entry.outputPath),
  }));
  const records = await recordCompetitorBaseline({ manifest, observations });
  const hash = await writeCanonicalJsonAtomic(args.output, records);
  process.stdout.write(`${hash}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });

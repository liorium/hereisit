import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateCanonicalProcessingReleaseInputs } from "./create-processing-release-inputs.mjs";
import {
  assertExactKeys,
  assertSha256,
  parseCliArguments,
  readBoundedRegularFile,
  sha256Bytes,
} from "./image-lab-common.mjs";

const maximumReleaseInputBytes = 1024 * 1024;
const fields = Object.freeze({
  maxCostPer1000JobsMicrousd: (document) => document.ceilings.maxCostPer1000JobsMicrousd,
  maxLiveMedianOutputRatioBps: (document) => document.ceilings.maxLiveMedianOutputRatioBps,
  maxLiveP95WeightedUnits: (document) => document.ceilings.maxLiveP95WeightedUnits,
  maxLiveOriginalRetainedRateBps: (document) => document.ceilings.maxLiveOriginalRetainedRateBps,
  maxProjectedMonthlyCostMicrousd: (document) => document.ceilings.maxProjectedMonthlyCostMicrousd,
});

export async function readProcessingReleaseInputField({
  releaseInputsPath,
  expectedSha256,
  field,
}) {
  assertSha256(expectedSha256, "expected processing release input hash");
  if (typeof field !== "string" || !Object.hasOwn(fields, field)) {
    throw new TypeError("processing release input field is not allowlisted");
  }
  const bytes = await readBoundedRegularFile(
    releaseInputsPath,
    maximumReleaseInputBytes,
    "processing release inputs",
  );
  const document = validateCanonicalProcessingReleaseInputs(bytes);
  if (sha256Bytes(bytes) !== expectedSha256) {
    throw new TypeError("processing release input hash does not match");
  }
  return fields[field](document);
}

export async function runProcessingReleaseInputReader(argv, stdout = process.stdout) {
  const args = parseCliArguments(argv);
  assertExactKeys(
    args,
    ["release-inputs", "expected-sha256", "field"],
    "processing release input reader arguments",
  );
  const value = await readProcessingReleaseInputField({
    releaseInputsPath: resolve(args["release-inputs"]),
    expectedSha256: args["expected-sha256"],
    field: args.field,
  });
  stdout.write(`${value}\n`);
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    await runProcessingReleaseInputReader(process.argv.slice(2));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "processing release input reader failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

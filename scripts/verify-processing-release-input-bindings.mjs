import { constants } from "node:fs";
import { open } from "node:fs/promises";
import {
  canonicalJson,
  createLiveCostModel,
  liveCostInputFromReleaseDocument,
  validateLiveCostModelDocument,
} from "./create-live-cost-model.mjs";
import { validateCanonicalProcessingReleaseInputs } from "./create-processing-release-inputs.mjs";
import { sha256Bytes } from "./image-lab-common.mjs";

const maximumDocumentBytes = 1024 * 1024;

async function readBoundedRegularFile(path, label) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === "ELOOP") throw new TypeError(`${label} must not be a symbolic link`);
    throw new Error(`${label} could not be read`);
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > maximumDocumentBytes) {
      throw new RangeError(`${label} is not a bounded regular file`);
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength !== metadata.size) throw new TypeError(`${label} changed while reading`);
    return bytes;
  } finally {
    await handle.close();
  }
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes);
  } catch {
    throw new TypeError(`${label} is not valid JSON`);
  }
}

export function assertReviewedPdfCostBinding(reviewed, report, benchmarkSha256, engineImageDigest) {
  const maximumCandidates = Math.max(
    ...report.records.map((record) => record.native.maximumCandidateCount),
  );
  if (
    reviewed === undefined ||
    reviewed.evidenceSha256 !== benchmarkSha256 ||
    reviewed.engineImageId !== engineImageDigest ||
    reviewed.engineImageDigest !== engineImageDigest ||
    reviewed.maximumCandidates !== maximumCandidates ||
    reviewed.maximumInputBytes !== report.limits.maximumSourceBytes ||
    reviewed.maximumOutputBytes !== report.limits.maximumOutputBytes ||
    reviewed.maximumMeasuredPeakRssBytes !== report.summary.maximumPeakRssBytes
  ) {
    throw new TypeError("reviewed PDF cost inputs do not match the exact benchmark evidence");
  }
}

export async function verifyProcessingReleaseInputBindings({
  releaseInputsPath,
  liveCostModelPath,
  expectedReleaseId,
}) {
  const [releaseBytes, costBytes] = await Promise.all([
    readBoundedRegularFile(releaseInputsPath, "processing release inputs"),
    readBoundedRegularFile(liveCostModelPath, "live cost model"),
  ]);
  const releaseInputs = validateCanonicalProcessingReleaseInputs(releaseBytes);
  if (releaseInputs.releaseId !== expectedReleaseId) {
    throw new TypeError("processing release inputs do not match the candidate release ID");
  }
  const liveCostModel = validateLiveCostModelDocument(parseJson(costBytes, "live cost model"));
  if (!costBytes.equals(Buffer.from(canonicalJson(liveCostModel)))) {
    throw new TypeError("live cost model is not canonical");
  }
  const expectedCostModel = createLiveCostModel(liveCostInputFromReleaseDocument(releaseInputs));
  if (canonicalJson(liveCostModel) !== canonicalJson(expectedCostModel)) {
    throw new TypeError("live cost model does not match the reviewed processing release inputs");
  }

  return {
    releaseInputs: { sha256: sha256Bytes(releaseBytes) },
    costModel: { sha256: sha256Bytes(costBytes) },
    reviewedPdfBenchmark: releaseInputs.pricesAndResources.modelInput.pdfBenchmark,
  };
}

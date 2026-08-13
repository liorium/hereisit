import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertExactKeys,
  assertObject,
  assertSha256,
  canonicalize,
  canonicalJson,
  parseCliArguments,
  readBoundedRegularFile,
  sha256Canonical,
  writeCanonicalJsonAtomic,
} from "./image-lab-common.mjs";

const maximumDocumentBytes = 1024 * 1024;
const maximumBundleBytes = 8 * 1024 * 1024;
const releaseIdPattern = /^\d{4}-\d{2}-\d{2}\.[1-9]\d*$/;
const gitShaPattern = /^[a-f0-9]{40}$/;
const projectedMimeKeys = new Set(["inputMime", "outputMime"]);
const allowedProjectedMimeValues = new Set([null, "image/jpeg", "image/png", "image/webp"]);
const forbiddenKeyPattern =
  /^(?:path|filename|fileName|url|uri|secret|token|credential|password|thumbnail|bytes|content|data)$/i;
const forbiddenStringPattern =
  /(?:https?|file|data|blob):|image\/|video\/|[a-z]:[\\/]|\\\\[^\\\s]+\\[^\\\s]+|(?:^|[^a-z0-9._~-])\/[^\s"'()]*/i;
export const processingEvidenceReportNames = Object.freeze([
  "fullCorpusBenchmark",
  "competitorComparison",
  "blindedHumanReview",
  "commercialReview",
  "privacyReview",
  "deviceMatrix",
]);

function assertPattern(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function assertCanonicalTimestamp(value, label) {
  if (typeof value !== "string") throw new TypeError(`${label} must be a canonical timestamp`);
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.valueOf()) || timestamp.toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical timestamp`);
  }
  return value;
}

function isApprovalReference(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    value.kind === "approval-reference"
  );
}

function validateApprovalReference(value, label) {
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  assertExactKeys(value, ["kind", "href", "sha256"], label);
  if (typeof value.href !== "string") throw new TypeError(`${label} URL must be a string`);
  assertSha256(value.sha256, `${label} hash`);
  let url;
  try {
    url = new URL(value.href);
  } catch {
    throw new TypeError(`${label} URL is invalid`);
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "approvals.example.test" ||
    !/^\/reviews\/[1-9]\d*$/.test(url.pathname) ||
    url.search !== "" ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new TypeError(`${label} must contain a safe HTTPS URL`);
  }
}

function validateDocumentValue(value, label, depth = 0) {
  if (depth > 32) throw new RangeError(`${label} exceeds the maximum depth`);
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${label} numbers must be finite`);
    return;
  }
  if (typeof value === "string") {
    if (forbiddenStringPattern.test(value))
      throw new TypeError(`${label} contains a forbidden value`);
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index))
        throw new TypeError(`${label} must not contain sparse arrays`);
      validateDocumentValue(value[index], `${label} item`, depth + 1);
    }
    return;
  }
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`${label} contains a non-JSON value`);
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`${label} must not contain prototype-bearing objects`);
  }
  if (isApprovalReference(value)) {
    validateApprovalReference(value, `${label} approval reference`);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenKeyPattern.test(key) || projectedMimeKeys.has(key)) {
      throw new TypeError(`${label} contains a forbidden key`);
    }
    validateDocumentValue(child, `${label} field`, depth + 1);
  }
}

function projectDocumentValue(value, label, depth = 0) {
  if (depth > 32) throw new RangeError(`${label} exceeds the maximum depth`);
  if (Array.isArray(value)) {
    return value.map((child, index) => {
      if (!Object.hasOwn(value, index))
        throw new TypeError(`${label} must not contain sparse arrays`);
      return projectDocumentValue(child, `${label} item`, depth + 1);
    });
  }
  if (typeof value !== "object" || value === null) return value;
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`${label} must not contain prototype-bearing objects`);
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) => {
      if (!projectedMimeKeys.has(key)) {
        return [[key, projectDocumentValue(child, `${label} field`, depth + 1)]];
      }
      if (!allowedProjectedMimeValues.has(child)) {
        throw new TypeError(`${label} contains an invalid MIME projection value`);
      }
      return [];
    }),
  );
}

function validateIdentity(bundle) {
  if (bundle.schema !== "hereisit-processing-evidence@1" || bundle.version !== 1) {
    throw new TypeError("processing evidence schema or version is invalid");
  }
  assertPattern(bundle.releaseId, releaseIdPattern, "processing evidence release ID");
  assertPattern(bundle.gitSha, gitShaPattern, "processing evidence git SHA");
  assertSha256(
    bundle.candidateVerificationSha256,
    "processing evidence candidate verification hash",
  );
  assertCanonicalTimestamp(bundle.createdAt, "processing evidence creation time");
  assertCanonicalTimestamp(bundle.expiresAt, "processing evidence expiry time");
  if (new Date(bundle.expiresAt).valueOf() <= new Date(bundle.createdAt).valueOf()) {
    throw new TypeError("processing evidence expiry must be after creation");
  }
}

export function validateProcessingEvidenceBundle(value) {
  const bundle = assertObject(value, "processing evidence bundle");
  assertExactKeys(
    bundle,
    [
      "schema",
      "version",
      "releaseId",
      "gitSha",
      "candidateVerificationSha256",
      "createdAt",
      "expiresAt",
      "reports",
    ],
    "processing evidence bundle",
  );
  validateIdentity(bundle);
  const reports = assertObject(bundle.reports, "processing evidence reports");
  assertExactKeys(reports, processingEvidenceReportNames, "processing evidence reports");
  for (const name of processingEvidenceReportNames) {
    const entry = assertObject(reports[name], `${name} report`);
    assertExactKeys(entry, ["sourceSha256", "summarySha256", "document"], `${name} report`);
    assertSha256(entry.sourceSha256, `${name} source report hash`);
    assertSha256(entry.summarySha256, `${name} summary report hash`);
    validateDocumentValue(entry.document, `${name} report document`);
    if (Buffer.byteLength(canonicalJson(entry.document)) > maximumDocumentBytes) {
      throw new RangeError(`${name} report document exceeds the size limit`);
    }
    if (sha256Canonical(entry.document) !== entry.summarySha256) {
      throw new TypeError(`${name} summary report hash does not match`);
    }
  }
  if (Buffer.byteLength(canonicalJson(bundle)) > maximumBundleBytes) {
    throw new RangeError("processing evidence bundle exceeds the size limit");
  }
  return bundle;
}

export function createProcessingEvidenceBundle({
  releaseId,
  gitSha,
  candidateVerificationSha256,
  createdAt,
  expiresAt,
  reports,
}) {
  const documents = assertObject(reports, "processing evidence reports");
  assertExactKeys(documents, processingEvidenceReportNames, "processing evidence reports");
  const entries = Object.fromEntries(
    processingEvidenceReportNames.map((name) => {
      const source = documents[name];
      const document = projectDocumentValue(source, `${name} report document`);
      validateDocumentValue(document, `${name} report document`);
      if (Buffer.byteLength(canonicalJson(source)) > maximumDocumentBytes) {
        throw new RangeError(`${name} report document exceeds the size limit`);
      }
      return [
        name,
        {
          sourceSha256: sha256Canonical(source),
          summarySha256: sha256Canonical(document),
          document,
        },
      ];
    }),
  );
  return canonicalize(
    validateProcessingEvidenceBundle({
      schema: "hereisit-processing-evidence@1",
      version: 1,
      releaseId,
      gitSha,
      candidateVerificationSha256,
      createdAt,
      expiresAt,
      reports: entries,
    }),
  );
}

export async function writeProcessingEvidenceBundle({ output, ...inputs }) {
  const bundle = createProcessingEvidenceBundle(inputs);
  return writeCanonicalJsonAtomic(output, bundle, { refuseOverwrite: true, mode: 0o600 });
}

const reportCliNames = {
  "full-corpus-benchmark": "fullCorpusBenchmark",
  "competitor-comparison": "competitorComparison",
  "blinded-human-review": "blindedHumanReview",
  "commercial-review": "commercialReview",
  "privacy-review": "privacyReview",
  "device-matrix": "deviceMatrix",
};

async function readReport(path, name) {
  const bytes = await readBoundedRegularFile(path, maximumDocumentBytes, `${name} report`);
  try {
    return JSON.parse(bytes);
  } catch {
    throw new TypeError(`${name} report is not valid JSON`);
  }
}

export async function runProcessingEvidenceBundleCreatorCli(argv, stdout = process.stdout) {
  const args = parseCliArguments(argv);
  assertExactKeys(
    args,
    [
      "release-id",
      "git-sha",
      "candidate-verification-sha256",
      "created-at",
      "expires-at",
      ...Object.keys(reportCliNames),
      "schema",
      "output",
    ],
    "processing evidence creator arguments",
  );
  await readBoundedRegularFile(args.schema, maximumDocumentBytes, "processing evidence schema");
  const reports = Object.fromEntries(
    await Promise.all(
      Object.entries(reportCliNames).map(async ([argument, name]) => [
        name,
        await readReport(args[argument], name),
      ]),
    ),
  );
  const hash = await writeProcessingEvidenceBundle({
    output: args.output,
    releaseId: args["release-id"],
    gitSha: args["git-sha"],
    candidateVerificationSha256: args["candidate-verification-sha256"],
    createdAt: args["created-at"],
    expiresAt: args["expires-at"],
    reports,
  });
  stdout.write(`${hash}\n`);
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    await runProcessingEvidenceBundleCreatorCli(process.argv.slice(2));
  } catch (error) {
    const message =
      error instanceof Error && !("code" in error)
        ? error.message
        : "processing evidence bundle creation failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

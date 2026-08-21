import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";
import { PDFDocument } from "@cantoo/pdf-lib";
import {
  pdfOptimizeCreateResponseSchema,
  pdfOptimizePolicyResponseSchema,
  pdfOptimizeStatusResponseSchema,
} from "../packages/tool-contracts/src/pdf-optimize.ts";
import {
  assertExactKeys,
  assertObject,
  canonicalJson,
  parseCliArguments,
  writeCanonicalJsonAtomic,
} from "./image-lab-common.mjs";

const STAGING_PAGE_ORIGIN = "https://processing-staging.hereisit.pages.dev";
const STAGING_API_ORIGIN = "https://hereisit-processing-staging.liorium.workers.dev";
const PRODUCTION_PAGE_ORIGIN = "https://hereisit.app";
const PRODUCTION_API_ORIGIN = "https://api.hereisit.app";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const digestPattern = /^sha-256=[A-Za-z0-9+/]{43}=$/;
const MAX_RESULT_BYTES = 50 * 1024 * 1024;
const MAX_CONTROL_BYTES = 16 * 1024;
const DEFAULT_DEADLINE_MS = 20 * 60_000;
const CLEANUP_DEADLINE_MS = 10_000;
const PDF_SMOKE_STAGES = new Set([
  "policy",
  "create",
  "upload",
  "status",
  "result",
  "acknowledgement",
  "delete",
  "sweep",
]);
const traceDownloadShape = [
  ["POST", "/v1/policy", 200],
  ["POST", "/v1/jobs", 201],
  ["PUT", "/v1/jobs/[job]/input", 204],
  ["GET", "/v1/jobs/[job]", 200],
  ["GET", "/v1/jobs/[job]/result", 200],
  ["POST", "/v1/jobs/[job]/downloaded", 204],
  ["DELETE", "/v1/jobs/[job]", 204],
];
const traceRetainedShape = [
  ["POST", "/v1/policy", 200],
  ["POST", "/v1/jobs", 201],
  ["PUT", "/v1/jobs/[job]/input", 204],
  ["GET", "/v1/jobs/[job]", 200],
  ["DELETE", "/v1/jobs/[job]", 204],
];

function apiOriginForPage(pageOrigin) {
  if (pageOrigin === STAGING_PAGE_ORIGIN) return STAGING_API_ORIGIN;
  if (pageOrigin === PRODUCTION_PAGE_ORIGIN) return PRODUCTION_API_ORIGIN;
  throw new TypeError("PDF smoke page origin is invalid");
}

function projectedPath(path) {
  return path.replace(
    /\/v1\/jobs\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/,
    "/v1/jobs/[job]",
  );
}

function sha256Digest(bytes) {
  return `sha-256=${createHash("sha256").update(bytes).digest("base64")}`;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function generatedLosslessPng(width = 1024, height = 1024) {
  const scanlines = Buffer.alloc(height * (1 + width * 3));
  let state = 0x13579bdf;
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    scanlines[row] = 0;
    for (let x = 0; x < width; x += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      const offset = row + 1 + x * 3;
      scanlines[offset] = state & 0xff;
      scanlines[offset + 1] = (state >>> 8) & 0xff;
      scanlines[offset + 2] = (state >>> 16) & 0xff;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export async function createRepositoryOwnedPdf() {
  const document = await PDFDocument.create();
  document.setTitle("HereIsIt deterministic native PDF canary");
  document.setProducer("HereIsIt");
  document.setCreationDate(new Date("2026-08-11T00:00:00.000Z"));
  document.setModificationDate(new Date("2026-08-11T00:00:00.000Z"));
  const image = await document.embedPng(generatedLosslessPng());
  const page = document.addPage([612, 612]);
  page.drawImage(image, { x: 0, y: 0, width: 612, height: 612 });
  return document.save({
    useObjectStreams: true,
    addDefaultPage: false,
    updateFieldAppearances: false,
  });
}

function assertResponseStatus(response, expected, stage) {
  if (response.status !== expected) throw new TypeError(`PDF smoke ${stage} failed`);
}

async function jsonResponse(response, expected, stage) {
  assertResponseStatus(response, expected, stage);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  const declared = response.headers.get("content-length");
  if (
    contentType !== "application/json" ||
    response.body === null ||
    (declared !== null &&
      (!/^(?:0|[1-9]\d*)$/.test(declared) ||
        Number(declared) < 1 ||
        Number(declared) > MAX_CONTROL_BYTES))
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new TypeError(`PDF smoke ${stage} control response envelope is invalid`);
  }
  const expectedBytes = declared === null ? MAX_CONTROL_BYTES : Number(declared);
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > expectedBytes) {
        await reader.cancel().catch(() => undefined);
        throw new TypeError(`PDF smoke ${stage} control response exceeds declared length`);
      }
      chunks.push(value);
    }
    if (declared !== null && received !== expectedBytes) {
      throw new TypeError(`PDF smoke ${stage} control response length is invalid`);
    }
    return assertObject(
      JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8")),
      `PDF smoke ${stage}`,
    );
  } catch {
    throw new TypeError(`PDF smoke ${stage} response is invalid`);
  } finally {
    reader.releaseLock();
  }
}

async function readExactResult(response, expectedBytes) {
  if (
    response.headers.get("content-type") !== "application/pdf" ||
    response.headers.get("content-length") !== String(expectedBytes) ||
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes < 1 ||
    expectedBytes > MAX_RESULT_BYTES ||
    response.body === null
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new TypeError("PDF smoke result envelope is invalid");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > expectedBytes) throw new TypeError("PDF smoke result exceeds declared length");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (received !== expectedBytes) throw new TypeError("PDF smoke result length is invalid");
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    throw new TypeError("PDF smoke result signature is invalid");
  }
  return bytes;
}

function traceEntry(method, path, status, extra = {}) {
  return { method, path: projectedPath(path), status, ...extra };
}

export function validatePdfSmokeTrace(value) {
  const smoke = assertObject(value, "PDF smoke result");
  assertExactKeys(
    smoke,
    [
      "schema",
      "version",
      "passed",
      "verdict",
      "sourceBytes",
      "outputBytes",
      "profile",
      "visualVerified",
      "publicAdmissionReady",
      "exactLengthUpload",
      "digestVerified",
      "downloadedAcknowledged",
      "deleted",
      "sweepPassed",
      "queueIsolation",
      "queues",
      "trace",
    ],
    "PDF smoke result",
  );
  const download = smoke.verdict === "download";
  if (
    smoke.schema !== "hereisit-processing-pdf-smoke@1" ||
    smoke.version !== 1 ||
    smoke.passed !== true ||
    (smoke.verdict !== "download" && smoke.verdict !== "original-retained") ||
    !Number.isSafeInteger(smoke.sourceBytes) ||
    !Number.isSafeInteger(smoke.outputBytes) ||
    smoke.sourceBytes < 1 ||
    (download
      ? smoke.outputBytes < 1 ||
        smoke.outputBytes > smoke.sourceBytes - Math.max(1, Math.ceil(smoke.sourceBytes / 100))
      : smoke.outputBytes !== smoke.sourceBytes) ||
    (smoke.profile !== "structural" &&
      smoke.profile !== "image-optimized" &&
      smoke.profile !== "original-retained")
  ) {
    throw new TypeError("PDF smoke identity is invalid");
  }
  const queues = assertObject(smoke.queues, "PDF smoke queue state");
  assertExactKeys(queues, ["image", "imageDlq", "pdf", "pdfDlq"], "PDF smoke queue state");
  if (
    queues.image !== "paused" ||
    queues.imageDlq !== "paused" ||
    queues.pdf !== "resumed" ||
    queues.pdfDlq !== "paused" ||
    smoke.queueIsolation !== true ||
    smoke.exactLengthUpload !== true ||
    smoke.digestVerified !== true ||
    smoke.downloadedAcknowledged !== download ||
    smoke.deleted !== true ||
    smoke.sweepPassed !== true ||
    (!download && smoke.profile !== "original-retained")
  ) {
    throw new TypeError("PDF smoke lifecycle did not pass");
  }
  const shape = download ? traceDownloadShape : traceRetainedShape;
  if (!Array.isArray(smoke.trace) || smoke.trace.length !== shape.length) {
    throw new TypeError("PDF smoke trace is incomplete");
  }
  smoke.trace.forEach((entryValue, index) => {
    const entry = assertObject(entryValue, "PDF smoke trace entry");
    const upload = index === 2;
    assertExactKeys(
      entry,
      upload
        ? ["method", "path", "status", "contentLength", "digest"]
        : ["method", "path", "status"],
      "PDF smoke trace entry",
    );
    const expected = shape[index];
    if (
      entry.method !== expected[0] ||
      entry.path !== expected[1] ||
      entry.status !== expected[2]
    ) {
      throw new TypeError("PDF smoke trace order is invalid");
    }
    if (
      upload &&
      (entry.contentLength !== smoke.sourceBytes ||
        typeof entry.digest !== "string" ||
        !digestPattern.test(entry.digest))
    ) {
      throw new TypeError("PDF smoke upload integrity is invalid");
    }
  });
  if (
    smoke.publicAdmissionReady !==
    (download && smoke.profile === "image-optimized" && smoke.visualVerified === true)
  ) {
    throw new TypeError("PDF public admission is not bound to visual evidence");
  }
  return smoke;
}

export function createPdfSmokeResult(input) {
  const verdict = input.verdict ?? "download";
  return validatePdfSmokeTrace({
    schema: "hereisit-processing-pdf-smoke@1",
    version: 1,
    passed: true,
    verdict,
    sourceBytes: input.sourceBytes,
    outputBytes: input.outputBytes,
    profile: input.profile,
    visualVerified: input.visualVerified,
    publicAdmissionReady:
      verdict === "download" &&
      input.profile === "image-optimized" &&
      input.visualVerified === true,
    exactLengthUpload: true,
    digestVerified: true,
    downloadedAcknowledged: verdict === "download",
    deleted: true,
    sweepPassed: input.sweepPassed,
    queueIsolation: true,
    queues: input.queues,
    trace: input.trace,
  });
}

export async function runPdfSmokeLifecycle(input) {
  const pageOrigin = input.pageOrigin;
  const apiOrigin = input.apiOrigin ?? apiOriginForPage(pageOrigin);
  if (!UUID_PATTERN.test(input.sessionId ?? ""))
    throw new TypeError("PDF smoke session is invalid");
  const source = Buffer.from(input.source ?? (await createRepositoryOwnedPdf()));
  if (source.byteLength < 1 || source.byteLength > MAX_RESULT_BYTES) {
    throw new TypeError("PDF smoke source is invalid");
  }
  const fetcher = input.fetch ?? globalThis.fetch;
  const sleep =
    input.sleep ?? ((milliseconds) => new Promise((done) => setTimeout(done, milliseconds)));
  const now = input.now ?? Date.now;
  const deadline = now() + (input.deadlineMs ?? DEFAULT_DEADLINE_MS);
  const timeoutSignal = input.timeoutSignal ?? AbortSignal.timeout;
  const clientRequestId = randomUUID();
  const jobToken = randomBytes(32).toString("base64url");
  const sourceDigest = sha256Digest(source);
  const trace = [];
  let jobId;
  let stage = "policy";
  const request = async (path, init, timeoutMs = 15_000) => {
    const signal = timeoutSignal(Math.min(timeoutMs, Math.max(1, deadline - now())));
    return fetcher(`${apiOrigin}${path}`, {
      ...init,
      headers: { origin: pageOrigin, ...(init.headers ?? {}) },
      cache: "no-store",
      credentials: "omit",
      signal,
    });
  };
  try {
    stage = "policy";
    const policyResponse = await request("/v1/policy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contract: "tool-job@1",
        toolContract: "pdf.optimize@1",
        anonymousSessionId: input.sessionId,
      }),
    });
    const policy = pdfOptimizePolicyResponseSchema.parse(
      await jsonResponse(policyResponse, 200, "policy"),
    );
    trace.push(traceEntry("POST", "/v1/policy", policyResponse.status));
    if (policy.execution !== "server" || policy.maintainer !== (input.anonymous !== true)) {
      throw new TypeError("PDF smoke policy is not server enabled for the requested cohort");
    }
    stage = "create";
    const createResponse = await request("/v1/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contract: "tool-job@1",
        toolContract: "pdf.optimize@1",
        anonymousSessionId: input.sessionId,
        clientRequestId,
        jobToken,
        input: { byteLength: source.byteLength, mime: "application/pdf", pageCount: 1 },
        spec: { version: 1, preset: "balanced" },
      }),
    });
    const created = pdfOptimizeCreateResponseSchema.parse(
      await jsonResponse(createResponse, 201, "create"),
    );
    trace.push(traceEntry("POST", "/v1/jobs", createResponse.status));
    jobId = created.jobId;
    const upload = assertObject(created.upload, "PDF smoke upload descriptor");
    if (
      created.mode !== "upload-required" ||
      !UUID_PATTERN.test(jobId ?? "") ||
      upload.path !== `/v1/jobs/${jobId}/input` ||
      upload.byteLength !== source.byteLength ||
      upload.contentType !== "application/pdf"
    ) {
      throw new TypeError("PDF smoke create response is invalid");
    }
    stage = "upload";
    const uploadResponse = await request(upload.path, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${jobToken}`,
        "content-type": "application/pdf",
        "content-length": String(source.byteLength),
        digest: sourceDigest,
      },
      body: source,
    });
    assertResponseStatus(uploadResponse, 204, "upload");
    trace.push(
      traceEntry("PUT", upload.path, uploadResponse.status, {
        contentLength: source.byteLength,
        digest: sourceDigest,
      }),
    );
    let terminal;
    let lastSequence = -1;
    let lastRank = -1;
    while (now() < deadline) {
      stage = "status";
      const statusResponse = await request(`/v1/jobs/${jobId}`, {
        method: "GET",
        headers: { authorization: `Bearer ${jobToken}` },
      });
      const status = pdfOptimizeStatusResponseSchema.parse(
        await jsonResponse(statusResponse, 200, "status"),
      );
      const rank = ["created", "uploading"].includes(status.state)
        ? 0
        : status.state === "queued"
          ? 1
          : status.state === "running"
            ? 2
            : 3;
      if (
        !Number.isSafeInteger(status.sequence) ||
        status.sequence < lastSequence ||
        rank < lastRank
      ) {
        throw new TypeError("PDF smoke status regressed");
      }
      lastSequence = status.sequence;
      lastRank = rank;
      if (["succeeded", "failed", "cancelled", "expired"].includes(status.state)) {
        terminal = status;
        trace.push(traceEntry("GET", `/v1/jobs/${jobId}`, statusResponse.status));
        break;
      }
      await sleep(1_000);
    }
    const descriptor = assertObject(terminal?.result, "PDF smoke result descriptor");
    if (terminal?.state !== "succeeded" || descriptor.sourceByteLength !== source.byteLength) {
      throw new TypeError("PDF smoke did not succeed");
    }
    let verdict;
    let profile;
    let outputBytes;
    if (descriptor.kind === "original-retained") {
      verdict = "original-retained";
      profile = "original-retained";
      outputBytes = source.byteLength;
    } else {
      stage = "result";
      if (
        descriptor.kind !== "download" ||
        (descriptor.profile !== "structural" && descriptor.profile !== "image-optimized") ||
        descriptor.mime !== "application/pdf" ||
        descriptor.byteLength > source.byteLength - Math.max(1, Math.ceil(source.byteLength / 100))
      ) {
        throw new TypeError("PDF smoke result descriptor is invalid");
      }
      verdict = "download";
      profile = descriptor.profile;
      outputBytes = descriptor.byteLength;
      const resultResponse = await request(`/v1/jobs/${jobId}/result`, {
        method: "GET",
        headers: { authorization: `Bearer ${jobToken}` },
      });
      assertResponseStatus(resultResponse, 200, "result");
      const expectedDigest = resultResponse.headers.get("digest");
      const downloadLease = resultResponse.headers.get("x-download-lease");
      if (!digestPattern.test(expectedDigest ?? "") || !TOKEN_PATTERN.test(downloadLease ?? "")) {
        throw new TypeError("PDF smoke result headers are invalid");
      }
      const resultBytes = await readExactResult(resultResponse, outputBytes);
      if (sha256Digest(resultBytes) !== expectedDigest)
        throw new TypeError("PDF smoke digest mismatch");
      trace.push(traceEntry("GET", `/v1/jobs/${jobId}/result`, resultResponse.status));
      stage = "acknowledgement";
      const acknowledged = await request(`/v1/jobs/${jobId}/downloaded`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${jobToken}`,
          "x-download-lease": downloadLease,
        },
      });
      assertResponseStatus(acknowledged, 204, "acknowledgement");
      trace.push(traceEntry("POST", `/v1/jobs/${jobId}/downloaded`, acknowledged.status));
    }
    stage = "delete";
    const deleted = await request(`/v1/jobs/${jobId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${jobToken}` },
    });
    assertResponseStatus(deleted, 204, "delete");
    trace.push(traceEntry("DELETE", `/v1/jobs/${jobId}`, deleted.status));
    stage = "sweep";
    const swept = await request(`/v1/jobs/${jobId}`, {
      method: "GET",
      headers: { authorization: `Bearer ${jobToken}` },
    });
    if (swept.status !== 404) throw new TypeError("PDF smoke deletion was not observable");
    return createPdfSmokeResult({
      verdict,
      sourceBytes: source.byteLength,
      outputBytes,
      profile,
      visualVerified: false,
      trace,
      queues: { image: "paused", imageDlq: "paused", pdf: "resumed", pdfDlq: "paused" },
      sweepPassed: true,
    });
  } catch (error) {
    if (error instanceof Error && !Object.hasOwn(error, "pdfSmokeStage")) {
      Object.defineProperty(error, "pdfSmokeStage", {
        configurable: true,
        enumerable: false,
        value: stage,
      });
    }
    if (jobId !== undefined) {
      const signal = timeoutSignal(CLEANUP_DEADLINE_MS);
      await fetcher(`${apiOrigin}/v1/jobs/${jobId}`, {
        method: "DELETE",
        headers: { origin: pageOrigin, authorization: `Bearer ${jobToken}` },
        cache: "no-store",
        credentials: "omit",
        signal,
      }).catch(() => undefined);
    }
    throw error;
  }
}

function parseCli(argv, environment) {
  const args = parseCliArguments(argv);
  const pageOrigin = args["page-origin"];
  const outputPath = args.output;
  const anonymous = args.anonymous === "true";
  const sessionId = anonymous
    ? "018f47a2-65d4-7f31-a377-5afbb8f53f27"
    : pageOrigin === STAGING_PAGE_ORIGIN
      ? environment.STAGING_MAINTAINER_SESSION_ID
      : pageOrigin === PRODUCTION_PAGE_ORIGIN
        ? environment.PRODUCTION_MAINTAINER_SESSION_ID
        : undefined;
  if (
    argv.join("\0") !==
      (anonymous
        ? `--page-origin\0${pageOrigin ?? ""}\0--anonymous\0true\0--output\0${outputPath ?? ""}`
        : `--page-origin\0${pageOrigin ?? ""}\0--output\0${outputPath ?? ""}`) ||
    Object.keys(args).sort().join() !==
      (anonymous ? "anonymous,output,page-origin" : "output,page-origin") ||
    typeof outputPath !== "string" ||
    outputPath.length === 0 ||
    !UUID_PATTERN.test(sessionId ?? "")
  ) {
    throw new TypeError("PDF smoke configuration is invalid");
  }
  return { pageOrigin, outputPath, sessionId, anonymous };
}

export async function runPdfSmokeCli({ argv, environment }) {
  const input = parseCli(argv, environment);
  await lstat(input.outputPath).then(
    () => Promise.reject(new TypeError("PDF smoke output already exists")),
    (error) => {
      if (error?.code !== "ENOENT") throw error;
    },
  );
  const result = await runPdfSmokeLifecycle(input);
  await writeCanonicalJsonAtomic(input.outputPath, result, { refuseOverwrite: true, mode: 0o600 });
  return result;
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  runPdfSmokeCli({ argv: process.argv.slice(2), environment: process.env }).catch((error) => {
    const stage =
      error &&
      typeof error === "object" &&
      typeof error.pdfSmokeStage === "string" &&
      PDF_SMOKE_STAGES.has(error.pdfSmokeStage)
        ? error.pdfSmokeStage
        : undefined;
    process.stderr.write(
      `${canonicalJson({
        schema: "hereisit-processing-pdf-smoke-cli@1",
        passed: false,
        reason: "PDF_SMOKE_FAILED",
        ...(stage === undefined ? {} : { stage }),
      })}\n`,
    );
    process.exitCode = 1;
  });
}

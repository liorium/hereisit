import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type EngineCreateJobRequest,
  type EngineJobStatus,
  type EngineMeasurements,
  engineCreateJobRequestSchema,
} from "@hereisit/server-contracts";
import sharp from "sharp";
import { encodeJpegCandidate, JpegCodecError, orientationTransform } from "../codecs/jpeg";
import { verifyJpegCoefficientTransform } from "../codecs/jpeg-coeff-verify";
import { classifyImage, extractImageFeatures } from "../pipeline/classify";
import { type ImageInspection, ImagePipelineError, inspectImage } from "../pipeline/inspect";
import { type NormalizedImageWithSample, normalizeImage } from "../pipeline/normalize";
import {
  type OptimizationPlan,
  type OptimizationPlanningResult,
  planOptimization,
} from "../pipeline/plan";
import { writeJsonAtomic } from "./workspace";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function emit(status: EngineJobStatus): void {
  process.stdout.write(`${JSON.stringify(status)}\n`);
}

function measurements(input: {
  readonly request: EngineCreateJobRequest;
  readonly inspection?: ImageInspection;
  readonly startedAt: number;
}): EngineMeasurements {
  return {
    processedInputBytes: input.request.input.byteLength,
    processedPixels: input.inspection?.pixels ?? 0,
    cpuMs: 0,
    memoryByteMilliseconds: 0,
    peakMemoryBytes: 0,
    testedCandidates: 0,
    processingMs: Math.max(0, Math.round(performance.now() - input.startedAt)),
  };
}

function progress(
  request: EngineCreateJobRequest,
  phase: "validating" | "inspecting" | "normalizing",
  sequence: number,
): void {
  emit({
    protocol: 1,
    jobId: request.jobId,
    state: "running",
    phase,
    fraction: null,
    sequence,
  });
}

function failed(input: {
  readonly request: EngineCreateJobRequest;
  readonly phase: "validating" | "inspecting" | "normalizing" | "optimizing";
  readonly sequence: number;
  readonly code:
    | "UNSUPPORTED_INPUT"
    | "UNSUPPORTED_FEATURE"
    | "INPUT_LIMIT_EXCEEDED"
    | "PIXEL_LIMIT_EXCEEDED"
    | "RESOURCE_CLASS_UPGRADE"
    | "ENGINE_OOM"
    | "ENGINE_CRASH";
  readonly retryable: boolean;
  readonly startedAt: number;
  readonly inspection?: ImageInspection;
  readonly contentClass?:
    | "photo"
    | "screenshot-text"
    | "flat-graphic"
    | "transparent-graphic"
    | "noisy"
    | "already-optimized";
}): void {
  emit({
    protocol: 1,
    jobId: input.request.jobId,
    state: "failed",
    phase: input.phase,
    fraction: null,
    sequence: input.sequence,
    measurements: measurements(input),
    inspection:
      input.inspection === undefined || input.contentClass === undefined
        ? null
        : {
            verifiedInputMime: input.inspection.mime,
            inputHasAlpha: input.inspection.hasAlpha,
            contentClass: input.contentClass,
          },
    error: { code: input.code, retryable: input.retryable },
  });
}

function serializableNormalization(normalized: NormalizedImageWithSample) {
  return {
    rawPath: normalized.rawPath,
    width: normalized.width,
    height: normalized.height,
    channels: normalized.channels,
    sampleDepth: normalized.sampleDepth,
    rawEndian: normalized.rawEndian,
    rawSha256: normalized.rawSha256,
    alphaSha256: normalized.alphaSha256,
    normalizedColorSpace: normalized.normalizedColorSpace,
  };
}

export async function runPlanningPipeline(input: {
  readonly request: EngineCreateJobRequest;
  readonly workspace: string;
}): Promise<void> {
  const startedAt = performance.now();
  let sequence = 4;
  let phase: "validating" | "inspecting" | "normalizing" | "optimizing" = "validating";
  let inspection: ImageInspection | undefined;
  progress(input.request, phase, sequence);
  try {
    const inputPath = join(input.workspace, "input.bin");
    const information = await stat(inputPath);
    if (!information.isFile() || information.size !== input.request.input.byteLength) {
      throw new ImagePipelineError("UNSUPPORTED_INPUT");
    }
    phase = "inspecting";
    sequence += 1;
    progress(input.request, phase, sequence);
    inspection = await inspectImage(inputPath, input.request.input.mimeHint, {
      resourceClass: input.request.resourceClass,
    });
    phase = "normalizing";
    sequence += 1;
    progress(input.request, phase, sequence);
    const normalized = await normalizeImage({
      sourcePath: inputPath,
      rawPath: join(input.workspace, "normalized.raw"),
      inspection,
    });
    const decodedBytes =
      normalized.width * normalized.height * normalized.channels * (normalized.sampleDepth / 8);
    const features = extractImageFeatures({
      pixels: normalized.sample.pixels,
      width: normalized.sample.width,
      height: normalized.sample.height,
      channels: normalized.channels,
      sampleDepth: normalized.sampleDepth,
      encodedBytes: input.request.input.byteLength,
      decodedBytes,
    });
    const contentClass = classifyImage(features);
    const planning = planOptimization(inspection, contentClass, input.request.spec);
    if (planning.kind === "unsupported") {
      failed({
        request: input.request,
        phase,
        sequence: sequence + 1,
        code: planning.code,
        retryable: false,
        startedAt,
        inspection,
        contentClass,
      });
      return;
    }
    await writeJsonAtomic(join(input.workspace, "plan.json"), {
      version: 1,
      inspection,
      normalization: serializableNormalization(normalized),
      features,
      plan: planning.plan,
    });

    // Codec execution begins in Task 13. Until then the runner fails closed after proving and
    // persisting the bounded plan; it never fabricates a successful optimization result.
    failed({
      request: input.request,
      phase: "optimizing",
      sequence: sequence + 1,
      code: "ENGINE_CRASH",
      retryable: true,
      startedAt,
      inspection,
      contentClass,
    });
  } catch (error) {
    const pipelineError = error instanceof ImagePipelineError ? error : null;
    inspection ??= pipelineError?.inspection;
    failed({
      request: input.request,
      phase,
      sequence: sequence + 1,
      code: pipelineError?.code ?? "ENGINE_CRASH",
      retryable: pipelineError?.retryable ?? true,
      startedAt,
      ...(inspection === undefined ? {} : { inspection }),
    });
  }
}

function selfTestInspection(format: "jpeg" | "png" | "webp"): ImageInspection {
  return {
    format,
    mime: format === "jpeg" ? "image/jpeg" : format === "png" ? "image/png" : "image/webp",
    width: 64,
    height: 64,
    displayedWidth: 64,
    displayedHeight: 64,
    pixels: 4_096,
    bitDepth: 8,
    hasAlpha: format === "png",
    animated: false,
    orientation: 1,
    hasIccProfile: false,
    sourceColorModel: format === "jpeg" ? "ycbcr" : "rgb",
    adobeTransform: null,
    iccProfileKind: "none",
    wideGamut: false,
    metadataBytes: 0,
  };
}

export function selfTestPlanner(): void {
  const modes = ["lossless", "smart"] as const;
  const presets = ["balanced", "smallest"] as const;
  const plans: OptimizationPlan[] = [];
  for (const format of ["jpeg", "png", "webp"] as const) {
    for (const mode of modes) {
      for (const preset of presets) {
        const result: OptimizationPlanningResult = planOptimization(
          selfTestInspection(format),
          "photo",
          {
            version: 1,
            mode,
            preset,
            output: "same-format",
            metadata: "strip",
            orientation: "apply",
            colorSpace: "srgb",
            minimumSavingsPercent: 1,
          },
        );
        if (result.kind !== "plan")
          throw new Error("planner self-test unexpectedly rejected input");
        if (result.plan.candidates.length < 1 || result.plan.candidates.length > 3) {
          throw new Error("planner self-test found an invalid candidate count");
        }
        plans.push(result.plan);
      }
    }
  }
  process.stdout.write(
    `${JSON.stringify({ ok: true, plans: plans.length, maximumCandidates: 3 })}\n`,
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function selfTestJpeg(): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), "hereisit-jpeg-self-test-"));
  try {
    const sourceWidth = 16;
    const sourceHeight = 32;
    const pixels = Buffer.alloc(sourceWidth * sourceHeight * 3);
    for (let y = 0; y < sourceHeight; y += 1) {
      for (let x = 0; x < sourceWidth; x += 1) {
        const offset = (y * sourceWidth + x) * 3;
        pixels[offset] = (x * 13 + y * 3) & 0xff;
        pixels[offset + 1] = (x * 5 + y * 11) & 0xff;
        pixels[offset + 2] = (x * 17 + y * 7) & 0xff;
      }
    }
    const normalizedPath = join(workspace, "normalized.raw");
    const sourcePath = join(workspace, "source.jpg");
    await writeFile(normalizedPath, pixels, { mode: 0o600 });
    await sharp(pixels, {
      raw: { width: sourceWidth, height: sourceHeight, channels: 3 },
    })
      .jpeg({ progressive: false, chromaSubsampling: "4:2:0", quality: 90 })
      .toFile(sourcePath);

    const smart = await encodeJpegCandidate({
      sourcePath,
      normalizedRgbPath: normalizedPath,
      width: sourceWidth,
      height: sourceHeight,
      orientation: 1,
      candidate: {
        id: "self-test-smart",
        codec: "mozjpeg",
        mode: "lossy",
        quality: 82,
        chroma: "444",
        effort: 3,
      },
      outputPath: join(workspace, "smart.jpg"),
      signal: new AbortController().signal,
    });
    const losslessVerifications: Awaited<ReturnType<typeof verifyJpegCoefficientTransform>>[] = [];
    for (const orientation of [1, 2, 3, 4, 5, 6, 7, 8] as const) {
      const swapsAxes = orientation >= 5;
      const encoded = await encodeJpegCandidate({
        sourcePath,
        normalizedRgbPath: normalizedPath,
        width: swapsAxes ? sourceHeight : sourceWidth,
        height: swapsAxes ? sourceWidth : sourceHeight,
        orientation,
        candidate: {
          id: `self-test-lossless-${orientation}`,
          codec: "mozjpeg",
          mode: "lossless-structural",
          effort: 3,
        },
        outputPath: join(workspace, `lossless-${orientation}.jpg`),
        signal: new AbortController().signal,
      });
      losslessVerifications.push(
        await verifyJpegCoefficientTransform({
          sourcePath,
          candidatePath: encoded.path,
          transform: orientationTransform(orientation),
          signal: new AbortController().signal,
        }),
      );
    }
    const oddSourcePath = join(workspace, "odd-source.jpg");
    await sharp({
      create: { width: 17, height: 17, channels: 3, background: "#5279a3" },
    })
      .jpeg({ progressive: false, chromaSubsampling: "4:2:0", quality: 90 })
      .toFile(oddSourcePath);
    let oddMcuRejected = false;
    try {
      await encodeJpegCandidate({
        sourcePath: oddSourcePath,
        normalizedRgbPath: normalizedPath,
        width: 17,
        height: 17,
        orientation: 6,
        candidate: {
          id: "self-test-odd-mcu",
          codec: "mozjpeg",
          mode: "lossless-structural",
          effort: 3,
        },
        outputPath: join(workspace, "odd-result.jpg"),
        signal: new AbortController().signal,
      });
    } catch (error) {
      oddMcuRejected =
        error instanceof JpegCodecError && error.reason === "unsafe-lossless-transform";
    }
    const jpegliPresent = await pathExists("/usr/local/bin/cjpegli");
    if (
      losslessVerifications.some((verification) => !verification.exact) ||
      !oddMcuRejected ||
      jpegliPresent
    ) {
      throw new Error(
        `JPEG self-test policy failed: ${JSON.stringify({
          losslessVerifications,
          oddMcuRejected,
          jpegliPresent,
        })}`,
      );
    }
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        smartBytes: smart.byteLength,
        exactTransforms: losslessVerifications.length,
        oddMcuRejected,
        jpegliPresent,
      })}\n`,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--self-test-jpeg")) {
    await selfTestJpeg();
    return;
  }
  if (process.argv.includes("--self-test-planner")) {
    selfTestPlanner();
    return;
  }
  const workspace = argument("--workspace");
  const jobId = argument("--job-id");
  if (
    workspace === undefined ||
    jobId === undefined ||
    resolve(workspace) !== resolve(process.cwd())
  ) {
    throw new Error("runner arguments are invalid");
  }
  const rawRequest: unknown = JSON.parse(await readFile(join(workspace, "request.json"), "utf8"));
  const request = engineCreateJobRequestSchema.parse(rawRequest) as EngineCreateJobRequest;
  if (request.jobId !== jobId) throw new Error("runner request identity mismatch");
  await runPlanningPipeline({ request, workspace });
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && resolve(fileURLToPath(import.meta.url)) === resolve(invokedPath)) {
  await main();
}

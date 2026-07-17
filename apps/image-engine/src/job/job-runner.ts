import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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
import { encodePngCandidate } from "../codecs/png";
import { encodeWebpCandidate } from "../codecs/webp";
import { classifyImage, extractImageFeatures } from "../pipeline/classify";
import { type ImageInspection, ImagePipelineError, inspectImage } from "../pipeline/inspect";
import { type NormalizedImageWithSample, normalizeImage } from "../pipeline/normalize";
import { OptimizationExecutionError, optimizeCandidates } from "../pipeline/optimize";
import {
  type OptimizationPlan,
  type OptimizationPlanningResult,
  planOptimization,
} from "../pipeline/plan";
import { liveQualityFloor, selectVerifiedResult, verifyCandidate } from "../pipeline/verify";
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
  readonly testedCandidates?: number;
}): EngineMeasurements {
  return {
    processedInputBytes: input.request.input.byteLength,
    processedPixels: input.inspection?.pixels ?? 0,
    cpuMs: 0,
    memoryByteMilliseconds: 0,
    peakMemoryBytes: 0,
    testedCandidates: input.testedCandidates ?? 0,
    processingMs: Math.max(0, Math.round(performance.now() - input.startedAt)),
  };
}

function progress(
  request: EngineCreateJobRequest,
  phase:
    | "validating"
    | "inspecting"
    | "normalizing"
    | "optimizing"
    | "verifying"
    | "preparing-output",
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
  readonly phase:
    | "validating"
    | "inspecting"
    | "normalizing"
    | "optimizing"
    | "verifying"
    | "preparing-output";
  readonly sequence: number;
  readonly code:
    | "UNSUPPORTED_INPUT"
    | "UNSUPPORTED_FEATURE"
    | "INPUT_LIMIT_EXCEEDED"
    | "PIXEL_LIMIT_EXCEEDED"
    | "RESOURCE_CLASS_UPGRADE"
    | "ENGINE_OOM"
    | "ENGINE_CRASH"
    | "ENGINE_TIMEOUT"
    | "VERIFICATION_FAILED";
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
  readonly guidance?: "TRY_BALANCED_PRESET";
  readonly testedCandidates?: number;
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
    error: {
      code: input.code,
      retryable: input.retryable,
      ...(input.guidance === undefined ? {} : { guidance: input.guidance }),
    },
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
  let phase:
    | "validating"
    | "inspecting"
    | "normalizing"
    | "optimizing"
    | "verifying"
    | "preparing-output" = "validating";
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
    const currentInspection = await inspectImage(inputPath, input.request.input.mimeHint, {
      resourceClass: input.request.resourceClass,
    });
    inspection = currentInspection;
    phase = "normalizing";
    sequence += 1;
    progress(input.request, phase, sequence);
    const normalized = await normalizeImage({
      sourcePath: inputPath,
      rawPath: join(input.workspace, "normalized.raw"),
      inspection: currentInspection,
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
    const planning = planOptimization(currentInspection, contentClass, input.request.spec);
    if (planning.kind === "unsupported") {
      failed({
        request: input.request,
        phase,
        sequence: sequence + 1,
        code: planning.code,
        retryable: false,
        startedAt,
        inspection: currentInspection,
        contentClass,
      });
      return;
    }
    await writeJsonAtomic(join(input.workspace, "plan.json"), {
      version: 1,
      inspection: currentInspection,
      normalization: serializableNormalization(normalized),
      features,
      plan: planning.plan,
    });
    phase = "optimizing";
    sequence += 1;
    progress(input.request, phase, sequence);
    const candidatePaths: string[] = [];
    const optimization = await optimizeCandidates({
      plan: planning.plan,
      signal: new AbortController().signal,
      encode: async (candidate, index) => {
        const extension = currentInspection.format === "jpeg" ? "jpg" : currentInspection.format;
        const outputPath = join(input.workspace, `candidate-${index}.${extension}`);
        candidatePaths.push(outputPath);
        if (currentInspection.format === "jpeg") {
          return encodeJpegCandidate({
            sourcePath: inputPath,
            normalizedRgbPath: normalized.rawPath,
            width: normalized.width,
            height: normalized.height,
            orientation: currentInspection.orientation,
            candidate,
            outputPath,
            signal: new AbortController().signal,
          });
        }
        if (currentInspection.format === "png") {
          return encodePngCandidate({
            normalizedPath: normalized.rawPath,
            width: normalized.width,
            height: normalized.height,
            channels: normalized.channels,
            sampleDepth: normalized.sampleDepth,
            candidate,
            outputPath,
            signal: new AbortController().signal,
          });
        }
        return encodeWebpCandidate({
          normalizedPath: normalized.rawPath,
          width: normalized.width,
          height: normalized.height,
          channels: normalized.channels,
          candidate,
          outputPath,
          signal: new AbortController().signal,
        });
      },
      verify: async (candidate) => {
        let coefficientExact: boolean | undefined;
        if (candidate.mime === "image/jpeg" && candidate.mode === "lossless-structural") {
          coefficientExact = (
            await verifyJpegCoefficientTransform({
              sourcePath: inputPath,
              candidatePath: candidate.path,
              transform: orientationTransform(currentInspection.orientation),
              signal: new AbortController().signal,
            })
          ).exact;
        }
        const verification = await verifyCandidate({
          candidate,
          sourceBytes: input.request.input.byteLength,
          minimumSavingsPercent: planning.plan.minimumSavingsPercent,
          inspection: currentInspection,
          normalized,
          mode: input.request.spec.mode,
          preset: input.request.spec.preset,
          contentClass,
          ...(coefficientExact === undefined ? {} : { coefficientExact }),
        });
        if (!verification.accepted) await rm(candidate.path, { force: true });
        const floor = liveQualityFloor[input.request.spec.preset];
        const qualityMarginPassed =
          verification.accepted &&
          (verification.liveQuality === null ||
            verification.liveQuality.worstSsim >=
              (contentClass === "screenshot-text" ? floor.screenshotTextSsim : floor.defaultSsim) +
                0.005);
        return {
          accepted: verification.accepted,
          sizeTargetPassed: false,
          qualityMarginPassed,
        };
      },
    });
    phase = "verifying";
    sequence += 1;
    progress(input.request, phase, sequence);
    const selected = optimization.selected;
    await Promise.all(
      candidatePaths
        .filter((path) => path !== selected?.path)
        .map((path) => rm(path, { force: true })),
    );
    phase = "preparing-output";
    sequence += 1;
    progress(input.request, phase, sequence);
    const engineBuildId = process.env.ENGINE_BUILD_ID ?? "hereisit-image-engine-v1";
    const result: EngineJobStatus extends infer _Status
      ? Extract<EngineJobStatus, { state: "succeeded" }>["result"]
      : never =
      selected === null
        ? {
            kind: "original-retained" as const,
            testedCandidates: optimization.testedCandidates,
            engineBuildId,
            codecBuildId: "none",
            warnings: ["ORIGINAL_RETAINED_UNMODIFIED", ...optimization.warnings] as const,
          }
        : {
            kind: "download" as const,
            mime: selected.mime,
            byteLength: selected.byteLength,
            width: normalized.width,
            height: normalized.height,
            testedCandidates: optimization.testedCandidates,
            engineBuildId,
            codecBuildId: selected.codecBuildId,
            warnings: optimization.warnings,
          };
    if (selected !== null) await rename(selected.path, join(input.workspace, "output.bin"));
    else await rm(join(input.workspace, "output.bin"), { force: true });
    const terminal = {
      protocol: 1 as const,
      jobId: input.request.jobId,
      state: "succeeded" as const,
      phase: "preparing-output" as const,
      fraction: 1 as const,
      sequence: sequence + 1,
      result,
      inspection: {
        verifiedInputMime: currentInspection.mime,
        inputHasAlpha: currentInspection.hasAlpha,
        contentClass,
      },
      measurements: measurements({
        request: input.request,
        inspection: currentInspection,
        startedAt,
        testedCandidates: optimization.testedCandidates,
      }),
    };
    await writeJsonAtomic(join(input.workspace, "result.json"), terminal);
    emit(terminal);
  } catch (error) {
    const pipelineError = error instanceof ImagePipelineError ? error : null;
    inspection ??= pipelineError?.inspection;
    const timeout = error instanceof OptimizationExecutionError ? error : null;
    failed({
      request: input.request,
      phase,
      sequence: sequence + 1,
      code: timeout?.code ?? pipelineError?.code ?? "ENGINE_CRASH",
      retryable: timeout?.retryable ?? pipelineError?.retryable ?? true,
      ...(timeout === null ? {} : { guidance: timeout.guidance }),
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

export async function selfTestJpeg(writeResult = true): Promise<Record<string, unknown>> {
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
    const result = {
      ok: true,
      smartBytes: smart.byteLength,
      exactTransforms: losslessVerifications.length,
      oddMcuRejected,
      jpegliPresent,
    };
    if (writeResult) process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

export async function selfTestPng(writeResult = true): Promise<Record<string, unknown>> {
  const workspace = await mkdtemp(join(tmpdir(), "hereisit-png-self-test-"));
  try {
    const signal = new AbortController().signal;
    const width = 16;
    const height = 16;
    const losslessPixels = Buffer.alloc(width * height * 4);
    const logoPixels = Buffer.alloc(width * height * 4);
    const gradientAlphaPixels = Buffer.alloc(width * height * 4);
    const opaquePixels = Buffer.alloc(width * height * 3);
    for (let index = 0; index < width * height; index += 1) {
      const offset = index * 4;
      losslessPixels.set(
        [(index * 17) & 255, (index * 29) & 255, (index * 43) & 255, (index * 7) & 255],
        offset,
      );
      const logoColor = index % 3;
      logoPixels.set(
        logoColor === 0
          ? [240, 40, 60, 0]
          : logoColor === 1
            ? [20, 180, 90, 128]
            : [30, 70, 220, 255],
        offset,
      );
      gradientAlphaPixels.set([60, 120, 200, index], offset);
      opaquePixels.set(index % 2 === 0 ? [250, 210, 30] : [20, 80, 230], index * 3);
    }
    const losslessPath = join(workspace, "lossless.raw");
    const logoPath = join(workspace, "logo.raw");
    const gradientPath = join(workspace, "gradient.raw");
    const opaquePath = join(workspace, "opaque.raw");
    const sixteenBitPath = join(workspace, "sixteen-bit.raw");
    const sixteenBitPixels = Buffer.alloc(2 * 2 * 3 * 2);
    [1, 65_534, 1_023, 32_769, 12_345, 54_321, 7, 60_001, 2_049, 40_003, 222, 44_444].forEach(
      (value, index) => {
        sixteenBitPixels.writeUInt16LE(value, index * 2);
      },
    );
    await Promise.all([
      writeFile(losslessPath, losslessPixels, { mode: 0o600 }),
      writeFile(logoPath, logoPixels, { mode: 0o600 }),
      writeFile(gradientPath, gradientAlphaPixels, { mode: 0o600 }),
      writeFile(opaquePath, opaquePixels, { mode: 0o600 }),
      writeFile(sixteenBitPath, sixteenBitPixels, { mode: 0o600 }),
    ]);
    const lossless = await encodePngCandidate({
      normalizedPath: losslessPath,
      width,
      height,
      channels: 4,
      sampleDepth: 8,
      candidate: { id: "png-lossless-self-test", codec: "oxipng", mode: "lossless", effort: 3 },
      outputPath: join(workspace, "lossless.png"),
      signal,
    });
    const smartCandidate = {
      id: "png-smart-self-test",
      codec: "quantizr-oxipng" as const,
      mode: "quantized-255",
      quality: 255,
      effort: 3,
    };
    const smart = await encodePngCandidate({
      normalizedPath: logoPath,
      width,
      height,
      channels: 4,
      sampleDepth: 8,
      candidate: smartCandidate,
      outputPath: join(workspace, "smart-a.png"),
      signal,
    });
    const smartAgain = await encodePngCandidate({
      normalizedPath: logoPath,
      width,
      height,
      channels: 4,
      sampleDepth: 8,
      candidate: smartCandidate,
      outputPath: join(workspace, "smart-b.png"),
      signal,
    });
    const opaqueSmart = await encodePngCandidate({
      normalizedPath: opaquePath,
      width,
      height,
      channels: 3,
      sampleDepth: 8,
      candidate: { ...smartCandidate, id: "png-opaque-self-test" },
      outputPath: join(workspace, "opaque.png"),
      signal,
    });
    const lossless16 = await encodePngCandidate({
      normalizedPath: sixteenBitPath,
      width: 2,
      height: 2,
      channels: 3,
      sampleDepth: 16,
      candidate: { id: "png-16-self-test", codec: "oxipng", mode: "lossless", effort: 3 },
      outputPath: join(workspace, "sixteen-bit.png"),
      signal,
    });
    const firstBytes = await readFile(smart.path);
    let gradientAlphaRejected = false;
    try {
      await encodePngCandidate({
        normalizedPath: gradientPath,
        width,
        height,
        channels: 4,
        sampleDepth: 8,
        candidate: { ...smartCandidate, id: "png-gradient-self-test" },
        outputPath: join(workspace, "gradient.png"),
        signal,
      });
    } catch (error) {
      gradientAlphaRejected = error instanceof Error && error.message.includes("alpha-mismatch");
    }
    if (!firstBytes.equals(await readFile(smartAgain.path)) || !gradientAlphaRejected) {
      throw new Error("PNG self-test policy failed");
    }
    const result = {
      ok: true,
      losslessBytes: lossless.byteLength,
      lossless16Bytes: lossless16.byteLength,
      smartBytes: smart.byteLength,
      opaqueSmartBytes: opaqueSmart.byteLength,
      deterministic: true,
      indexedIntermediateVerified: true,
      exactAlpha: true,
      opaqueAlphaVerified: true,
      gradientAlphaRejected,
    };
    if (writeResult) process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

export async function selfTestWebp(writeResult = true): Promise<Record<string, unknown>> {
  const workspace = await mkdtemp(join(tmpdir(), "hereisit-webp-self-test-"));
  try {
    const width = 64;
    const height = 64;
    const pixels = Buffer.alloc(width * height * 3);
    for (let index = 0; index < width * height; index += 1) {
      pixels.set(
        index % 4 === 0 ? [20, 70, 220] : index % 4 === 1 ? [240, 180, 30] : [30, 180, 80],
        index * 3,
      );
    }
    const normalizedPath = join(workspace, "normalized.raw");
    await writeFile(normalizedPath, pixels, { mode: 0o600 });
    const candidate = await encodeWebpCandidate({
      normalizedPath,
      width,
      height,
      channels: 3,
      candidate: { id: "webp-lossless-self-test", codec: "libwebp", mode: "lossless", effort: 4 },
      outputPath: join(workspace, "candidate.webp"),
      signal: new AbortController().signal,
    });
    const normalized = {
      rawPath: normalizedPath,
      width,
      height,
      channels: 3 as const,
      sampleDepth: 8 as const,
      rawEndian: "little" as const,
      rawSha256: createHash("sha256").update(pixels).digest("hex"),
      alphaSha256: null,
      normalizedColorSpace: "srgb" as const,
    };
    const verification = await verifyCandidate({
      candidate,
      sourceBytes: candidate.byteLength + 1_000,
      minimumSavingsPercent: 1,
      inspection: selfTestInspection("webp"),
      normalized,
      mode: "lossless",
      preset: "balanced",
      contentClass: "flat-graphic",
    });
    const retained = await selectVerifiedResult({
      candidates: [{ ...candidate, id: "retained-probe" }],
      verify: async () => ({ accepted: false, reason: "not-smaller", liveQuality: null }),
      width,
      height,
      mime: "image/webp",
      deleteRejected: false,
    });
    if (!verification.accepted || retained.kind !== "original-retained") {
      throw new Error("WebP self-test policy failed");
    }
    const result = {
      ok: true,
      losslessBytes: candidate.byteLength,
      exactPixels: true,
      originalRetained: true,
    };
    if (writeResult) process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

export async function selfTestAllFormats(): Promise<void> {
  const [jpeg, png, webp] = await Promise.all([
    selfTestJpeg(false),
    selfTestPng(false),
    selfTestWebp(false),
  ]);
  process.stdout.write(`${JSON.stringify({ ok: true, jpeg, png, webp })}\n`);
}

async function main(): Promise<void> {
  if (process.argv.includes("--self-test-all-formats")) {
    await selfTestAllFormats();
    return;
  }
  if (process.argv.includes("--self-test-webp")) {
    await selfTestWebp();
    return;
  }
  if (process.argv.includes("--self-test-png")) {
    await selfTestPng();
    return;
  }
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

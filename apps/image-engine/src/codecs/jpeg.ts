import { createReadStream, createWriteStream } from "node:fs";
import { chmod, open, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";
import type { OptimizationCandidatePlan } from "../pipeline/plan";
import { type CommandResult, runBoundedCommand } from "./command";

export interface CodecCandidate {
  readonly id: string;
  readonly path: string;
  readonly mime: "image/jpeg" | "image/png" | "image/webp";
  readonly byteLength: number;
  readonly encodeMs: number;
  readonly codecBuildId: string;
  readonly mode: string;
}

export type JpegTransform =
  | "identity"
  | "flip-h"
  | "rotate-180"
  | "flip-v"
  | "transpose"
  | "rotate-90"
  | "transverse"
  | "rotate-270";

export type JpegCodecFailureReason =
  | "codec-failed"
  | "invalid-input"
  | "invalid-output"
  | "unsafe-lossless-transform";

export class JpegCodecError extends Error {
  readonly reason: JpegCodecFailureReason;

  constructor(reason: JpegCodecFailureReason) {
    super(`JPEG candidate failed: ${reason}`);
    this.name = "JpegCodecError";
    this.reason = reason;
  }
}

export function orientationTransform(orientation: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8): JpegTransform {
  switch (orientation) {
    case 1:
      return "identity";
    case 2:
      return "flip-h";
    case 3:
      return "rotate-180";
    case 4:
      return "flip-v";
    case 5:
      return "transpose";
    case 6:
      return "rotate-90";
    case 7:
      return "transverse";
    case 8:
      return "rotate-270";
  }
}

const transformArguments: Readonly<Record<JpegTransform, readonly string[]>> = {
  identity: [],
  "flip-h": ["-perfect", "-flip", "horizontal"],
  "rotate-180": ["-perfect", "-rotate", "180"],
  "flip-v": ["-perfect", "-flip", "vertical"],
  transpose: ["-perfect", "-transpose"],
  "rotate-90": ["-perfect", "-rotate", "90"],
  transverse: ["-perfect", "-transverse"],
  "rotate-270": ["-perfect", "-rotate", "270"],
};

export function buildJpegtranArgs(
  orientation: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8,
  outputPath: string,
  sourcePath: string,
): string[] {
  return [
    "-copy",
    "none",
    "-optimize",
    "-progressive",
    ...transformArguments[orientationTransform(orientation)],
    "-outfile",
    outputPath,
    sourcePath,
  ];
}

export function buildMozJpegArgs(input: {
  readonly quality: number;
  readonly chroma: "420" | "444";
  readonly outputPath: string;
  readonly ppmPath: string;
}): string[] {
  return [
    "-quality",
    String(input.quality),
    "-sample",
    input.chroma === "444" ? "1x1" : "2x2",
    "-progressive",
    "-optimize",
    "-outfile",
    input.outputPath,
    input.ppmPath,
  ];
}

async function writePpm(input: {
  readonly normalizedRgbPath: string;
  readonly ppmPath: string;
  readonly width: number;
  readonly height: number;
}): Promise<void> {
  const expectedBytes = input.width * input.height * 3;
  const information = await stat(input.normalizedRgbPath);
  if (!information.isFile() || information.size !== expectedBytes) {
    throw new JpegCodecError("invalid-output");
  }
  const header = Buffer.from(`P6\n${input.width} ${input.height}\n255\n`, "ascii");
  await writeFile(input.ppmPath, header, { flag: "wx", mode: 0o600 });
  await pipeline(
    createReadStream(input.normalizedRgbPath),
    createWriteStream(input.ppmPath, { flags: "a", mode: 0o600 }),
  );
}

async function validateJpeg(path: string, width: number, height: number): Promise<number> {
  const handle = await open(path, "r");
  try {
    const information = await handle.stat();
    if (!information.isFile() || information.size < 4) throw new JpegCodecError("invalid-output");
    const start = Buffer.alloc(2);
    const end = Buffer.alloc(2);
    await handle.read(start, 0, 2, 0);
    await handle.read(end, 0, 2, information.size - 2);
    if (!start.equals(Buffer.from([0xff, 0xd8])) || !end.equals(Buffer.from([0xff, 0xd9]))) {
      throw new JpegCodecError("invalid-output");
    }
    const metadata = await sharp(path, { failOn: "error", sequentialRead: true }).metadata();
    if (
      metadata.format !== "jpeg" ||
      metadata.width !== width ||
      metadata.height !== height ||
      (metadata.pages ?? 1) !== 1 ||
      metadata.isProgressive !== true ||
      metadata.exif !== undefined ||
      metadata.icc !== undefined ||
      metadata.xmp !== undefined ||
      (metadata.orientation !== undefined && metadata.orientation !== 1)
    ) {
      throw new JpegCodecError("invalid-output");
    }
    return information.size;
  } catch (error) {
    if (error instanceof JpegCodecError) throw error;
    throw new JpegCodecError("invalid-output");
  } finally {
    await handle.close();
  }
}

type CommandRunner = (input: Parameters<typeof runBoundedCommand>[0]) => Promise<CommandResult>;

export async function encodeJpegCandidate(input: {
  readonly sourcePath: string;
  readonly normalizedRgbPath: string;
  readonly width: number;
  readonly height: number;
  readonly orientation: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  readonly candidate: OptimizationCandidatePlan;
  readonly outputPath: string;
  readonly signal: AbortSignal;
  readonly run?: CommandRunner;
  readonly onProcessGroup?: (event: { action: "add" | "remove"; pgid: number }) => void;
}): Promise<CodecCandidate> {
  if (
    input.candidate.codec !== "mozjpeg" ||
    !Number.isSafeInteger(input.width) ||
    !Number.isSafeInteger(input.height) ||
    input.width < 1 ||
    input.height < 1
  ) {
    throw new JpegCodecError("codec-failed");
  }
  const lossless = input.candidate.mode === "lossless-structural";
  if (
    !lossless &&
    (input.candidate.mode !== "lossy" ||
      input.candidate.quality === undefined ||
      input.candidate.chroma === undefined)
  ) {
    throw new JpegCodecError("codec-failed");
  }
  const ppmPath = join(dirname(input.outputPath), `${input.candidate.id}.ppm`);
  const run = input.run ?? runBoundedCommand;
  let result: CommandResult;
  try {
    if (!lossless) {
      await writePpm({
        normalizedRgbPath: input.normalizedRgbPath,
        ppmPath,
        width: input.width,
        height: input.height,
      });
    }
    await writeFile(input.outputPath, Buffer.alloc(0), { flag: "wx", mode: 0o600 });
    result = await run({
      command: lossless ? "/usr/local/bin/jpegtran" : "/usr/local/bin/cjpeg",
      args: lossless
        ? buildJpegtranArgs(input.orientation, input.outputPath, input.sourcePath)
        : buildMozJpegArgs({
            quality: input.candidate.quality as number,
            chroma: input.candidate.chroma as "420" | "444",
            outputPath: input.outputPath,
            ppmPath,
          }),
      cwd: dirname(input.outputPath),
      timeoutMs: 15_000,
      signal: input.signal,
      ...(input.onProcessGroup === undefined ? {} : { onProcessGroup: input.onProcessGroup }),
    });
    if (result.exitCode !== 0) {
      throw new JpegCodecError(
        lossless && result.exitCode === 2
          ? "invalid-input"
          : lossless && input.orientation !== 1
            ? "unsafe-lossless-transform"
            : "codec-failed",
      );
    }
    await chmod(input.outputPath, 0o600);
    const byteLength = await validateJpeg(input.outputPath, input.width, input.height);
    return {
      id: input.candidate.id,
      path: input.outputPath,
      mime: "image/jpeg",
      byteLength,
      encodeMs: result.elapsedMs,
      codecBuildId: "mozjpeg-4.1.1+a2d2907",
      mode: input.candidate.mode,
    };
  } catch (error) {
    await unlink(input.outputPath).catch(() => undefined);
    throw error;
  } finally {
    await unlink(ppmPath).catch(() => undefined);
  }
}

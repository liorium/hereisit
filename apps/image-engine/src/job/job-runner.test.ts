import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { EngineCreateJobRequest } from "@hereisit/server-contracts";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as command from "../codecs/command";
import { runPlanningPipeline } from "./job-runner";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("production runner", () => {
  it.each([
    ["balanced", true],
    ["smallest", true],
    ["balanced", false],
    ["smallest", false],
  ] as const)("quality-gates %s PNG palettes before recompression (rejected=%s)", async (preset, rejected) => {
    const workspace = await mkdtemp(join(tmpdir(), "hereisit-runner-png-"));
    roots.push(workspace);
    const source = await sharp({
      create: { width: 64, height: 48, channels: 3, background: "#3478ab" },
    })
      .png({ compressionLevel: rejected ? 0 : 9 })
      .toBuffer();
    await writeFile(join(workspace, "input.bin"), source);
    const request: EngineCreateJobRequest = {
      protocol: 1,
      jobId: "123e4567-e89b-42d3-a456-426614174004",
      attempt: 1,
      tool: "image.optimize",
      toolVersion: 1,
      spec: {
        version: 1,
        mode: "smart",
        preset,
        output: "same-format",
        metadata: "strip",
        orientation: "apply",
        colorSpace: "srgb",
        minimumSavingsPercent: 1,
      },
      specHash: "d".repeat(64),
      input: { byteLength: source.byteLength, etag: "opaque", mimeHint: "image/png" },
      resourceClass: "image-standard-v1",
    };
    const commands: string[] = [];
    vi.spyOn(command, "runBoundedCommand").mockImplementation(async (input) => {
      commands.push(input.command);
      if (input.command.endsWith("png-smart")) {
        const palettePath = input.args[input.args.indexOf("--output") + 1] as string;
        await sharp({
          create: {
            width: 64,
            height: 48,
            channels: 3,
            background: rejected ? "#ffffff" : "#3478ab",
          },
        })
          .png({ palette: true, compressionLevel: 0 })
          .toFile(palettePath);
        if (!rejected) expect((await lstat(palettePath)).size).toBeGreaterThan(source.byteLength);
      } else if (!rejected) {
        await sharp(input.args.at(-1) as string)
          .png({ palette: true, compressionLevel: 9 })
          .toFile(input.args.at(-2) as string);
      } else {
        await writeFile(input.args.at(-2) as string, await readFile(input.args.at(-1) as string));
      }
      return { exitCode: 0, elapsedMs: 1, stderrTail: "" };
    });
    const records: unknown[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      records.push(JSON.parse(String(chunk)));
      return true;
    });
    await runPlanningPipeline({ request, workspace });
    expect(records.at(-1)).toMatchObject({
      state: "succeeded",
      result: {
        kind: "download",
        testedCandidates: 3,
        warnings: rejected ? ["SMART_PNG_FELL_BACK_TO_LOSSLESS"] : [],
      },
    });
    expect(await sharp(join(workspace, "output.bin")).raw().toBuffer()).toEqual(
      await sharp(source).raw().toBuffer(),
    );
    expect(commands).toEqual([
      "/usr/local/bin/png-smart",
      ...(!rejected ? ["/usr/local/bin/oxipng"] : []),
      "/usr/local/bin/png-smart",
      ...(!rejected ? ["/usr/local/bin/oxipng"] : []),
      "/usr/local/bin/oxipng",
    ]);
  });
  it.each([
    [1, "transformation is not perfect", true],
    [1, "unexpected codec failure", false],
    [-1, "transformation is not perfect", false],
  ] as const)("retains only a known perfect-rotation rejection: exit %i, %s", async (exitCode, stderrTail, retained) => {
    const workspace = await mkdtemp(join(tmpdir(), "hereisit-runner-"));
    roots.push(workspace);
    const inputPath = join(workspace, "input.bin");
    const bytes = await readFile(
      resolve(import.meta.dirname, "../../../../tests/image-corpus/public/photo-oriented-jpeg.jpg"),
    );
    await writeFile(inputPath, bytes, { mode: 0o600 });
    const request: EngineCreateJobRequest = {
      protocol: 1,
      jobId: "123e4567-e89b-42d3-a456-426614174003",
      attempt: 1,
      tool: "image.optimize",
      toolVersion: 1,
      spec: {
        version: 1,
        mode: "lossless",
        preset: "balanced",
        output: "same-format",
        metadata: "strip",
        orientation: "apply",
        colorSpace: "srgb",
        minimumSavingsPercent: 1,
      },
      specHash: "c".repeat(64),
      input: { byteLength: bytes.byteLength, etag: "opaque", mimeHint: "image/jpeg" },
      resourceClass: "image-standard-v1",
    };
    vi.spyOn(command, "runBoundedCommand").mockImplementation(async (input) => {
      expect(input.command).toBe("/usr/local/bin/jpegtran");
      expect(input.args).toContain("-perfect");
      expect(
        input.args.slice(input.args.indexOf("-rotate"), input.args.indexOf("-rotate") + 2),
      ).toEqual(["-rotate", "90"]);
      return { exitCode, elapsedMs: 1, stderrTail };
    });
    const records: unknown[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      records.push(JSON.parse(String(chunk)));
      return true;
    });

    await runPlanningPipeline({ request, workspace });

    expect(records.at(-1)).toMatchObject(
      retained
        ? {
            state: "succeeded",
            result: {
              kind: "original-retained",
              testedCandidates: 1,
              warnings: ["ORIGINAL_RETAINED_UNMODIFIED"],
            },
          }
        : { state: "failed", error: { code: "ENGINE_CRASH" } },
    );
    expect(await readFile(inputPath)).toEqual(bytes);
    await expect(lstat(join(workspace, "output.bin"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(workspace, "candidate-0.jpg"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("classifies a structurally valid but undecodable image as unsupported input", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "hereisit-runner-"));
    roots.push(workspace);
    const inputPath = join(workspace, "input.bin");
    const bytes = await readFile(
      resolve(import.meta.dirname, "../../../../tests/image-corpus/public/korean-text-webp.webp"),
    );
    const target = bytes[1979];
    if (target === undefined) throw new Error("owned WebP fixture is unexpectedly short");
    bytes[1979] = target ^ 0x20;
    await writeFile(inputPath, bytes, { mode: 0o600 });
    const request: EngineCreateJobRequest = {
      protocol: 1,
      jobId: "123e4567-e89b-42d3-a456-426614174002",
      attempt: 1,
      tool: "image.optimize",
      toolVersion: 1,
      spec: {
        version: 1,
        mode: "lossless",
        preset: "balanced",
        output: "same-format",
        metadata: "strip",
        orientation: "apply",
        colorSpace: "srgb",
        minimumSavingsPercent: 1,
      },
      specHash: "b".repeat(64),
      input: {
        byteLength: bytes.byteLength,
        etag: "opaque",
        mimeHint: "image/webp",
      },
      resourceClass: "image-standard-v1",
    };
    const records: unknown[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      records.push(JSON.parse(String(chunk)));
      return true;
    });

    await runPlanningPipeline({ request, workspace });

    expect(records.at(-1)).toMatchObject({
      state: "failed",
      phase: "normalizing",
      error: { code: "UNSUPPORTED_INPUT", retryable: false },
    });
  });

  it("emits ordered phases and atomically persists a bounded plan before codec failure", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "hereisit-runner-"));
    roots.push(workspace);
    const inputPath = join(workspace, "input.bin");
    await sharp({
      create: { width: 8, height: 6, channels: 3, background: "#3478ab" },
    })
      .jpeg()
      .toFile(inputPath);
    const byteLength = (await lstat(inputPath)).size;
    const request: EngineCreateJobRequest = {
      protocol: 1,
      jobId: "123e4567-e89b-42d3-a456-426614174001",
      attempt: 1,
      tool: "image.optimize",
      toolVersion: 1,
      spec: {
        version: 1,
        mode: "smart",
        preset: "balanced",
        output: "same-format",
        metadata: "strip",
        orientation: "apply",
        colorSpace: "srgb",
        minimumSavingsPercent: 1,
      },
      specHash: "a".repeat(64),
      input: { byteLength, etag: "opaque", mimeHint: "image/jpeg" },
      resourceClass: "image-standard-v1",
    };
    const records: unknown[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      records.push(JSON.parse(String(chunk)));
      return true;
    });
    await runPlanningPipeline({ request, workspace });
    expect(records).toMatchObject([
      { state: "running", phase: "validating", sequence: 4 },
      { state: "running", phase: "inspecting", sequence: 5 },
      { state: "running", phase: "normalizing", sequence: 6 },
      { state: "running", phase: "optimizing", sequence: 7 },
      { state: "failed", phase: "optimizing", sequence: 8 },
    ]);
    const persisted = JSON.parse(await readFile(join(workspace, "plan.json"), "utf8"));
    expect(persisted.plan.candidates.length).toBeGreaterThanOrEqual(1);
    expect(persisted.plan.candidates.length).toBeLessThanOrEqual(3);
  });
});

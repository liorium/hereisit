import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { EngineCreateJobRequest } from "@hereisit/server-contracts";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPlanningPipeline } from "./job-runner";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("production runner", () => {
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

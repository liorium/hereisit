import { describe, expect, it, vi } from "vitest";
import type { CommandResult } from "./command";
import { JpegCoefficientVerifierError, verifyJpegCoefficientTransform } from "./jpeg-coeff-verify";

describe("verifyJpegCoefficientTransform", () => {
  it("accepts only the bounded helper's strict normalized record", async () => {
    const run = vi.fn(
      async (_input: unknown): Promise<CommandResult> => ({
        exitCode: 0,
        elapsedMs: 3,
        stderrTail: "",
        stdoutTail:
          '{"exact":true,"sourceSampling":"2x2,1x1,1x1","candidateSampling":"2x2,1x1,1x1","sourceBlocks":12,"candidateBlocks":12}\n',
      }),
    );
    await expect(
      verifyJpegCoefficientTransform({
        sourcePath: "/work/source.jpg",
        candidatePath: "/work/candidate.jpg",
        transform: "flip-h",
        signal: new AbortController().signal,
        run,
      }),
    ).resolves.toEqual({
      exact: true,
      sourceSampling: "2x2,1x1,1x1",
      candidateSampling: "2x2,1x1,1x1",
      sourceBlocks: 12,
      candidateBlocks: 12,
    });
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      command: "/usr/local/bin/jpeg-coeff-verify",
      args: ["flip-h", "/work/source.jpg", "/work/candidate.jpg"],
      timeoutMs: 15_000,
      maxStdoutBytes: 4_096,
    });
  });

  it.each([
    ["helper failure", { exitCode: 2, stdoutTail: "" }],
    ["unknown key", { exitCode: 0, stdoutTail: '{"exact":true,"path":"secret"}' }],
    ["multiple records", { exitCode: 0, stdoutTail: '{"exact":true}\n{"exact":true}' }],
  ])("rejects %s without trusting partial output", async (_name, result) => {
    const run = vi.fn(
      async (): Promise<CommandResult> => ({
        elapsedMs: 1,
        stderrTail: "",
        ...result,
      }),
    );
    await expect(
      verifyJpegCoefficientTransform({
        sourcePath: "/work/source.jpg",
        candidatePath: "/work/candidate.jpg",
        transform: "identity",
        signal: new AbortController().signal,
        run,
      }),
    ).rejects.toBeInstanceOf(JpegCoefficientVerifierError);
  });
});

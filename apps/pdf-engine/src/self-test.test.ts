import { describe, expect, it, vi } from "vitest";
import { runPdfEngineSelfTest } from "./self-test";

describe("PDF engine self-test", () => {
  it("checks qpdf, compiled app, licenses, UID and version", async () => {
    const access = vi.fn().mockResolvedValue(undefined);
    await expect(
      runPdfEngineSelfTest({
        access,
        uid: () => 10001,
        qpdfVersion: async () => "qpdf version 12.4.0",
      }),
    ).resolves.toEqual({ qpdf: "12.4.0", uid: 10001, artifacts: 7 });
    expect(access.mock.calls.map(([path]) => path)).toEqual(
      expect.arrayContaining([
        "/usr/local/bin/qpdf",
        "/app/dist/server.mjs",
        "/licenses/qpdf/LICENSE.txt",
        "/licenses/qpdf/NOTICE.md",
      ]),
    );
  });

  it("rejects root and an unexpected qpdf build", async () => {
    await expect(
      runPdfEngineSelfTest({
        access: vi.fn(),
        uid: () => 0,
        qpdfVersion: async () => "qpdf version 12.4.0",
      }),
    ).rejects.toThrow(/UID/u);
    await expect(
      runPdfEngineSelfTest({
        access: vi.fn(),
        uid: () => 10001,
        qpdfVersion: async () => "qpdf version 12.3.0",
      }),
    ).rejects.toThrow(/qpdf/u);
  });
});

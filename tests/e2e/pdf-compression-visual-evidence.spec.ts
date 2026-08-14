import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
// @ts-expect-error Repository release scripts are executable JavaScript without declarations.
import { validatePdfVisualInputManifest } from "../../scripts/benchmark-pdf-engine.mjs";
// @ts-expect-error Repository release scripts are executable JavaScript without declarations.
import * as visualEvidenceModule from "../../scripts/create-pdf-visual-browser-evidence.mjs";
// @ts-expect-error Repository release scripts are executable JavaScript without declarations.
import { canonicalJson, sha256Bytes } from "../../scripts/image-lab-common.mjs";

const environment = process.env as Record<string, string | undefined>;
const inputRoot = environment.HEREISIT_PDF_VISUAL_INPUT;
const receiptRoot = environment.HEREISIT_PDF_VISUAL_RECEIPTS;
const gitSha = environment.HEREISIT_PDF_VISUAL_GIT_SHA;
const sourceSha256 = environment.HEREISIT_PDF_VISUAL_SOURCE_SHA256;
const checkRunId = environment.HEREISIT_PDF_VISUAL_CHECK_RUN_ID;
const { createPdfVisualProjectReceipt, PDF_VISUAL_BROWSER_PROJECTS } = visualEvidenceModule;

type VisualInput = {
  engineImageDigest: string;
  corpusManifestSha256: string;
  source: { artifact: string; sha256: string; byteLength: number; pageCount: number };
  results: Array<{ artifact: string; sha256: string; byteLength: number; repeat: number }>;
};

async function installLocalNoReduction(page: Page) {
  await page.addInitScript(() => {
    const NativeWorker = Worker;
    class NoReductionWorker extends EventTarget {
      onerror: ((event: ErrorEvent) => unknown) | null = null;
      onmessage: ((event: MessageEvent<unknown>) => unknown) | null = null;
      onmessageerror: ((event: MessageEvent<unknown>) => unknown) | null = null;

      constructor() {
        super();
        queueMicrotask(() =>
          this.onmessage?.(
            new MessageEvent("message", {
              data: {
                protocol: 1,
                type: "ready",
                capabilities: {
                  offscreenCanvas: true,
                  jpegEncoder: true,
                  pdfjsWorker: true,
                  pdfAssembly: true,
                },
                error: null,
              },
            }),
          ),
        );
      }

      postMessage(value: unknown) {
        const request = value as { jobId?: unknown; type?: unknown };
        if (request.type !== "run" || typeof request.jobId !== "string") return;
        queueMicrotask(() =>
          this.onmessage?.(
            new MessageEvent("message", {
              data: {
                protocol: 1,
                type: "failed",
                jobId: request.jobId,
                error: {
                  code: "NO_SIZE_REDUCTION",
                  message: "PDF 용량을 1% 이상 줄이지 못했어요.",
                  reason: "STRUCTURED_OR_MIXED",
                  retryable: false,
                },
              },
            }),
          ),
        );
      }

      terminate() {}
    }

    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      value: new Proxy(NativeWorker, {
        construct(Target, argumentsList) {
          const options = argumentsList[1] as WorkerOptions | undefined;
          if (options?.name === "hereisit-pdf-compress-scanned-worker")
            return new NoReductionWorker() as unknown as Worker;
          const worker = Reflect.construct(Target, argumentsList) as Worker;
          if (options?.name === "hereisit-pdf-optimize-verifier") {
            const state = globalThis as typeof globalThis & {
              __hereisitPdfVerifierPending?: number;
              __hereisitPdfVerifierCompleted?: number;
              __hereisitReleasePdfVerifier?: () => boolean;
            };
            const releases: Array<() => void> = [];
            const released = new Set<string>();
            state.__hereisitPdfVerifierPending ??= 0;
            state.__hereisitPdfVerifierCompleted ??= 0;
            state.__hereisitReleasePdfVerifier = () => {
              const release = releases.shift();
              release?.();
              return release !== undefined;
            };
            worker.addEventListener("message", (event) => {
              const message = event.data as { jobId?: unknown; type?: unknown };
              if (message.type !== "complete" || typeof message.jobId !== "string") return;
              if (released.has(message.jobId)) {
                state.__hereisitPdfVerifierCompleted =
                  (state.__hereisitPdfVerifierCompleted ?? 0) + 1;
                return;
              }
              event.stopImmediatePropagation();
              state.__hereisitPdfVerifierPending = (state.__hereisitPdfVerifierPending ?? 0) + 1;
              releases.push(() => {
                released.add(message.jobId as string);
                worker.dispatchEvent(new MessageEvent("message", { data: event.data }));
              });
            });
          }
          return worker;
        },
      }),
    });
  });
}

test("verifies three native image-optimized repeats in the real browser Worker", async ({
  page,
}, testInfo) => {
  test.skip(
    inputRoot === undefined ||
      receiptRoot === undefined ||
      gitSha === undefined ||
      sourceSha256 === undefined ||
      checkRunId === undefined,
    "exact hosted PDF visual inputs are not configured",
  );
  test.skip(
    !PDF_VISUAL_BROWSER_PROJECTS.includes(testInfo.project.name),
    "PDF visual evidence uses desktop browser engines only",
  );
  test.setTimeout(180_000);

  const root = resolve(inputRoot as string);
  const manifestBytes = await readFile(join(root, "manifest.json"));
  const input = validatePdfVisualInputManifest(
    JSON.parse(manifestBytes.toString("utf8")),
  ) as VisualInput;
  const source = await readFile(join(root, input.source.artifact));
  expect(sha256Bytes(source)).toBe(input.source.sha256);
  const outputs = await Promise.all(
    input.results.map(async (result) => {
      const bytes = await readFile(join(root, result.artifact));
      expect(sha256Bytes(bytes)).toBe(result.sha256);
      return bytes;
    }),
  );
  let activeRepeat = 0;
  const acknowledged = new Set<number>();
  await installLocalNoReduction(page);
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/v1/analytics/events") {
      await route.fulfill({ status: 204 });
      return;
    }
    const jobId = `123e4567-e89b-42d3-a456-4266141741${String(activeRepeat).padStart(2, "0")}`;
    const call = `${request.method()} ${path}`;
    const output = outputs[activeRepeat] as Buffer;
    if (call === "POST /v1/policy") {
      await route.fulfill({
        status: 200,
        json: {
          contract: "tool-job@1",
          toolContract: "pdf.optimize@1",
          execution: "server",
          reason: null,
          maintainer: true,
          disclosure: {
            upload: true,
            inputDeletion: "terminal",
            resultDeletion: {
              mode: "server-temporary",
              acknowledged: "immediate-delete-attempt",
              unacknowledgedDueSeconds: 1800,
              applicationSloSeconds: 2100,
              lifecycleExpirationDays: 1,
              exceptionalDelayPossible: true,
            },
          },
          limits: { maxFiles: 1, maxBytesPerFile: 50 * 1024 * 1024, maxPagesPerFile: 100 },
        },
      });
    } else if (call === "POST /v1/jobs") {
      await route.fulfill({
        status: 200,
        json: {
          contract: "tool-job@1",
          mode: "upload-required",
          jobId,
          upload: {
            kind: "worker-stream-put",
            method: "PUT",
            path: `/v1/jobs/${jobId}/input`,
            contentType: "application/pdf",
            byteLength: source.byteLength,
            expiresAt: "2099-01-01T00:00:00.000Z",
          },
          reservedWeightedUnits: 1,
        },
      });
    } else if (call === `PUT /v1/jobs/${jobId}/input`) {
      await route.fulfill({ status: 204 });
    } else if (call === `GET /v1/jobs/${jobId}`) {
      await route.fulfill({
        status: 200,
        json: {
          contract: "tool-job@1",
          jobId,
          state: "succeeded",
          phase: "completed",
          phaseFraction: 1,
          sequence: 1,
          attempt: 1,
          updatedAt: "2026-08-14T00:00:00.000Z",
          result: {
            kind: "download",
            mime: "application/pdf",
            sourceByteLength: source.byteLength,
            byteLength: output.byteLength,
            pageCount: input.source.pageCount,
            profile: "image-optimized",
            engineBuildId: "qpdf-12.4.0-visual-evidence",
            warnings: ["SIGNATURES_INVALIDATED", "EMBEDDED_IMAGE_QUALITY_CHANGED"],
          },
        },
      });
    } else if (call === `GET /v1/jobs/${jobId}/result`) {
      await route.fulfill({
        status: 200,
        headers: {
          "content-length": String(output.byteLength),
          "content-type": "application/pdf",
          digest: `sha-256=${createHash("sha256").update(output).digest("base64")}`,
          "x-download-lease": "a".repeat(43),
        },
        body: output,
      });
    } else if (call === `POST /v1/jobs/${jobId}/downloaded`) {
      acknowledged.add(activeRepeat);
      await route.fulfill({ status: 200, contentType: "text/plain", body: "ok" });
    } else if (call === `DELETE /v1/jobs/${jobId}`) {
      await route.fulfill({ status: 200, contentType: "text/plain", body: "ok" });
    } else {
      await route.abort("blockedbyclient");
    }
  });

  await page.goto("/pdf/compress");
  await expect(page.getByRole("button", { name: "PDF 선택" })).toBeEnabled({ timeout: 60_000 });
  for (const result of input.results) {
    activeRepeat = result.repeat;
    await page.locator('input[type="file"]').setInputFiles({
      name: "generated-visual-evidence.pdf",
      mimeType: "application/pdf",
      buffer: source,
    });
    await expect(
      page.getByText(`${input.source.pageCount}페이지 PDF를 불러왔어요.`).first(),
    ).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: `${input.source.pageCount}페이지 용량 줄이기` }).click();
    await page.getByRole("button", { name: "처리 서버에서 더 압축" }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (globalThis as typeof globalThis & { __hereisitPdfVerifierPending?: number })
              .__hereisitPdfVerifierPending ?? 0,
        ),
      )
      .toBe(result.repeat + 1);
    await expect(page.getByRole("button", { name: "PDF 다운로드 ↓" })).toHaveCount(0);
    expect(
      await page.evaluate(
        () =>
          (
            globalThis as typeof globalThis & { __hereisitReleasePdfVerifier?: () => boolean }
          ).__hereisitReleasePdfVerifier?.() ?? false,
      ),
    ).toBe(true);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (globalThis as typeof globalThis & { __hereisitPdfVerifierCompleted?: number })
              .__hereisitPdfVerifierCompleted ?? 0,
        ),
      )
      .toBe(result.repeat + 1);
    await expect(page.getByRole("heading", { name: "용량 줄이기 완료" })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByRole("button", { name: "PDF 다운로드 ↓" })).toBeVisible();
    await expect.poll(() => acknowledged.has(activeRepeat)).toBe(true);
    await page.getByRole("button", { name: "다른 PDF 압축" }).click();
    await expect(page.getByRole("button", { name: "PDF 선택" })).toBeVisible();
  }

  const receipt = createPdfVisualProjectReceipt({
    gitSha: gitSha as string,
    sourceSha256: sourceSha256 as string,
    checkRunId: checkRunId as string,
    project: testInfo.project.name,
    inputManifestSha256: sha256Bytes(manifestBytes),
    input,
  });
  await mkdir(resolve(receiptRoot as string), { recursive: true, mode: 0o700 });
  await writeFile(
    join(resolve(receiptRoot as string), `${testInfo.project.name}.json`),
    canonicalJson(receipt),
    { flag: "wx", mode: 0o600 },
  );
});

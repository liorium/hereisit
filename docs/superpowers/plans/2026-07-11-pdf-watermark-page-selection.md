# PDF Watermark Page Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users apply the existing local text watermark to every PDF page or to a validated page range, with explicit lifecycle regression coverage and a separately verified production deployment.

**Architecture:** Keep `pdf.watermark@1` and its existing selected-page pipeline unchanged. Add UI state that translates `모든 페이지 / 지정 페이지` into the existing `PdfPageSelection` contract, expose same-settings rerun through the normal `startProcessing()` path, harden the public PDF job handle against terminal-state progress events, and reuse the current page-range parser and PDF Worker.

**Tech Stack:** TypeScript 6, React 19, Next.js 16 static export, Zod, Vitest 4, Playwright 1.61, `@cantoo/pdf-lib`, Cloudflare Pages, GitHub Actions.

## Global Constraints

- The source PDF and filename never leave the current tab or its dedicated Worker.
- Do not add or update any dependency for this release.
- Preserve `pdf.watermark@1`, Worker protocol version `1`, the 50MB input limit, and the 500-page document limit.
- Default to `모든 페이지`; `지정 페이지` accepts the existing `1-3, 5` grammar.
- Repeated page numbers normalize to one sorted entry; invalid syntax never starts a job.
- A syntactically valid page above the source count must settle as `PAGE_RANGE_INVALID` with `이 PDF는 N페이지까지 있어요.`
- A cancelled or failed job never exposes a partial PDF.
- Same-settings rerun revokes the previous result before starting and keeps the current file and controls.
- Existing watermark rendering, layout, opacity, color, rotation, and font-size behavior must not change.
- Controls remain at least 44px on mobile, text inputs use at least 16px, and the page never overflows horizontally.
- Release browsers are current Chromium, Firefox, desktop WebKit, mobile Chromium, and mobile WebKit.

---

### Task 1: Harden the PDF job terminal lifecycle

**Files:**
- Create: `packages/browser-runtime/src/run-pdf-job.test.ts`
- Modify: `packages/browser-runtime/src/run-pdf-job.ts:78-96`

**Interfaces:**
- Consumes: `runPdfJob(files, spec, options): PdfJobHandle` and `PdfWorkerEvent` from `@hereisit/tool-contracts`.
- Produces: the invariant that progress and terminal Worker events are ignored after cancellation or settlement.

- [ ] **Step 1: Write the failing stale-progress regression test**

Create `packages/browser-runtime/src/run-pdf-job.test.ts` with the following test harness and first test:

```ts
import type {
  PdfPipelineSpecV1,
  PdfPipelineResult,
  PdfWorkerEvent,
  PdfWorkerRequest,
} from "@hereisit/tool-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPdfJob } from "./run-pdf-job";

const watermarkSpec: PdfPipelineSpecV1 = {
  version: 1,
  operation: "watermark",
  watermark: {
    text: "대외비",
    placement: "center",
    fontSize: 48,
    opacity: 0.18,
    rotation: -45,
    color: "#334155",
  },
  selection: { mode: "every-page" },
};

function fakePdfFile(read: Promise<ArrayBuffer> = Promise.resolve(Uint8Array.of(1).buffer)): File {
  return {
    name: "report.pdf",
    type: "application/pdf",
    size: 1,
    arrayBuffer: () => read,
  } as File;
}

function pdfResult(suggestedName = "result.pdf"): PdfPipelineResult {
  return {
    bytes: new ArrayBuffer(1),
    suggestedName,
    mime: "application/pdf",
    byteLength: 1,
    sourcePageCount: 1,
    outputPageCount: 1,
    outputDocumentCount: 1,
    warnings: [],
    timing: { loadMs: 0, processMs: 0, saveMs: 0, totalMs: 0 },
  };
}

class SilentWorker {
  static latest: SilentWorker | undefined;
  readonly messages: PdfWorkerRequest[] = [];
  terminateCount = 0;
  onmessage: ((event: MessageEvent<PdfWorkerEvent>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;

  constructor() {
    SilentWorker.latest = this;
  }

  postMessage(message: PdfWorkerRequest): void {
    this.messages.push(message);
  }

  terminate(): void {
    this.terminateCount += 1;
  }

  emit(event: PdfWorkerEvent): void {
    this.onmessage?.({ data: event } as MessageEvent<PdfWorkerEvent>);
  }
}

function installWorker(worker: typeof SilentWorker = SilentWorker): void {
  vi.stubGlobal("Worker", worker);
  vi.stubGlobal("File", class {});
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  SilentWorker.latest = undefined;
});

describe("runPdfJob", () => {
  it("cancels after posting a run and ignores later Worker events", async () => {
    installWorker();
    const onProgress = vi.fn();
    const handle = runPdfJob([fakePdfFile()], watermarkSpec, { onProgress });
    const worker = SilentWorker.latest as SilentWorker;

    await vi.waitFor(() => expect(worker.messages.some((message) => message.type === "run")).toBe(true));
    const run = worker.messages.find((message) => message.type === "run");
    expect(run).toBeDefined();
    handle.cancel();
    await expect(handle.result).resolves.toEqual({ status: "cancelled" });
    const cancel = worker.messages.find((message) => message.type === "cancel");
    expect(cancel).toBeDefined();

    worker.emit({
      protocol: 1,
      type: "progress",
      jobId: run?.jobId ?? "missing",
      sequence: 1,
      phase: "processing",
      fraction: 0.5,
    });
    worker.emit({
      protocol: 1,
      type: "complete",
      jobId: run?.jobId ?? "missing",
      result: pdfResult("late.pdf"),
    });

    expect(onProgress).not.toHaveBeenCalled();
    expect(worker.terminateCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run the targeted test and verify the terminal-state gap**

Run:

```bash
pnpm test packages/browser-runtime/src/run-pdf-job.test.ts
```

Expected: FAIL because `onProgress` is called once after `handle.cancel()` even though the Worker request has already been posted and the handle has settled as cancelled.

- [ ] **Step 3: Add the minimal terminal guard**

At the start of the PDF Worker's `onmessage` callback in `runPdfJob`, add the settled/cancelled guard before protocol and job checks:

```ts
worker.onmessage = (message: MessageEvent<PdfWorkerEvent>) => {
  if (settled || cancelled) return;
  const event = message.data;
  if (event.protocol !== WORKER_PROTOCOL_VERSION || event.type === "ready") return;
  if (event.jobId !== jobId) return;
  // existing progress, complete, and failed branches remain unchanged
};
```

- [ ] **Step 4: Run the targeted test and verify green**

Run:

```bash
pnpm test packages/browser-runtime/src/run-pdf-job.test.ts
```

Expected: 1 test passes with no warning or unhandled rejection.

- [ ] **Step 5: Add lifecycle characterization tests**

Append these tests inside the existing `describe("runPdfJob", ...)` block:

```ts
it("cancels before file reading completes without posting a run request", async () => {
  installWorker();
  let release: (bytes: ArrayBuffer) => void = () => undefined;
  const read = new Promise<ArrayBuffer>((resolve) => {
    release = resolve;
  });
  const handle = runPdfJob([fakePdfFile(read)], watermarkSpec);
  const worker = SilentWorker.latest as SilentWorker;

  handle.cancel();
  release(Uint8Array.of(1).buffer);
  await Promise.resolve();
  await Promise.resolve();

  await expect(handle.result).resolves.toEqual({ status: "cancelled" });
  expect(worker.messages.some((message) => message.type === "run")).toBe(false);
  expect(worker.terminateCount).toBe(1);
});

it("ignores later progress and completion after fulfillment", async () => {
  installWorker();
  const onProgress = vi.fn();
  const handle = runPdfJob([fakePdfFile()], watermarkSpec, { onProgress });
  const worker = SilentWorker.latest as SilentWorker;

  await vi.waitFor(() => expect(worker.messages.some((message) => message.type === "run")).toBe(true));
  const run = worker.messages.find((message) => message.type === "run");
  expect(run).toBeDefined();
  worker.emit({
    protocol: 1,
    type: "complete",
    jobId: run?.jobId ?? "missing",
    result: pdfResult("first.pdf"),
  });
  await expect(handle.result).resolves.toMatchObject({
    status: "fulfilled",
    value: { suggestedName: "first.pdf" },
  });

  worker.emit({
    protocol: 1,
    type: "progress",
    jobId: run?.jobId ?? "missing",
    sequence: 2,
    phase: "finalizing",
    fraction: 1,
  });
  worker.emit({
    protocol: 1,
    type: "complete",
    jobId: run?.jobId ?? "missing",
    result: pdfResult("late.pdf"),
  });

  expect(onProgress).not.toHaveBeenCalled();
  expect(worker.terminateCount).toBe(1);
});

it("settles the three-minute watchdog and terminates once", async () => {
  vi.useFakeTimers();
  installWorker();
  const handle = runPdfJob([fakePdfFile()], watermarkSpec);
  const worker = SilentWorker.latest as SilentWorker;

  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(180_000);

  await expect(handle.result).resolves.toMatchObject({
    status: "rejected",
    error: { code: "WORKER_CRASH", retryable: true },
  });
  expect(worker.terminateCount).toBe(1);
});

it("turns synchronous Worker construction failure into a rejected outcome", async () => {
  class ThrowingWorker extends SilentWorker {
    constructor() {
      super();
      throw new DOMException("blocked", "SecurityError");
    }
  }
  installWorker(ThrowingWorker);

  const handle = runPdfJob([fakePdfFile()], watermarkSpec);

  await expect(handle.result).resolves.toMatchObject({
    status: "rejected",
    error: { code: "WORKER_CRASH", retryable: true },
  });
});
```

- [ ] **Step 6: Format, run runtime tests, and typecheck**

Run:

```bash
pnpm exec biome check --write packages/browser-runtime/src/run-pdf-job.test.ts packages/browser-runtime/src/run-pdf-job.ts
pnpm test packages/browser-runtime/src/run-pdf-job.test.ts packages/browser-runtime/src/pdf-pipeline.test.ts
pnpm --filter @hereisit/browser-runtime typecheck
```

Expected: Biome leaves both runtime files clean, the new lifecycle tests and existing PDF pipeline tests pass, and browser-runtime typecheck exits 0.

- [ ] **Step 7: Commit the lifecycle hardening**

```bash
git add packages/browser-runtime/src/run-pdf-job.test.ts packages/browser-runtime/src/run-pdf-job.ts
git commit -m "fix: ignore settled PDF worker events"
```

### Task 2: Lock the existing watermark selection boundaries

**Files:**
- Modify: `packages/tool-contracts/src/index.test.ts:138-159`
- Modify: `packages/browser-runtime/src/pdf-pipeline.test.ts:278-310`

**Interfaces:**
- Consumes: `pdfPipelineSpecSchema` and the existing `runPdfPipeline()` watermark branch.
- Produces: explicit regression evidence for both selection modes, invalid direct page arrays, and watermark-specific `PAGE_RANGE_INVALID` mapping.

- [ ] **Step 1: Add direct watermark contract coverage**

Add these cases inside the existing `describe("pdfPipelineSpecSchema", ...)` block in `packages/tool-contracts/src/index.test.ts`:

```ts
it.each([
  ["every page", { mode: "every-page" }],
  ["selected pages", { mode: "extract", pages: [1, 500] }],
])("accepts watermark selection for %s", (_case, selection) => {
  const result = pdfPipelineSpecSchema.safeParse({
    version: 1,
    operation: "watermark",
    watermark: {
      text: "대외비",
      placement: "center",
      fontSize: 48,
      opacity: 0.18,
      rotation: -45,
      color: "#334155",
    },
    selection,
  });

  expect(result.success).toBe(true);
});

it.each([
  ["an empty page array", []],
  ["duplicate pages", [1, 1]],
  ["page zero", [0]],
  ["a negative page", [-1]],
  ["more than 500 pages", Array.from({ length: 501 }, (_, index) => index + 1)],
])("rejects watermark selection with %s", (_case, pages) => {
  const result = pdfPipelineSpecSchema.safeParse({
    version: 1,
    operation: "watermark",
    watermark: {
      text: "대외비",
      placement: "center",
      fontSize: 48,
      opacity: 0.18,
      rotation: -45,
      color: "#334155",
    },
    selection: { mode: "extract", pages },
  });

  expect(result.success).toBe(false);
});
```

- [ ] **Step 2: Add the watermark out-of-bounds pipeline regression**

Add this test immediately after the existing selected-page watermark pipeline test in `packages/browser-runtime/src/pdf-pipeline.test.ts`:

```ts
it("maps a watermark page above the source count to PAGE_RANGE_INVALID", async () => {
  const source = await samplePdf([100]);

  await expect(
    runPdfPipeline([input("report.pdf", source)], {
      version: 1,
      operation: "watermark",
      watermark: {
        text: "대외비",
        placement: "center",
        fontSize: 48,
        opacity: 0.18,
        rotation: -45,
        color: "#334155",
      },
      selection: { mode: "extract", pages: [2] },
    }),
  ).rejects.toMatchObject({
    payload: {
      code: "PAGE_RANGE_INVALID",
      message: "이 PDF는 1페이지까지 있어요.",
      retryable: false,
    },
  });
});
```

- [ ] **Step 3: Format and verify both boundary suites**

Run:

```bash
pnpm exec biome check --write packages/tool-contracts/src/index.test.ts packages/browser-runtime/src/pdf-pipeline.test.ts
pnpm test packages/tool-contracts/src/index.test.ts packages/browser-runtime/src/pdf-pipeline.test.ts
pnpm --filter @hereisit/tool-contracts typecheck
pnpm --filter @hereisit/browser-runtime typecheck
```

Expected: both suites pass without changing a production contract or pipeline; the direct schema rejects all five invalid arrays and the watermark pipeline returns the exact range code and Korean source-page limit.

- [ ] **Step 4: Commit the boundary regressions**

```bash
git add packages/tool-contracts/src/index.test.ts packages/browser-runtime/src/pdf-pipeline.test.ts
git commit -m "test: lock PDF watermark page boundaries"
```

### Task 3: Add selected-page watermark controls

**Files:**
- Modify: `tests/e2e/pdf-tools.spec.ts:176-220`
- Modify: `apps/web/src/components/pdf-workbench.tsx:49-596`
- Modify: `apps/web/src/components/pdf-workbench.tsx:911-1040`
- Modify: `apps/web/src/components/pdf-workbench.tsx:1124-1148`
- Modify: `apps/web/src/components/pdf-workbench.module.css:502-612`

**Interfaces:**
- Consumes: `parsePageSelection(value): PageSelectionResult`, `PdfPipelineSpecV1`, and the existing watermark `selection` contract.
- Produces: `watermarkScope`, `watermarkPageRange`, `parsedWatermarkPageRange`, a watermark spec whose selection is `every-page` or validated `extract` pages, and a user-visible same-settings rerun action.

- [ ] **Step 1: Write the failing browser flow**

Keep the existing all-page watermark test. Add this second test immediately after it in `tests/e2e/pdf-tools.spec.ts`:

```ts
test("watermarks only selected pages and revokes the previous result", async ({ page }) => {
  await page.addInitScript(() => {
    const createdKey = "__hereisitCreatedCount";
    const revokedKey = "__hereisitRevokedCount";
    if (sessionStorage.getItem(createdKey) === null) sessionStorage.setItem(createdKey, "0");
    if (sessionStorage.getItem(revokedKey) === null) sessionStorage.setItem(revokedKey, "0");
    const originalCreate = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (object: Blob | MediaSource) => {
      const count = Number(sessionStorage.getItem(createdKey) ?? "0");
      sessionStorage.setItem(createdKey, String(count + 1));
      return originalCreate(object);
    };
    const originalRevoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url: string) => {
      const count = Number(sessionStorage.getItem(revokedKey) ?? "0");
      sessionStorage.setItem(revokedKey, String(count + 1));
      originalRevoke(url);
    };
  });
  await page.goto("/pdf/watermark");

  const unexpectedRequests: string[] = [];
  page.on("request", (request) => {
    const requestUrl = new URL(request.url());
    const pageUrl = new URL(page.url());
    if (
      requestUrl.origin !== pageUrl.origin ||
      !["GET", "HEAD"].includes(request.method()) ||
      request.postData() !== null
    ) {
      unexpectedRequests.push(request.url());
    }
  });

  await page.locator("input[type=file]").setInputFiles({
    name: "selected.pdf",
    mimeType: "application/pdf",
    buffer: await createPdf([100, 200]),
  });

  await page.getByRole("button", { name: "PDF에 워터마크 넣기 →" }).click();
  await expect(page.getByText("2페이지 PDF 준비 완료")).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() => page.evaluate(() => Number(sessionStorage.getItem("__hereisitCreatedCount"))))
    .toBe(1);

  await page.getByRole("group", { name: "적용 페이지" }).getByRole("radio", {
    name: /지정 페이지/,
  }).check();
  await expect
    .poll(() => page.evaluate(() => Number(sessionStorage.getItem("__hereisitRevokedCount"))))
    .toBe(1);

  const range = page.getByLabel("페이지 범위", { exact: true });
  const runButton = page.getByRole("button", { name: "PDF에 워터마크 넣기 →" });
  await range.fill("3-");
  await expect(runButton).toBeDisabled();
  await expect(page.getByText("예: 1-3, 5, 8-10 형식으로 입력해 주세요.")).toBeVisible();

  await range.fill("3");
  await runButton.click();
  await expect(page.getByText("이 PDF는 2페이지까지 있어요.")).toBeVisible({ timeout: 20_000 });

  await range.fill("2");
  await runButton.click();
  await expect(page.getByText("2페이지 PDF 준비 완료")).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() => page.evaluate(() => Number(sessionStorage.getItem("__hereisitCreatedCount"))))
    .toBe(2);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "PDF 저장·공유 ↓" }).click(),
  ]);
  const output = await downloadedBytes(await download.path());
  const document = await PDFDocument.load(output);
  expect(document.getPage(0).node.Contents()).toBeUndefined();
  expect(document.getPage(1).node.Contents()).toBeDefined();

  await range.fill("1");
  await expect
    .poll(() => page.evaluate(() => Number(sessionStorage.getItem("__hereisitRevokedCount"))))
    .toBe(2);
  await runButton.click();
  await expect
    .poll(() => page.evaluate(() => Number(sessionStorage.getItem("__hereisitCreatedCount"))), {
      timeout: 20_000,
    })
    .toBe(3);

  await page.getByRole("button", { name: "같은 설정으로 다시 실행" }).click();
  await expect
    .poll(() => page.evaluate(() => Number(sessionStorage.getItem("__hereisitCreatedCount"))), {
      timeout: 20_000,
    })
    .toBe(4);
  await expect(page.getByText("2페이지 PDF 준비 완료")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => Number(sessionStorage.getItem("__hereisitRevokedCount"))))
    .toBe(3);

  await page.getByRole("button", { name: "새 작업" }).click();
  await expect
    .poll(() => page.evaluate(() => Number(sessionStorage.getItem("__hereisitRevokedCount"))))
    .toBe(4);

  await page.locator("input[type=file]").setInputFiles({
    name: "selected-again.pdf",
    mimeType: "application/pdf",
    buffer: await createPdf([100, 200]),
  });
  await page.getByRole("button", { name: "PDF에 워터마크 넣기 →" }).click();
  await expect(page.getByText("2페이지 PDF 준비 완료")).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() => page.evaluate(() => Number(sessionStorage.getItem("__hereisitCreatedCount"))))
    .toBe(5);
  await page.evaluate(() => {
    const nextWindow = window as Window & {
      next?: { router?: { push: (path: string) => void } };
    };
    const router = nextWindow.next?.router;
    if (router === undefined) throw new Error("Next router unavailable");
    router.push("/pdf/merge");
  });
  await expect(page.getByRole("heading", { level: 1, name: "PDF 합치기" })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => Number(sessionStorage.getItem("__hereisitRevokedCount"))))
    .toBe(5);

  expect(unexpectedRequests).toEqual([]);
});
```

- [ ] **Step 2: Build the current app and verify the new test is red**

Run:

```bash
pnpm build
pnpm test:e2e --project=chromium --grep "watermarks only selected pages"
```

Expected: FAIL because the `적용 페이지` group does not exist.

- [ ] **Step 3: Add watermark selection state and validation**

In `PdfWorkbench`, add state beside the current watermark state and a separate memoized parser result:

```ts
const [watermarkScope, setWatermarkScope] = useState<"every-page" | "selected-pages">(
  "every-page",
);
const [watermarkPageRange, setWatermarkPageRange] = useState("1");

const parsedWatermarkPageRange = useMemo(
  () => parsePageSelection(watermarkPageRange),
  [watermarkPageRange],
);
```

Replace the hard-coded watermark selection inside `buildSpec()` with this exact validation and mapping:

```ts
let selection: Extract<PdfPipelineSpecV1, { operation: "watermark" }>["selection"] = {
  mode: "every-page",
};
if (watermarkScope === "selected-pages") {
  if (!parsedWatermarkPageRange.ok) {
    setMessage(parsedWatermarkPageRange.message);
    return undefined;
  }
  selection = { mode: "extract", pages: [...parsedWatermarkPageRange.pages] };
}
return {
  version: 1,
  operation: "watermark",
  watermark: {
    text: watermarkText.trim(),
    placement: watermarkPlacement,
    fontSize: watermarkFontSize,
    opacity: watermarkOpacity / 100,
    rotation: watermarkRotation,
    color: watermarkColor,
  },
  selection,
};
```

Extend `canRun` so selected watermark pages must parse before execution:

```ts
(intent !== "watermark" ||
  (validWatermarkText &&
    (watermarkScope === "every-page" || parsedWatermarkPageRange.ok)))
```

- [ ] **Step 4: Replace the all-page notice with accessible controls**

Replace the current `모든 페이지에 적용` setting card with this fieldset:

```tsx
<fieldset className={styles.optionGroup}>
  <legend>적용 페이지</legend>
  <label>
    <input
      type="radio"
      name="watermark-scope"
      checked={watermarkScope === "every-page"}
      disabled={busy}
      onChange={() => {
        setWatermarkScope("every-page");
        clearResult();
        setMessage("모든 페이지에 같은 워터마크를 넣어요.");
      }}
    />
    <span>
      <strong>모든 페이지</strong>
      <small>PDF 전체에 같은 워터마크 적용</small>
    </span>
  </label>
  <label>
    <input
      type="radio"
      name="watermark-scope"
      checked={watermarkScope === "selected-pages"}
      disabled={busy}
      onChange={() => {
        setWatermarkScope("selected-pages");
        clearResult();
        setMessage("입력한 페이지에만 워터마크를 넣어요.");
      }}
    />
    <span>
      <strong>지정 페이지</strong>
      <small>예: 1-3, 5 형식으로 필요한 페이지만 선택</small>
    </span>
  </label>
  {watermarkScope === "selected-pages" ? (
    <div className={styles.rangeField}>
      <label htmlFor="pdf-watermark-page-range">페이지 범위</label>
      <input
        id="pdf-watermark-page-range"
        type="text"
        value={watermarkPageRange}
        disabled={busy}
        aria-invalid={!parsedWatermarkPageRange.ok}
        aria-describedby="pdf-watermark-page-range-help"
        onChange={(event) => {
          setWatermarkPageRange(event.target.value);
          clearResult();
        }}
      />
      <small id="pdf-watermark-page-range-help">
        {parsedWatermarkPageRange.ok
          ? `${parsedWatermarkPageRange.pages.length}페이지를 선택했어요.`
          : parsedWatermarkPageRange.message}
      </small>
    </div>
  ) : null}
</fieldset>
```

Add this CSS rule so the nested option group fits the already padded watermark panel without changing other PDF tools:

```css
.watermarkSettings .optionGroup {
  margin: 0;
}
```

Change the watermark input description in `INTENT_CONFIG` to:

```ts
fileDescription: "PDF 한 개 · 최대 50MB · 모든 페이지 또는 지정 페이지",
```

In the `result !== undefined` action branch, add this watermark-only button between `새 작업` and the save/share button. It deliberately calls the normal `startProcessing()` path while the previous result still exists, so `clearResult()` revokes that URL before the new Worker job begins without changing the other PDF tools:

```tsx
{intent === "watermark" ? (
  <button
    className={styles.secondaryButton}
    type="button"
    onClick={() => void startProcessing()}
  >
    같은 설정으로 다시 실행
  </button>
) : null}
```

- [ ] **Step 5: Format, build, and verify the selected-page browser flow**

Run:

```bash
pnpm lint:fix
pnpm build
pnpm test:e2e --project=chromium --grep "watermark"
```

Expected: both the original all-page watermark test and the new selected-page test pass. The selected result has content only on page 2, invalid range syntax disables execution, the out-of-range attempt says the source has two pages, and five distinct result URLs are revoked on scope change, range change, direct rerun, reset, and client-side unmount.

- [ ] **Step 6: Commit the selected-page UI**

```bash
git add apps/web/src/components/pdf-workbench.tsx apps/web/src/components/pdf-workbench.module.css tests/e2e/pdf-tools.spec.ts
git commit -m "feat: select PDF watermark pages"
```

### Task 4: Verify mobile controls and update public copy

**Files:**
- Modify: `tests/e2e/mobile.spec.ts:127-162`
- Modify: `apps/web/src/lib/site.ts:171-193`
- Modify: `README.md:62-67`
- Modify: `docs/architecture.md:33-37`

**Interfaces:**
- Consumes: the `적용 페이지` fieldset, `페이지 범위` input, and direct rerun action produced by Task 3.
- Produces: mobile coverage for the selected-page and result-action flows, plus user-facing copy that no longer claims watermarking is all-page-only.

- [ ] **Step 1: Extend the mobile Worker test**

In the existing mobile watermark test, select the page-specific flow and include its controls in the touch-size assertions:

```ts
const scope = page
  .getByRole("group", { name: "적용 페이지" })
  .getByRole("radio", { name: /지정 페이지/ });
await scope.check();
const range = page.getByLabel("페이지 범위", { exact: true });
await range.fill("1");
const rangeFontSize = await range.evaluate((element) => getComputedStyle(element).fontSize);
expect(rangeFontSize).toBe("16px");

for (const control of [text, placement.locator(".."), opacity, scope.locator(".."), range, run]) {
  const box = await control.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
}
```

Keep the existing Worker execution and result assertion after this block. Replace the single save-button size check with both result actions, then keep the horizontal-overflow assertion:

```ts
const resultActions = [
  page.getByRole("button", { name: "같은 설정으로 다시 실행" }),
  page.getByRole("button", { name: "PDF 저장·공유 ↓" }),
];
for (const control of resultActions) {
  const box = await control.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
}
```

- [ ] **Step 2: Update route metadata and instructional copy**

Use these exact watermark strings in `apps/web/src/lib/site.ts`:

```ts
description:
  "PDF 모든 페이지 또는 지정한 페이지에 원하는 문구의 워터마크를 넣으세요. 업로드 없이 브라우저에서 처리합니다.",
defaultSummary:
  "기본값은 모든 페이지에 ‘대외비’를 18% 불투명도로 가운데에 넣고, 적용 페이지·문구·배치·크기·각도·색상을 바꿀 수 있어요.",
steps: [
  { title: "PDF 선택", description: "워터마크를 넣을 PDF 한 개를 선택하세요." },
  {
    title: "페이지와 모양 설정",
    description: "적용 페이지·문구·배치·글자 크기·불투명도·각도·색상을 정하세요.",
  },
  {
    title: "새 PDF 저장",
    description: "선택한 페이지에 워터마크를 넣은 새 PDF를 기기에 저장해요.",
  },
],
```

Replace the README watermark limit with:

```md
- Watermark text is rasterized locally into a bounded PNG before it is placed on every page or the
  selected pages. It is not searchable or selectable text, and its exact glyph appearance can vary with
  the device font.
```

Replace the architecture watermark sentence with:

```md
The watermark tool renders the validated text once with a bounded `OffscreenCanvas`, embeds that raster
PNG, and reuses it as a centered or tiled overlay on every page or the selected pages.
```

- [ ] **Step 3: Format and run the mobile and metadata checks**

Run:

```bash
pnpm lint:fix
pnpm build
pnpm test:e2e --project=mobile-chromium --grep "watermark"
pnpm test:e2e --project=chromium --grep "publishes every PDF route"
```

Expected: the mobile watermark Worker test passes with 44px controls, a 16px range input, and no horizontal overflow; PDF route metadata remains unique and reachable.

- [ ] **Step 4: Commit mobile coverage and copy**

```bash
git add tests/e2e/mobile.spec.ts apps/web/src/lib/site.ts README.md docs/architecture.md
git commit -m "docs: explain selected PDF watermarks"
```

### Task 5: Verify, review, publish, and smoke-test the release

**Files:**
- Verify: all files changed in Tasks 1-4
- Verify: `apps/web/out/`
- Verify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: all four implementation commits and the existing Cloudflare Pages Git integration.
- Produces: a clean `main`, passing local and remote verification, a successful Cloudflare deployment, and live all-page plus selected-page smoke results.

- [ ] **Step 1: Run the complete local verification**

Run:

```bash
pnpm lint:fix
pnpm verify
pnpm test:e2e
git diff --check
git status --short --branch
```

Expected: lint, six package typechecks, all unit tests, the 13-route static build, static export verification, and all local Chromium/Firefox/mobile-Chromium E2E tests pass. `git diff --check` prints nothing, and the working tree has no unstaged or untracked product changes.

- [ ] **Step 2: Review the complete release diff**

Run:

```bash
git diff origin/main...HEAD --stat
git diff origin/main...HEAD --name-status
```

Expected: only the approved design/plan documents, runtime test/guard, contract and pipeline boundary tests, watermark UI and E2E, mobile coverage, metadata, README, and architecture files are present. Resolve any unrelated path before publishing.

- [ ] **Step 3: Confirm the remote base is unchanged and push main**

Run:

```bash
git fetch origin main
git rev-list --left-right --count HEAD...origin/main
git push origin main
```

Expected before push: the left count is the local release commits and the right count is `0`. Expected after push: Git reports `main -> main`.

- [ ] **Step 4: Require GitHub CI and Cloudflare success**

Run:

```bash
set -euo pipefail
SHA="$(git rev-parse HEAD)"
RUN_ID=""
for attempt in {1..30}; do
  RUN_ID="$(gh run list --workflow ci.yml --commit "$SHA" --limit 1 --json databaseId --jq '.[0].databaseId // empty')"
  [[ -n "$RUN_ID" ]] && break
  sleep 2
done
test -n "$RUN_ID"
gh run watch "$RUN_ID" --exit-status
gh run view "$RUN_ID" --json url --jq '.url'

CLOUDFLARE_STATUS=""
CLOUDFLARE_CONCLUSION=""
CLOUDFLARE_URL=""
for attempt in {1..60}; do
  IFS=$'\t' read -r CLOUDFLARE_STATUS CLOUDFLARE_CONCLUSION CLOUDFLARE_URL <<< "$(
    gh api "repos/liorium/hereisit/commits/$SHA/check-runs" \
      --jq '[.check_runs[] | select(.name == "Cloudflare Pages")][0] | [(.status // ""), (.conclusion // ""), (.details_url // "")] | @tsv'
  )"
  if [[ "$CLOUDFLARE_STATUS" == "completed" ]]; then
    test "$CLOUDFLARE_CONCLUSION" = "success"
    break
  fi
  sleep 5
done
test "$CLOUDFLARE_STATUS" = "completed"
test "$CLOUDFLARE_CONCLUSION" = "success"
printf '%s\n' "$CLOUDFLARE_URL"
```

Expected: the Actions run whose `headSha` is exactly the release SHA completes successfully, including `verify`, `browser`, desktop/mobile WebKit, and the current-SHA `Cloudflare Pages` check reaches `completed/success`. Any missing, failed, cancelled, or timed-out gate exits non-zero.

- [ ] **Step 5: Verify the live route and both watermark flows**

Run:

```bash
node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PDFDocument } from "@cantoo/pdf-lib";
import { chromium } from "@playwright/test";

const source = await PDFDocument.create();
source.addPage([100, 100]);
source.addPage([200, 100]);
const sourceBytes = Buffer.from(await source.save());
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const unexpected = [];
page.on("request", (request) => {
  const target = new URL(request.url());
  if (
    target.origin !== "https://hereisit.pages.dev" ||
    !["GET", "HEAD"].includes(request.method()) ||
    request.postData() !== null
  ) {
    unexpected.push(request.url());
  }
});

const response = await page.goto("https://hereisit.pages.dev/pdf/watermark");
assert.equal(response?.status(), 200);
const headers = response?.headers() ?? {};
assert.match(headers["content-security-policy"] ?? "", /default-src 'self'/);
assert.equal(headers["x-content-type-options"], "nosniff");
assert.equal(headers["x-frame-options"], "DENY");
assert.equal(headers["referrer-policy"], "no-referrer");
assert.match(headers["permissions-policy"] ?? "", /camera=\(\)/);
const uploadSource = () =>
  page.locator("input[type=file]").setInputFiles({
    name: "live-smoke.pdf",
    mimeType: "application/pdf",
    buffer: sourceBytes,
  });
const run = page.getByRole("button", { name: "PDF에 워터마크 넣기 →" });
const save = page.getByRole("button", { name: "PDF 저장·공유 ↓" });

await uploadSource();
await run.click();
await page.getByText("2페이지 PDF 준비 완료").waitFor({ timeout: 20_000 });
const [allPageDownload] = await Promise.all([page.waitForEvent("download"), save.click()]);
const allPagePath = await allPageDownload.path();
assert.ok(allPagePath);
const allPageResult = await PDFDocument.load(await readFile(allPagePath));
assert.equal(
  allPageResult.getPages().every((pdfPage) => pdfPage.node.Contents() !== undefined),
  true,
);

await page.getByRole("button", { name: "새 작업" }).click();
await uploadSource();
await page.getByRole("group", { name: "적용 페이지" }).getByRole("radio", {
  name: /지정 페이지/,
}).check();
await page.getByLabel("페이지 범위", { exact: true }).fill("2");
await run.click();
await page.getByText("2페이지 PDF 준비 완료").waitFor({ timeout: 20_000 });
const [selectedDownload] = await Promise.all([page.waitForEvent("download"), save.click()]);
const selectedPath = await selectedDownload.path();
assert.ok(selectedPath);
const selectedResult = await PDFDocument.load(await readFile(selectedPath));
assert.equal(selectedResult.getPage(0).node.Contents(), undefined);
assert.notEqual(selectedResult.getPage(1).node.Contents(), undefined);
assert.deepEqual(unexpected, []);
await browser.close();
NODE
```

Expected: assertions prove HTTP 200 plus the existing CSP, MIME-sniffing, frame, referrer, and permissions headers. The production Worker completes both the default all-page flow and a page-2-only flow, their downloaded PDFs have the expected page content, and neither flow makes an external or write request.

- [ ] **Step 6: Record the release outcome**

Run:

```bash
git status --short --branch
git log -6 --oneline --decorate
```

Expected: `main` is synchronized with `origin/main`, the tree is clean, and the design/plan, lifecycle, boundary-test, UI, and documentation commits are visible. Report the live URL, commit SHA, local test counts, GitHub run URL, Cloudflare success, and the next gate: writing the separate PDF-to-images implementation plan.

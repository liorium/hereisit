# PDF Split Workbench Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the shared three-column PDF split workbench with a focused local-only flow for selecting one PDF, choosing split or extract, processing it, understanding the result, and downloading it.

**Architecture:** Keep `PdfWorkbench`, `pdf.split@1`, `inspectPdfFile`, `runPdfJob`, and direct object-URL downloads. Add split-specific render branches inside the existing component, extend the existing PDF inspection path to the single split input, and reuse the existing merge stage primitives where they already fit instead of creating another runtime or component hierarchy.

**Tech Stack:** Next.js 16, React 19, TypeScript 6, CSS Modules, `@hereisit/browser-runtime`, `@hereisit/pdf-tool`, Playwright, Vitest

## Global Constraints

- A PDF must remain in the browser; do not add uploads, network processing, or a new server API.
- Keep the versioned `pdf.split@1` contract, current ZIP entries, result MIME types, and suggested filenames unchanged.
- Accept one PDF up to 50MB; page-by-page splitting remains bounded to 200 source pages by the existing tool contract.
- Default to `페이지별 분리`; keep `페이지 추출` as the secondary radio choice.
- Start the extraction range empty and use `예: 1-3, 5` only as its placeholder.
- Reuse `parsePageSelection(value, maxPage)` for syntax, deduplication, and real source-page bounds.
- Do not add dependencies.
- Do not auto-download and do not expose Web Share; download only after explicit activation.
- Never log file contents, filenames, thumbnails, object URLs, or presigned URLs.
- Keep interactive controls at least 44px, the mobile range input at least 16px, and the page free of horizontal overflow at 320px.
- Browser PDF output is not byte-stable; assert MIME signatures, page/document counts, names, warnings, and semantic size summaries.

## File Map

- Modify `apps/web/src/components/pdf-workbench.tsx`: split inspection state, bounded range parsing, split-specific select/setup/progress/result rendering, cleanup, and retry behavior.
- Modify `apps/web/src/components/pdf-workbench.module.css`: focused setup card, mode controls, range field, processing/result responsiveness, and touch targets.
- Modify `tests/e2e/pdf-tools.spec.ts`: desktop split/extract stages, preflight validation, direct downloads, warnings, reset, and download retry.
- Modify `tests/e2e/mobile.spec.ts`: replace three-column split expectations with the staged 320px/touch-safe flow.
- Read only `packages/pdf-tool/src/page-ranges.ts` and `packages/pdf-tool/src/page-ranges.test.ts`: the required bounded parser and its pure unit coverage already exist.
- Read only `docs/superpowers/specs/2026-08-04-pdf-split-workbench-simplification-design.md`: authoritative UX and behavior contract.

---

### Task 1: Inspect the split input and render the focused setup stage

**Files:**
- Modify: `tests/e2e/pdf-tools.spec.ts:131-224`
- Modify: `apps/web/src/components/pdf-workbench.tsx:160-235,330-377,453-530,644-665,673-875`
- Modify: `apps/web/src/components/pdf-workbench.module.css:1062-1238`

**Interfaces:**
- Consumes: `inspectPdfFile(file: File): PdfInspectionHandle` and `parsePageSelection(value: string, maxPage?: number): PageSelectionResult`.
- Produces: split `PdfWorkItem.inspection` states of `pending`, `ready`, or `failed`; a derived `splitPageCount: number | undefined`; and a setup screen whose run button is enabled only for a ready inspection and valid mode input.

- [ ] **Step 1: Write the failing page-inspection and bounded-range browser test**

Add this test before the current page-by-page split test in `tests/e2e/pdf-tools.spec.ts`:

```ts
test("inspects a split PDF and rejects a page above its real page count", async ({ page }) => {
  await page.goto("/pdf/split");
  await page.locator("input[type=file]").setInputFiles({
    name: "report.pdf",
    mimeType: "application/pdf",
    buffer: await createPdf([100, 200, 300]),
  });

  const setup = page.getByRole("region", { name: "PDF 나누기 설정" });
  await expect(setup.getByText("report.pdf", { exact: true })).toBeVisible();
  await expect(setup.getByText("3페이지", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "PDF 페이지별로 나누기" })).toBeEnabled();

  await setup.getByRole("radio", { name: /페이지 추출/ }).check();
  const range = setup.getByLabel("페이지 범위");
  await expect(range).toHaveValue("");
  await expect(range).toHaveAttribute("placeholder", "예: 1-3, 5");
  await range.fill("4");
  await expect(setup.getByText("이 PDF는 3페이지까지 있어요.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "선택 페이지 추출하기" })).toBeDisabled();
});
```

- [ ] **Step 2: Run the new test and confirm the old workbench fails it**

Run:

```bash
pnpm exec playwright test tests/e2e/pdf-tools.spec.ts --project=chromium --grep "inspects a split PDF"
```

Expected: FAIL because `PDF 나누기 설정`, the inspected `3페이지`, the empty range, and the arrow-free run labels do not exist together yet.

- [ ] **Step 3: Derive split inspection and bounded range state**

In `apps/web/src/components/pdf-workbench.tsx`, replace the initial range and parser declarations with:

```ts
const [splitMode, setSplitMode] = useState<"every-page" | "extract">("every-page");
const [pageRange, setPageRange] = useState("");

const splitItem = intent === "split" ? items[0] : undefined;
const splitPageCount =
  splitItem?.inspection?.status === "ready" ? splitItem.inspection.pageCount : undefined;
const parsedPageRange = useMemo(
  () => parsePageSelection(pageRange, splitPageCount),
  [pageRange, splitPageCount],
);
```

Change the PDF inspection effect guard from merge-only to merge-or-split and keep each outcome on the `PdfWorkItem`:

```ts
useEffect(() => {
  if ((intent !== "merge" && intent !== "split") || processing) return;
  const pending = items.find((item) => item.inspection?.status === "pending");
  if (pending === undefined) return;

  let active = true;
  const handle = inspectPdfFile(pending.file);
  if (intent === "split") {
    inspectionHandleRef.current = handle;
    setInspecting(true);
    setMessage("PDF 페이지를 기기 안에서 확인하고 있어요.");
  }

  void handle.result
    .then((outcome) => {
      if (!active) return;
      setItems((current) => {
        const next = current.map((item): PdfWorkItem => {
          if (item.id !== pending.id || item.inspection?.status !== "pending") return item;
          if (outcome.status === "fulfilled") {
            return {
              ...item,
              inspection: { status: "ready", pageCount: outcome.value.pageCount },
            };
          }
          return {
            ...item,
            inspection: {
              status: "failed",
              message:
                outcome.status === "rejected"
                  ? outcome.error.message
                  : "페이지 확인을 중단했어요.",
            },
          };
        });
        itemsRef.current = next;
        return next;
      });

      if (intent !== "split") return;
      if (outcome.status === "fulfilled") {
        setMessage(`${outcome.value.pageCount}페이지 PDF를 준비했어요.`);
      } else if (outcome.status === "rejected") {
        setMessage(outcome.error.message);
      } else {
        setMessage("페이지 확인을 중단했어요.");
      }
    })
    .finally(() => {
      if (!active || intent !== "split") return;
      if (inspectionHandleRef.current === handle) inspectionHandleRef.current = undefined;
      setInspecting(false);
    });

  return () => {
    active = false;
    handle.cancel();
  };
}, [intent, items, processing]);
```

When accepting files, initialize inspection for both merge and split:

```ts
const item = { id: makeId(), file };
accepted.push(
  intent === "merge" || intent === "split"
    ? { ...item, inspection: { status: "pending" } }
    : item,
);
```

Reset split-specific input in `reset()`:

```ts
setSplitMode("every-page");
setPageRange("");
```

Require a ready split inspection in `canRun`:

```ts
(intent !== "split" ||
  (splitItem?.inspection?.status === "ready" &&
    (splitMode === "every-page" || parsedPageRange.ok)))
```

- [ ] **Step 4: Render the split inspection and setup stages before the shared workbench**

Insert split branches after the merge branches and before `items.length === 0`. Use the existing merge card primitives and only add split-specific classes for the mode controls:

```tsx
) : intent === "split" &&
  (inspecting || splitItem?.inspection?.status === "pending") ? (
  <section className={`${styles.mergeStage} ${styles.mergeProgress}`}>
    <h2 id="pdf-workbench-title">페이지 확인 중</h2>
    <p>{message}</p>
    <button className={styles.mergeSecondaryAction} type="button" onClick={cancelInspection}>
      중단
    </button>
  </section>
) : intent === "split" && result === undefined && !processing && splitItem !== undefined ? (
  <section
    className={`${styles.mergeSetup} ${styles.splitSetup}`}
    aria-labelledby="pdf-workbench-title"
    aria-label="PDF 나누기 설정"
  >
    <header className={styles.mergeSetupHeader}>
      <div>
        <h2 id="pdf-workbench-title">나눌 방식</h2>
        <p>{splitItem.file.name}</p>
      </div>
      <div className={styles.mergeHeaderActions}>
        <button type="button" onClick={() => inputRef.current?.click()}>PDF 교체</button>
      </div>
    </header>

    <div className={styles.splitFileSummary}>
      <strong>{splitItem.file.name}</strong>
      <span>{formatBytes(splitItem.file.size)}</span>
      <span>
        {splitItem.inspection?.status === "ready"
          ? `${splitItem.inspection.pageCount}페이지`
          : splitItem.inspection?.status === "failed"
            ? splitItem.inspection.message
            : "페이지 확인 중"}
      </span>
    </div>

    <fieldset className={styles.splitOptions}>
      <legend>나눌 방식</legend>
      <label>
        <input
          type="radio"
          name="split-mode"
          checked={splitMode === "every-page"}
          onChange={() => changeSplitMode("every-page")}
        />
        <span><strong>페이지별 분리</strong><small>각 페이지를 PDF로 만들고 ZIP으로 저장</small></span>
      </label>
      <label>
        <input
          type="radio"
          name="split-mode"
          checked={splitMode === "extract"}
          onChange={() => changeSplitMode("extract")}
        />
        <span><strong>페이지 추출</strong><small>필요한 페이지만 한 PDF로 저장</small></span>
      </label>
      {splitMode === "extract" ? (
        <div className={styles.splitRangeField}>
          <label htmlFor="pdf-page-range">페이지 범위</label>
          <input
            id="pdf-page-range"
            type="text"
            value={pageRange}
            placeholder="예: 1-3, 5"
            aria-invalid={!parsedPageRange.ok}
            aria-describedby="pdf-page-range-help"
            onChange={(event) => {
              setPageRange(event.target.value);
              clearResult();
            }}
          />
          <small id="pdf-page-range-help">
            {parsedPageRange.ok
              ? `${parsedPageRange.pages.length}페이지를 선택했어요.`
              : parsedPageRange.message}
          </small>
        </div>
      ) : null}
    </fieldset>

    <footer className={styles.mergeSetupFooter}>
      <p className={styles.mergeLocalNotice}>파일은 업로드하지 않고 이 기기에서 처리해요.</p>
      <p className={styles.mergeStatus} role="status" aria-live="polite" aria-atomic="true">
        {message}
      </p>
      <button
        className={styles.mergePrimaryAction}
        type="button"
        disabled={!canRun}
        onClick={() => void startProcessing()}
      >
        {splitMode === "every-page" ? "PDF 페이지별로 나누기" : "선택 페이지 추출하기"}
      </button>
    </footer>
  </section>
```

Keep the existing empty dropzone as the split `select` screen. A failed split inspection remains in setup with its error, a disabled run button, and `PDF 교체`.

- [ ] **Step 5: Add only the split setup styles that the reused primitives do not provide**

Add near the existing merge setup rules in `pdf-workbench.module.css`:

```css
.splitFileSummary {
  padding: 16px 28px;
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px 14px;
  border-bottom: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.56);
}

.splitFileSummary strong {
  min-width: 0;
  flex: 1 1 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.splitFileSummary span {
  color: var(--muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.splitOptions {
  margin: 0;
  padding: 24px 28px 0;
  display: grid;
  gap: 10px;
  border: 0;
}

.splitOptions legend {
  padding: 0;
  font-size: 13px;
  font-weight: 850;
}

.splitOptions > label {
  min-height: 72px;
  padding: 14px 16px;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  border: 1px solid var(--line);
  border-radius: 11px;
  background: white;
  cursor: pointer;
}

.splitOptions > label:has(input:checked) {
  border-color: var(--ink);
  box-shadow: inset 0 0 0 1px var(--ink);
}

.splitOptions input[type="radio"] {
  width: 20px;
  height: 20px;
  margin: 1px 0 0;
  accent-color: var(--ink);
}

.splitOptions label span {
  display: grid;
  gap: 4px;
}

.splitOptions small,
.splitRangeField small {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
}

.splitRangeField {
  padding-top: 8px;
  display: grid;
  gap: 7px;
}

.splitRangeField > label {
  font-size: 13px;
  font-weight: 800;
}

.splitRangeField input {
  min-height: 48px;
  padding: 0 14px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: white;
  color: var(--ink);
  font: inherit;
  font-size: 16px;
}

.splitRangeField input[aria-invalid="true"] {
  border-color: var(--red);
}

```

- [ ] **Step 6: Run focused setup tests and static checks**

Run:

```bash
pnpm exec playwright test tests/e2e/pdf-tools.spec.ts --project=chromium --grep "inspects a split PDF|extracts a validated page range"
pnpm exec vitest run packages/pdf-tool/src/page-ranges.test.ts --maxWorkers=1
pnpm exec biome check apps/web/src/components/pdf-workbench.tsx apps/web/src/components/pdf-workbench.module.css tests/e2e/pdf-tools.spec.ts
pnpm --filter @hereisit/web typecheck
```

Expected: all commands PASS. The pure parser suite continues to prove the exact maximum-page message.

- [ ] **Step 7: Commit the inspected setup flow**

```bash
git add apps/web/src/components/pdf-workbench.tsx apps/web/src/components/pdf-workbench.module.css tests/e2e/pdf-tools.spec.ts
git commit -m "Simplify PDF split setup"
```

---

### Task 2: Replace shared processing and result panels with direct split stages

**Files:**
- Modify: `tests/e2e/pdf-tools.spec.ts:131-224`
- Modify: `apps/web/src/components/pdf-workbench.tsx:532-622,673-875`
- Modify: `apps/web/src/components/pdf-workbench.module.css:1240-1365`

**Interfaces:**
- Consumes: existing `PdfPipelineResult` fields `sourcePageCount`, `outputPageCount`, `outputDocumentCount`, `byteLength`, `mime`, `suggestedName`, and `warnings`.
- Produces: split-only `processing` and `result` screens; explicit `ZIP 다운로드 ↓` or `PDF 다운로드 ↓`; unchanged object-URL cleanup and download activation retry.

- [ ] **Step 1: Update split E2E expectations to the approved result contract**

In `splits every PDF page into a ZIP`, change the run and result assertions to:

```ts
await page.getByRole("button", { name: "PDF 페이지별로 나누기" }).click();
await expect(page.getByRole("heading", { name: "나누기 완료" })).toBeVisible({
  timeout: 20_000,
});
const result = page.getByRole("region", { name: "PDF 나누기 결과" });
await expect(result.getByText("3페이지 → PDF 3개", { exact: true })).toBeVisible();
await expect(result.getByText(/\d+(?:\.\d+)?(?:KB|B) → \d+(?:\.\d+)?(?:KB|B)/)).toBeVisible();
await expect(page.getByLabel("PDF 설정")).toHaveCount(0);
expect(downloadCount).toBe(0);
```

Keep the existing ZIP filename, entries, page width, explicit-download count, and Web Share assertions. After download, add:

```ts
await page.getByRole("button", { name: "다른 PDF 나누기" }).click();
await expect(page.getByRole("button", { name: "PDF 선택" })).toBeVisible();
```

In `downloads a one-page split result as a ZIP`, use the arrow-free run label and assert:

```ts
await expect(page.getByText("1페이지 → PDF 1개", { exact: true })).toBeVisible({
  timeout: 20_000,
});
```

In `extracts a validated page range into one PDF`, use the arrow-free run label and assert:

```ts
await expect(page.getByRole("heading", { name: "추출 완료" })).toBeVisible({
  timeout: 20_000,
});
await expect(page.getByText("3페이지 → 2페이지", { exact: true })).toBeVisible();
```

- [ ] **Step 2: Run the result tests and confirm they fail on the shared panel**

Run:

```bash
pnpm exec playwright test tests/e2e/pdf-tools.spec.ts --project=chromium --grep "splits every|one-page split|extracts a validated"
```

Expected: FAIL because the dedicated headings, result region, summary copy, and reset label do not exist yet.

- [ ] **Step 3: Render split processing before split setup**

Insert this branch before the Task 1 split setup branch:

```tsx
) : intent === "split" && processing ? (
  <section className={`${styles.mergeStage} ${styles.mergeProgress}`}>
    <h2 id="pdf-workbench-title">
      {splitMode === "every-page" ? "PDF 나누는 중" : "페이지 추출 중"}
    </h2>
    <p>{phaseLabel(phase)}</p>
    <div
      className={styles.mergeProgressTrack}
      role="progressbar"
      aria-label="PDF 나누기 진행률"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(progress * 100)}
    >
      <span style={{ width: `${Math.round(progress * 100)}%` }} />
    </div>
    <button className={styles.mergeSecondaryAction} type="button" onClick={cancelProcessing}>
      중단
    </button>
  </section>
```

The branch must replace the setup and shared three-column panel while `processing` is true.

- [ ] **Step 4: Render the split result before processing and setup**

Insert this branch before the split processing branch:

```tsx
) : intent === "split" && result !== undefined ? (
  <section
    className={`${styles.mergeStage} ${styles.mergeResult}`}
    aria-labelledby="pdf-workbench-title"
    aria-label="PDF 나누기 결과"
  >
    <div className={styles.mergeResultMark} aria-hidden="true">✓</div>
    <h2 id="pdf-workbench-title">
      {result.mime === "application/zip" ? "나누기 완료" : "추출 완료"}
    </h2>
    <p className={styles.mergeResultSummary}>
      {result.mime === "application/zip"
        ? `${result.sourcePageCount}페이지 → PDF ${result.outputDocumentCount}개`
        : `${result.sourcePageCount}페이지 → ${result.outputPageCount}페이지`}
    </p>
    <strong className={styles.mergeSizeComparison}>
      {formatBytes(totalBytes)} → {formatBytes(result.byteLength)}
    </strong>
    {result.warnings.includes("SIGNATURES_INVALIDATED") ? (
      <p className={styles.mergeWarning}>
        새 PDF에서는 기존 전자서명이 유효하지 않아요. 북마크·양식은 유지되지 않을 수 있어요.
      </p>
    ) : null}
    <button className={styles.mergePrimaryAction} type="button" onClick={downloadResult}>
      {result.mime === "application/zip" ? "ZIP 다운로드 ↓" : "PDF 다운로드 ↓"}
    </button>
    <p className={styles.mergeResultStatus} role="status" aria-live="polite" aria-atomic="true">
      {message}
    </p>
    <button className={styles.mergeTextAction} type="button" onClick={reset}>
      다른 PDF 나누기
    </button>
  </section>
```

Do not add automatic clicks, anchor target changes, or `navigator.share`. Keep `downloadResult()` and result URL lifetime unchanged.

- [ ] **Step 5: Run the complete desktop PDF split group**

Run:

```bash
pnpm exec playwright test tests/e2e/pdf-tools.spec.ts --project=chromium --grep "split PDF|splits every|one-page split|extracts a validated"
pnpm exec biome check apps/web/src/components/pdf-workbench.tsx apps/web/src/components/pdf-workbench.module.css tests/e2e/pdf-tools.spec.ts
pnpm --filter @hereisit/web typecheck
```

Expected: all commands PASS; the existing downloaded ZIP/PDF byte assertions remain unchanged.

- [ ] **Step 6: Commit the processing and result stages**

```bash
git add apps/web/src/components/pdf-workbench.tsx apps/web/src/components/pdf-workbench.module.css tests/e2e/pdf-tools.spec.ts
git commit -m "Focus PDF split result flow"
```

---

### Task 3: Lock down failure recovery, mobile ergonomics, and full regression safety

**Files:**
- Modify: `tests/e2e/pdf-tools.spec.ts:90-120,131-224`
- Modify: `tests/e2e/mobile.spec.ts:709-771`
- Modify: `apps/web/src/components/pdf-workbench.module.css:1365-end`
- Modify: `apps/web/src/components/pdf-workbench.tsx:187-207,603-622,673-875`

**Interfaces:**
- Consumes: `installDownloadActivationController`, `setDownloadActivationBlocked`, the split result stage from Task 2, and the existing Playwright mobile helpers.
- Produces: retryable split downloads, a recoverable failed-inspection setup, and a touch-safe staged layout from 320px through desktop.

- [ ] **Step 1: Add split-specific download retry coverage**

Add this test after the existing merge download retry test in `tests/e2e/pdf-tools.spec.ts`:

```ts
test("keeps a split result retryable when download activation fails", async ({ page }) => {
  await installDownloadActivationController(page);
  await page.goto("/pdf/split");
  await page.locator("input[type=file]").setInputFiles({
    name: "retry.pdf",
    mimeType: "application/pdf",
    buffer: await createPdf([100, 200]),
  });
  const run = page.getByRole("button", { name: "PDF 페이지별로 나누기" });
  await expect(run).toBeEnabled({ timeout: 20_000 });
  await run.click();
  await expect(page.getByRole("heading", { name: "나누기 완료" })).toBeVisible({
    timeout: 20_000,
  });

  await setDownloadActivationBlocked(page, true);
  await page.getByRole("button", { name: "ZIP 다운로드 ↓" }).click();
  await expect(page.getByRole("status")).toContainText(
    "다운로드를 시작하지 못했어요. 다시 시도해 주세요.",
  );
  await expect(page.getByRole("heading", { name: "나누기 완료" })).toBeVisible();

  await setDownloadActivationBlocked(page, false);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "ZIP 다운로드 ↓" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("retry-pages-hereisit.zip");
});
```

- [ ] **Step 2: Replace the old three-column mobile split test with staged assertions**

In `tests/e2e/mobile.spec.ts`, keep the existing two-page `pdf` fixture and replace the rest of the test body beginning at `await page.goto("/pdf/split")` with:

```ts
await holdTerminalWorkerEvents(page);
await page.goto("/pdf/split");
await page.locator("input[type=file]").setInputFiles({
  name: "sample.pdf",
  mimeType: "application/pdf",
  buffer: pdf,
});

const setup = page.getByRole("region", { name: "PDF 나누기 설정" });
await expect(setup.getByText("sample.pdf", { exact: true })).toBeVisible();
await expect(setup.getByText("2페이지", { exact: true })).toBeVisible({ timeout: 20_000 });
await expect(setup.getByRole("heading", { name: "나눌 방식" })).toBeFocused();
await setup.getByRole("radio", { name: /페이지 추출/ }).check();

const range = setup.getByLabel("페이지 범위");
await range.fill("1");
expect(
  await range.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
).toBeGreaterThanOrEqual(16);

const replace = page.getByRole("button", { name: "PDF 교체" });
const run = page.getByRole("button", { name: "선택 페이지 추출하기" });
for (const control of [replace, run]) {
  const box = await control.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
}

await expectFunctionalTextFloor([
  { label: "PDF option legend", locator: setup.getByText("나눌 방식", { exact: true }).first() },
  { label: "PDF option label", locator: setup.getByText("페이지 추출", { exact: true }) },
  { label: "PDF range control label", locator: setup.getByText("페이지 범위", { exact: true }) },
  { label: "PDF range control help", locator: range.locator("..").locator("small") },
]);

const layout = await page.evaluate(() => ({
  clientWidth: document.documentElement.clientWidth,
  scrollWidth: document.documentElement.scrollWidth,
}));
expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);

await run.click();
const processingHeading = page.getByRole("heading", { name: "페이지 추출 중" });
await expect(processingHeading).toBeFocused();
const cancel = page.getByRole("button", { name: "중단" });
const cancelBox = await cancel.boundingBox();
expect(cancelBox?.width ?? 0).toBeGreaterThanOrEqual(44);
expect(cancelBox?.height ?? 0).toBeGreaterThanOrEqual(44);
await cancel.click();
await expect(setup).toBeVisible();
await expect(page.getByRole("status")).toContainText("PDF 작업을 중단했어요.");
```

Rename the test to `keeps the staged PDF split flow touch-safe`.

- [ ] **Step 3: Run the new retry and mobile tests before responsive fixes**

Run:

```bash
pnpm exec playwright test tests/e2e/pdf-tools.spec.ts --project=chromium --grep "split result retryable"
pnpm exec playwright test tests/e2e/mobile.spec.ts --project=mobile-chromium --grep "staged PDF split"
```

Expected: the retry test PASS establishes the preserved download invariant. The mobile test FAILS on the missing stage-heading focus and exposes any undersized or overflowing split control before the accessibility and responsive steps.

- [ ] **Step 4: Move keyboard focus to each newly rendered split stage**

In `pdf-workbench.tsx`, derive the current split stage and create one heading ref:

```ts
const splitScreen =
  intent !== "split"
    ? undefined
    : result !== undefined
      ? "result"
      : processing
        ? "processing"
        : inspecting || splitItem?.inspection?.status === "pending"
          ? "inspecting"
          : splitItem !== undefined
            ? "setup"
            : "select";
const splitStageHeadingRef = useRef<HTMLHeadingElement>(null);

useEffect(() => {
  if (splitScreen === undefined || splitScreen === "select") return;
  splitStageHeadingRef.current?.focus();
}, [splitScreen]);
```

Attach the ref and `tabIndex={-1}` to the `h2` in each split-only inspecting, setup, processing, and result branch:

```tsx
<h2 id="pdf-workbench-title" ref={splitStageHeadingRef} tabIndex={-1}>
  나눌 방식
</h2>
```

Use the branch's existing heading text for the other three stages. Do not focus status paragraphs or move focus again when only progress changes.

- [ ] **Step 5: Add narrow-screen rules for the focused split card**

Inside the existing narrow-screen media query in `pdf-workbench.module.css`, add:

```css
.splitSetup .mergeSetupHeader {
  padding: 20px;
  align-items: stretch;
  flex-direction: column;
  gap: 14px;
}

.splitSetup .mergeHeaderActions button {
  width: 100%;
}

.splitFileSummary,
.splitOptions,
.splitSetup .mergeSetupFooter {
  padding-right: 20px;
  padding-left: 20px;
}

.splitOptions > label {
  min-height: 76px;
}

.splitSetup,
.mergeStage {
  box-shadow: 6px 6px 0 var(--yellow);
}
```

At 320px, ensure existing `.mergeStage` padding resolves to no more than `32px 20px`. Do not introduce horizontal scrolling or fixed pixel widths for the card.

- [ ] **Step 6: Verify failed inspection remains recoverable**

Add this desktop test next to the split setup test:

```ts
test("keeps a failed split inspection replaceable", async ({ page }) => {
  await page.goto("/pdf/split");
  await page.locator("input[type=file]").setInputFiles({
    name: "broken.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("not a pdf"),
  });

  const setup = page.getByRole("region", { name: "PDF 나누기 설정" });
  await expect(setup.getByText(/확인할 수 없|다시 시도/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "PDF 페이지별로 나누기" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "PDF 교체" })).toBeEnabled();
});
```

- [ ] **Step 7: Run focused desktop, mobile, unit, lint, type, and build verification**

Run:

```bash
pnpm exec vitest run packages/pdf-tool/src/page-ranges.test.ts --maxWorkers=1
pnpm exec playwright test tests/e2e/pdf-tools.spec.ts --project=chromium --grep "split PDF|splits every|one-page split|extracts a validated|split result retryable|failed split inspection"
pnpm exec playwright test tests/e2e/mobile.spec.ts --project=mobile-chromium --grep "staged PDF split"
pnpm lint
pnpm typecheck
pnpm --filter @hereisit/web build
```

Expected: all commands PASS. The web build must still emit `/pdf/split` as a static route.

- [ ] **Step 8: Run the repository-wide release gate**

Run:

```bash
pnpm verify:all
```

Expected: lint, types, 2,000+ unit tests, Worker integration, image-engine fuzzing, production builds, export checks, processing-stack tests, and all Playwright browser projects PASS. Do not weaken or skip a gate to make this change green.

- [ ] **Step 9: Commit the recovery and responsive coverage**

```bash
git add apps/web/src/components/pdf-workbench.tsx apps/web/src/components/pdf-workbench.module.css tests/e2e/pdf-tools.spec.ts tests/e2e/mobile.spec.ts
git commit -m "Verify PDF split mobile flow"
```

## Completion Check

- [ ] `git diff --check` passes.
- [ ] `git status --short` contains no unintended files.
- [ ] The split selection, inspection, setup, processing, result, reset, and retry stages each expose one primary action.
- [ ] Existing ZIP/PDF byte-level outcome assertions remain intact.
- [ ] No new dependency, API route, upload, share action, or automatic download was introduced.
- [ ] The implementation matches `docs/superpowers/specs/2026-08-04-pdf-split-workbench-simplification-design.md` without adding unrelated PDF refactors.

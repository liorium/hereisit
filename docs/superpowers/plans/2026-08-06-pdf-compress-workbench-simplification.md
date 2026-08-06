# PDF Compression Workbench Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the three-column scanned-PDF compression workbench with one focused select, inspect, setup, process, or result screen at a time.

**Architecture:** Keep `PdfCompressWorkbench` as the owner of its existing file, Worker, result URL, cancellation, and analytics state. Derive the visible stage from that state and reuse the merge/split single-stage CSS primitives; change no codec, contract, Worker, filename, privacy, or download behavior.

**Tech Stack:** Next.js 16, React 19, TypeScript, CSS Modules, Playwright, pnpm

## Global Constraints

- Files stay in the browser and must never be logged or sent over the network.
- Keep `pdf.compress-scanned@1`, `runPdfCompressScannedJob`, both existing presets, the 1% savings gate, and explicit download unchanged.
- Add no dependency and no new state-management abstraction.
- Use plain Korean copy, one primary action per stage, 44px minimum actions, and a 320px-wide single-column layout.
- Browser PDF output is not byte-stable; assert MIME signature, pages, dimensions, warnings, savings tolerance, and behavior.

---

### Task 1: Render one compression stage at a time

**Files:**
- Modify: `tests/e2e/pdf-compression.spec.ts:509-723`
- Modify: `apps/web/src/components/pdf-compress-workbench.tsx:14-609`
- Modify: `apps/web/src/components/pdf-workbench.module.css:881-1059,1060-1425,1670-1770`

**Interfaces:**
- Consumes: existing `inspectPdfFile(file)`, `runPdfCompressScannedJob(file, spec, options)`, `invalidateActiveWork()`, `downloadUrl(url, name)`, and product-analytics hooks.
- Produces: the unchanged `PdfCompressWorkbench({ toolId }: { toolId: AvailableToolId })` component with derived stage `"select" | "inspecting" | "setup" | "processing" | "result"`.

- [ ] **Step 1: Replace the three-panel shell expectation with stage expectations**

Update the initial-shell test so settings and result UI do not exist before a file is ready:

```ts
test("shows only the file-selection step before a PDF is ready", async ({ page }) => {
  await openReadyPdfCompression(page);
  await expect(page.getByRole("heading", { level: 2, name: "스캔 PDF 용량 줄이기" })).toBeVisible();
  await expect(page.getByRole("button", { name: "PDF 선택" })).toBeEnabled();
  await expect(page.getByRole("radio")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "PDF 압축 결과" })).toHaveCount(0);
  await expect(page.getByText("파일은 이 기기에서만 처리돼요.")).toBeVisible();
});
```

Extend the successful compression test to assert the setup and result stages:

```ts
await uploadPdf(page, `${privacySentinel}.pdf`, source, 2);
await expect(page.getByRole("region", { name: "PDF 압축 설정" })).toBeVisible();
await expect(page.getByRole("radio", { name: /균형 150DPI/ })).toBeChecked();
await expect(page.getByText(DESTRUCTIVE_WARNING, { exact: true })).toHaveCount(1);
await page.getByRole("button", { name: "2페이지 용량 줄이기" }).click();
await expect(page.getByRole("heading", { level: 2, name: "용량 줄이기 완료" })).toBeVisible({
  timeout: 60_000,
});
await expect(page.getByText(/^\d+(?:\.\d+)?(?:B|KB|MB) → \d+(?:\.\d+)?(?:B|KB|MB)$/)).toBeVisible();
await expect(page.getByText(/^\d+% 줄었어요$/)).toBeVisible();
await expect(page.getByRole("button", { name: "PDF 다운로드 ↓" })).toBeVisible();
await expect(page.getByRole("button", { name: "다른 PDF 압축" })).toBeVisible();
await expect(page.getByText("처리 시간", { exact: true })).toHaveCount(0);
await expect(page.getByRole("button", { name: "같은 설정으로 다시 실행" })).toHaveCount(0);
```

- [ ] **Step 2: Run the focused tests and confirm the old shell fails the new contract**

Run:

```bash
pnpm exec playwright test tests/e2e/pdf-compression.spec.ts --project=chromium --grep "file-selection step|default preset"
```

Expected: FAIL because the old page exposes both radios and all three panels before selection, and uses the old completion copy.

- [ ] **Step 3: Derive the stage and focus its heading**

In `PdfCompressWorkbench`, remove the unused `formatDuration` import and derive the stage without adding stored state:

```ts
type CompressionStage = "select" | "inspecting" | "setup" | "processing" | "result";

const stage: CompressionStage =
  result !== undefined
    ? "result"
    : processing
      ? "processing"
      : inspecting
        ? "inspecting"
        : inspection !== undefined
          ? "setup"
          : "select";
```

Add one `stageHeadingRef` and focus it when the stage changes after file selection:

```ts
const stageHeadingRef = useRef<HTMLHeadingElement>(null);

useEffect(() => {
  if (stage !== "select") stageHeadingRef.current?.focus();
}, [stage]);
```

- [ ] **Step 4: Replace the shared three-column render with five mutually exclusive renders**

Keep the hidden file input mounted. Render only one of these structures after it:

```tsx
{stage === "select" ? (
  <section className={`${styles.emptyDropzone} ${dragging ? styles.dragging : ""}`}>
    <h2 id="pdf-compress-workbench-title">스캔 PDF 용량 줄이기</h2>
    <p>PDF 1개 · 최대 50MB · 최대 100페이지</p>
    <button className={styles.mergePrimaryAction} type="button" onClick={() => inputRef.current?.click()}>
      PDF 선택
    </button>
    <p className={styles.mergeLocalNotice}>파일은 이 기기에서만 처리돼요.</p>
    <p role="status" aria-live="polite">{visibleMessage}</p>
  </section>
) : null}
```

The inspection and processing stages reuse `mergeStage`, `mergeProgress`, `mergeProgressTrack`, and `mergeSecondaryAction`. Both show the authoritative label, progress semantics, and one cancel button:

```tsx
<section className={`${styles.mergeStage} ${styles.mergeProgress}`}>
  <h2 ref={stageHeadingRef} tabIndex={-1} id="pdf-compress-workbench-title">
    {stage === "inspecting" ? "PDF 확인하는 중" : "PDF 용량 줄이는 중"}
  </h2>
  <p>{stage === "inspecting" ? "페이지 수를 확인하고 있어요." : progressLabel(progress)}</p>
  <div role="progressbar" aria-label="PDF 압축 진행률" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPercent} aria-valuetext={progressText}>
    <span style={{ width: `${progressPercent}%` }} />
  </div>
  <button type="button" className={styles.mergeSecondaryAction} onClick={stage === "inspecting" ? cancelInspection : cancelProcessing}>
    중단
  </button>
</section>
```

The setup stage reuses `mergeSetup`, `mergeSetupHeader`, `splitFileSummary`, `splitOptions`, `mergeSetupFooter`, and `mergePrimaryAction`. It displays one file summary, the two existing native radios, exactly one destructive warning, `PDF 교체`, and the button label `${inspection.pageCount}페이지 용량 줄이기`.

The result stage reuses `mergeStage`, `mergeResult`, `mergeSizeComparison`, `mergePrimaryAction`, and `mergeTextAction`:

```tsx
<section className={`${styles.mergeStage} ${styles.mergeResult}`} aria-label="PDF 압축 결과">
  <h2 ref={stageHeadingRef} tabIndex={-1} id="pdf-compress-workbench-title">용량 줄이기 완료</h2>
  <strong className={styles.mergeSizeComparison}>
    {formatBytes(result.sourceByteLength)} → {formatBytes(result.byteLength)}
  </strong>
  <p>{savings}% 줄었어요</p>
  <p>모든 페이지가 이미지로 변환된 PDF예요.</p>
  <button className={styles.mergePrimaryAction} type="button" onClick={downloadResult}>
    PDF 다운로드 ↓
  </button>
  <p role="status" aria-live="polite">{visibleMessage}</p>
  <button className={styles.mergeTextAction} type="button" onClick={reset}>다른 PDF 압축</button>
</section>
```

Use only one `role="status"` in each visible stage. Preserve drag/drop handlers, disabled states, result URL cleanup, analytics calls, and explicit download.

- [ ] **Step 5: Add only compression-specific layout rules that shared primitives cannot express**

Add narrow selectors for the setup warning, result savings copy, and 320px overflow protection:

```css
.compressionSetupWarning {
  margin: 20px 28px 0;
  padding: 12px 14px;
  border: 1px solid color-mix(in srgb, var(--red) 24%, var(--line));
  border-radius: 9px;
  background: color-mix(in srgb, var(--red) 7%, white);
  color: var(--red);
  font-size: 12px;
  line-height: 1.55;
}

.compressionSavings {
  margin-top: 10px;
  color: var(--green);
  font-weight: 850;
}

@media (max-width: 640px) {
  .compressionSetupWarning {
    margin-right: 20px;
    margin-left: 20px;
  }
}
```

Run this before deleting old compression-only selectors; delete only selectors with no remaining JSX reference. Do not disturb shared PDF workbench styles.

```bash
rg -n "compressionPicker|compressionSettings|compressionResultDetails|compressionResultWarning|savingsSummary" apps/web/src
```

- [ ] **Step 6: Run the focused success and shell tests**

Run:

```bash
pnpm exec playwright test tests/e2e/pdf-compression.spec.ts --project=chromium --grep "file-selection step|default preset"
```

Expected: both tests PASS; no automatic download occurs.

- [ ] **Step 7: Commit the stage flow**

```bash
git add apps/web/src/components/pdf-compress-workbench.tsx apps/web/src/components/pdf-workbench.module.css tests/e2e/pdf-compression.spec.ts
git commit -m "refactor: simplify PDF compression flow"
```

### Task 2: Preserve recovery, privacy, cleanup, and mobile behavior

**Files:**
- Modify: `tests/e2e/pdf-compression.spec.ts:724-1045`
- Modify only if a regression requires it: `apps/web/src/components/pdf-compress-workbench.tsx`
- Modify only if a layout regression requires it: `apps/web/src/components/pdf-workbench.module.css`

**Interfaces:**
- Consumes: Task 1 stage labels and the existing test helpers `prepareCompressedResult`, `objectUrlCounts`, `installPrivacyObserver`, and `installDownloadActivationController`.
- Produces: complete stage-based E2E coverage without changing Worker or contract behavior.

- [ ] **Step 1: Update recovery tests to use visible stage actions**

Replace old result-panel and removed-action queries with the new contract:

```ts
await expect(page.getByRole("heading", { level: 2, name: "용량 줄이기 완료" })).toBeVisible();
await page.getByRole("button", { name: "다른 PDF 압축" }).click();
await expect(page.getByRole("button", { name: "PDF 선택" })).toBeVisible();
```

For the minimum-preset comparison, return through `다른 PDF 압축`, upload the source again, select `최소 용량 96DPI`, and execute. Do not restore `같은 설정으로 다시 실행` or expose settings behind the result.

- [ ] **Step 2: Keep errors in setup and make cancellation return there**

Assert that no-reduction and memory errors retain the selected file and radio controls, with no result/download:

```ts
await expect(page.getByRole("region", { name: "PDF 압축 설정" })).toBeVisible();
await expect(page.getByText(expectedMessage, { exact: true }).first()).toBeVisible();
await expect(page.getByRole("button", { name: "PDF 다운로드 ↓" })).toHaveCount(0);
```

After `중단`, assert the setup region and execute button return, while object URL and download counts remain zero.

- [ ] **Step 3: Rewrite cleanup coverage around supported result exits**

Keep object URL assertions for `다른 PDF 압축` and unmount. Remove the obsolete preset-change and same-settings-rerun branches because result settings no longer exist:

```ts
await prepareCompressedResult(page);
await expect.poll(() => objectUrlCounts(page)).toEqual({ created: 1, revoked: 0 });
await page.getByRole("button", { name: "다른 PDF 압축" }).click();
await expect.poll(() => objectUrlCounts(page)).toEqual({ created: 1, revoked: 1 });

await uploadPdf(page, "unmount.pdf", replacement, 1);
await page.getByRole("button", { name: "1페이지 용량 줄이기" }).click();
await expect(page.getByRole("heading", { name: "용량 줄이기 완료" })).toBeVisible();
// Navigate to /pdf/merge and expect the second URL to be revoked.
```

- [ ] **Step 4: Add one 320px stage-layout assertion**

Use a 320px viewport and assert no horizontal overflow plus minimum action heights in select, setup, and result:

```ts
await page.setViewportSize({ width: 320, height: 720 });
expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
for (const button of await page.getByRole("button").all()) {
  expect((await button.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
}
```

- [ ] **Step 5: Run the entire compression E2E file**

Run:

```bash
pnpm exec playwright test tests/e2e/pdf-compression.spec.ts --project=chromium
```

Expected: every compression test PASS, including privacy, failure, progress, cancellation, cleanup, and download retry.

- [ ] **Step 6: Run repository verification**

Run:

```bash
pnpm verify
pnpm verify:all
```

Expected: lint, types, unit tests, production builds, and the complete browser matrix PASS. Browser assertions continue to allow codec tolerances rather than byte equality.

- [ ] **Step 7: Commit final regressions only if Task 2 changed files**

```bash
git add apps/web/src/components/pdf-compress-workbench.tsx apps/web/src/components/pdf-workbench.module.css tests/e2e/pdf-compression.spec.ts
git commit -m "test: preserve PDF compression recovery"
```

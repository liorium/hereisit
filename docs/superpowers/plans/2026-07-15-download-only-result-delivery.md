# Download-Only Result Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove result sharing from every current HereIsIt image and PDF tool so each explicit result action requests exactly one direct browser download.

**Architecture:** Keep the existing tab-owned Blob URLs and `downloadUrl(url, filename)` primitive. Delete every result-delivery Web Share branch and its promise state, make already-produced result handlers synchronous, and retain asynchronous work only for image ZIP creation. Browser tests install available Web Share APIs as tripwires so a future share-first regression fails even on platforms that normally lack those APIs.

**Tech Stack:** TypeScript 6, React 19, Next.js 16 static export, Vitest, Playwright, fflate, pnpm 11.11.0, Node.js 24, Cloudflare Pages Git integration

## Global Constraints

- Files remain local to the browser tab; do not add an upload, server route, persistent storage, analytics payload, or external request.
- Processing completion never downloads automatically. Only an explicit result or ZIP action may start a download.
- Ordinary success copy is exactly `다운로드를 시작했어요.`; archive success copy is exactly `ZIP 다운로드를 시작했어요.`.
- Download failure copy is exactly `다운로드를 시작하지 못했어요. 다시 시도해 주세요.` and the result remains retryable.
- Result-delivery production code must not reference `navigator.share`, `navigator.canShare`, `ShareData`, or share-sheet cancellation.
- Keep every output byte, suggested filename, MIME, dimension, PDF page, ZIP entry, processing limit, and versioned tool contract unchanged.
- Preserve run/generation invalidation, cancellation, object-URL ownership, bounded-memory limits, and privacy observers.
- Every visible result action is at least 44×44 CSS pixels and causes no horizontal overflow from 320px through 1280px.
- Do not add a dependency, database, account, payment flow, environment variable, or Cloudflare setting.
- Never log file contents, selected filenames, thumbnails, object URLs, or presigned URLs.

## File Structure

### Create

- `tests/e2e/support/result-download.ts` — installs Web Share tripwires, reads aggregate call counts, and controls deterministic download-activation failures without recording file data.
- `tests/result-download-policy.test.ts` — permanently rejects Web Share code and share-oriented result copy in the five workbench sources.
- `scripts/support/result-download.mjs` — shares the release-smoke Web Share tripwire and zero-call assertion without recording file data.

### Modify

- `apps/web/src/lib/files.ts` — keep the direct-download primitive, guarantee temporary-anchor cleanup, and remove the obsolete share-cancellation helper after all callers migrate.
- `apps/web/src/lib/files.test.ts` — verify the anchor contract and exception cleanup; remove obsolete abort-helper assertions.
- `apps/web/src/components/image-workbench.tsx` — direct individual downloads and generation-safe on-demand ZIP downloads.
- `apps/web/src/components/image-watermark-workbench.tsx` — direct selected/single downloads while preserving existing generation and ZIP lease protections.
- `apps/web/src/components/image-workbench.module.css` — enforce 44px desktop targets for shared image result actions.
- `apps/web/src/components/pdf-workbench.tsx` — direct PDF/already-produced ZIP downloads and remove the share-only Blob reference.
- `apps/web/src/components/pdf-compress-workbench.tsx` — direct compressed-PDF downloads and remove share-promise state.
- `apps/web/src/components/pdf-to-image-workbench.tsx` — direct image/already-produced ZIP downloads and remove share-promise state.
- `tests/e2e/image-workbench.spec.ts` — direct individual/batch/error/stale-archive policy.
- `tests/e2e/image-watermark.spec.ts` — direct single/selected/batch/error policy and updated archive lifecycle copy.
- `tests/e2e/pdf-tools.spec.ts` — direct general PDF and ZIP policy.
- `tests/e2e/pdf-compression.spec.ts` — direct compressed-PDF policy and removal of obsolete pending-share cases.
- `tests/e2e/pdf-to-images.spec.ts` — direct image/ZIP policy and removal of obsolete pending-share cases.
- `tests/e2e/mobile.spec.ts` — new labels plus 44px/sticky/overflow result geometry.
- `tests/e2e/tool-detail-shells.spec.ts` — new general-PDF result label.
- `scripts/smoke-image-watermark.mjs` — production-like direct PNG download with Web Share tripwire.
- `scripts/smoke-pdf-compress.mjs` — production-like direct PDF downloads with Web Share tripwire.
- `scripts/smoke-pdf-to-images.mjs` — production-like direct PNG/ZIP downloads with Web Share tripwire.
- `apps/web/src/components/tool-detail-page.tsx` — replace ambiguous save copy with explicit download copy.
- `docs/architecture.md` — record the download-only result-delivery boundary.
- `docs/deployment.md` — describe explicit downloads and updated smoke expectations.
- `docs/testing/discovery-accessibility-checklist.md` — name download actions rather than save/export actions.
- `docs/superpowers/specs/2026-07-15-direct-download-default-design.md` — mark the approved design status.

No CSS module other than `image-workbench.module.css`, processing package, Worker, contract, registry record, route, dependency manifest, or deployment configuration should change.

---

### Task 1: Make the shared direct-download primitive exception-safe

**Files:**

- Modify: `apps/web/src/lib/files.ts:25-37`
- Modify: `apps/web/src/lib/files.test.ts:1-39`

**Interfaces:**

- Consumes: DOM `document.createElement("a")`, `document.body.append()`, and `HTMLAnchorElement.click()`.
- Produces: unchanged `downloadUrl(url: string, filename: string): void`; it always removes its temporary anchor and rethrows activation failures.

- [ ] **Step 1: Add failing unit tests for the anchor contract and exception cleanup**

Keep the existing ZIP and metric tests. Add `afterEach`/`vi`, a small document fixture, and these tests:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { createZipArchive, downloadUrl, formatDuration, formatSavings, isAbortError } from "./files";

afterEach(() => {
  vi.unstubAllGlobals();
});

function installDownloadDocument(click: () => void = vi.fn()) {
  const anchor = {
    download: "",
    href: "",
    rel: "",
    click: vi.fn(click),
    remove: vi.fn(),
  };
  const append = vi.fn();
  vi.stubGlobal("document", {
    body: { append },
    createElement: vi.fn(() => anchor),
  });
  return { anchor, append };
}

describe("downloadUrl", () => {
  it("activates one named download and removes its temporary anchor", () => {
    const { anchor, append } = installDownloadDocument();

    downloadUrl("blob:result", "result.pdf");

    expect(anchor).toMatchObject({
      href: "blob:result",
      download: "result.pdf",
      rel: "noopener",
    });
    expect(append).toHaveBeenCalledOnce();
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(anchor.remove).toHaveBeenCalledOnce();
  });

  it("removes the anchor and rethrows when activation fails", () => {
    const failure = new Error("download activation failed");
    const { anchor } = installDownloadDocument(() => {
      throw failure;
    });

    expect(() => downloadUrl("blob:result", "result.pdf")).toThrow(failure);
    expect(anchor.remove).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run the focused unit test and verify RED**

Run:

```bash
pnpm exec vitest run apps/web/src/lib/files.test.ts
```

Expected: the activation-failure test fails because the current `anchor.remove()` is skipped when `click()` throws.

- [ ] **Step 3: Make temporary-anchor cleanup unconditional**

Replace only `downloadUrl()` with:

```ts
export function downloadUrl(url: string, filename: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
  }
}
```

Do not remove `isAbortError` yet; the five workbenches still import it until Tasks 2–6 complete.

- [ ] **Step 4: Run the focused unit test and verify GREEN**

Run:

```bash
pnpm exec vitest run apps/web/src/lib/files.test.ts
```

Expected: all `files.test.ts` cases pass, including both new `downloadUrl()` cases.

- [ ] **Step 5: Commit the primitive**

```bash
git add apps/web/src/lib/files.ts apps/web/src/lib/files.test.ts
git commit -m "fix: clean up direct download anchors"
```

### Task 2: Make general image results download-only

**Files:**

- Create: `tests/e2e/support/result-download.ts`
- Modify: `tests/e2e/image-workbench.spec.ts`
- Modify: `apps/web/src/components/image-workbench.tsx`

**Interfaces:**

- Consumes: Task 1 `downloadUrl()`, existing `createZipArchive()`, `itemsRef`, `activeRunRef`, and owned object-URL helpers.
- Produces: `installAvailableWebShare(page)`, `expectWebShareUnused(page)`, `installDownloadActivationController(page)`, and `setDownloadActivationBlocked(page, blocked)` for later browser tasks; synchronous `downloadItem(item)`; generation-safe `downloadAll()`.

- [ ] **Step 1: Create the shared browser tripwire**

Add `tests/e2e/support/result-download.ts` exactly as follows:

```ts
import { expect, type Page } from "@playwright/test";

type WebShareCalls = { canShare: number; share: number };
type ResultDeliveryWindow = Window & {
  __hereisitBlockDownloads?: boolean;
  __hereisitWebShareCalls?: WebShareCalls;
};

export async function installAvailableWebShare(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const tracked = window as ResultDeliveryWindow;
    tracked.__hereisitWebShareCalls = { canShare: 0, share: 0 };
    Object.defineProperty(navigator, "canShare", {
      configurable: true,
      value: () => {
        const calls = tracked.__hereisitWebShareCalls ?? { canShare: 0, share: 0 };
        calls.canShare += 1;
        tracked.__hereisitWebShareCalls = calls;
        return true;
      },
    });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async () => {
        const calls = tracked.__hereisitWebShareCalls ?? { canShare: 0, share: 0 };
        calls.share += 1;
        tracked.__hereisitWebShareCalls = calls;
        throw new Error("Result delivery must not call Web Share");
      },
    });
  });
}

export async function expectWebShareUnused(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as ResultDeliveryWindow).__hereisitWebShareCalls ?? {
            canShare: 0,
            share: 0,
          },
      ),
    )
    .toEqual({ canShare: 0, share: 0 });
}

export async function installDownloadActivationController(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const tracked = window as ResultDeliveryWindow;
    tracked.__hereisitBlockDownloads = false;
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click() {
      if (tracked.__hereisitBlockDownloads && this.download.length > 0) {
        throw new Error("controlled download activation failure");
      }
      originalClick.call(this);
    };
  });
}

export async function setDownloadActivationBlocked(page: Page, blocked: boolean): Promise<void> {
  await page.evaluate((value) => {
    (window as ResultDeliveryWindow).__hereisitBlockDownloads = value;
  }, blocked);
}
```

The helper records only aggregate call counts; never store share data, filenames, or file contents.

- [ ] **Step 2: Replace the old share-sheet test and add direct-download failure coverage**

In `tests/e2e/image-workbench.spec.ts`, import the four helpers and `unzipSync`. Rename existing locators to `결과 다운로드 ↓`. Replace the test named `uses the device share sheet for one result when files are supported` with:

```ts
test("downloads one image without consulting available Web Share APIs", async ({ page }) => {
  await installAvailableWebShare(page);
  let downloadCount = 0;
  page.on("download", () => {
    downloadCount += 1;
  });
  await page.goto("/image/convert");
  await page.locator("input[type=file]").setInputFiles({
    name: "share.png",
    mimeType: "image/png",
    buffer: onePixelPng,
  });
  await page.getByRole("button", { name: "1개 이미지 형식 변환 →" }).click();
  await expect(
    page.getByRole("strong").filter({ hasText: "1개 이미지 변환을 완료했어요." }),
  ).toBeVisible({ timeout: 20_000 });
  expect(downloadCount).toBe(0);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "결과 다운로드 ↓" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("share-hereisit.webp");
  expect(downloadCount).toBe(1);
  await expect(page.getByRole("status")).toContainText("다운로드를 시작했어요.");
  await expectWebShareUnused(page);
  await expect(page.getByRole("button", { name: /공유|저장·공유/ })).toHaveCount(0);
});

test("keeps an image result retryable when download activation throws", async ({ page }) => {
  await installDownloadActivationController(page);
  await page.goto("/image/convert");
  await page.locator("input[type=file]").setInputFiles({
    name: "retry.png",
    mimeType: "image/png",
    buffer: onePixelPng,
  });
  await page.getByRole("button", { name: "1개 이미지 형식 변환 →" }).click();
  await expect(page.getByRole("button", { name: "결과 다운로드 ↓" })).toBeVisible({
    timeout: 20_000,
  });

  await setDownloadActivationBlocked(page, true);
  await page.getByRole("button", { name: "결과 다운로드 ↓" }).click();
  await expect(page.getByRole("status")).toContainText(
    "다운로드를 시작하지 못했어요. 다시 시도해 주세요.",
  );
  await expect(page.getByRole("button", { name: "결과 다운로드 ↓" })).toBeVisible();

  await setDownloadActivationBlocked(page, false);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "결과 다운로드 ↓" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("retry-hereisit.webp");
});
```

- [ ] **Step 3: Add selected-image, ZIP, and deterministic stale-ZIP tests**

Add the selected/batch policy test:

```ts
test("downloads a selected image and its batch ZIP without Web Share", async ({ page }) => {
  await installAvailableWebShare(page);
  let downloadCount = 0;
  page.on("download", () => {
    downloadCount += 1;
  });
  await page.goto("/image/convert");
  await page.locator("input[type=file]").setInputFiles([
    { name: "first.png", mimeType: "image/png", buffer: onePixelPng },
    { name: "second.png", mimeType: "image/png", buffer: onePixelPng },
  ]);
  await page.getByRole("button", { name: "2개 이미지 형식 변환 →" }).click();
  await expect(
    page.getByRole("strong").filter({ hasText: "2개 이미지 변환을 완료했어요." }),
  ).toBeVisible({ timeout: 20_000 });
  expect(downloadCount).toBe(0);

  const [selectedDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "이 이미지 다운로드 ↓" }).click(),
  ]);
  expect(selectedDownload.suggestedFilename()).toBe("first-hereisit.webp");
  const selectedPath = await selectedDownload.path();
  expect(selectedPath).not.toBeNull();
  const selectedBytes = new Uint8Array(await readFile(selectedPath as string));
  expect(new TextDecoder().decode(selectedBytes.subarray(0, 4))).toBe("RIFF");
  expect(new TextDecoder().decode(selectedBytes.subarray(8, 12))).toBe("WEBP");
  await expect(page.getByRole("status")).toContainText("다운로드를 시작했어요.");

  const [zipDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "결과 2개 ZIP 다운로드 ↓" }).click(),
  ]);
  expect(zipDownload.suggestedFilename()).toBe("hereisit-images.zip");
  const zipPath = await zipDownload.path();
  expect(zipPath).not.toBeNull();
  const archive = unzipSync(new Uint8Array(await readFile(zipPath as string)));
  expect(Object.keys(archive).sort()).toEqual([
    "first-hereisit.webp",
    "second-hereisit.webp",
  ]);
  expect(downloadCount).toBe(2);
  await expect(page.getByRole("status")).toContainText("ZIP 다운로드를 시작했어요.");
  await expectWebShareUnused(page);
});
```

Use a deterministic microtask gate in the complete stale-archive test:

```ts
test("does not download a pending image ZIP after the workbench unmounts", async ({ page }) => {
  await page.addInitScript(() => {
    const nativeQueueMicrotask = globalThis.queueMicrotask.bind(globalThis);
    const tracked = window as Window & {
      __heldZipMicrotasks?: VoidFunction[];
      __holdZipMicrotasks?: boolean;
      __releaseZipMicrotasks?: () => void;
    };
    tracked.__heldZipMicrotasks = [];
    globalThis.queueMicrotask = (callback) => {
      if (tracked.__holdZipMicrotasks) tracked.__heldZipMicrotasks?.push(callback);
      else nativeQueueMicrotask(callback);
    };
    tracked.__releaseZipMicrotasks = () => {
      for (const callback of tracked.__heldZipMicrotasks ?? []) nativeQueueMicrotask(callback);
      tracked.__heldZipMicrotasks = [];
    };
  });
  await page.goto("/image/convert");
  await page.locator("input[type=file]").setInputFiles([
    { name: "first.png", mimeType: "image/png", buffer: onePixelPng },
    { name: "second.png", mimeType: "image/png", buffer: onePixelPng },
  ]);
  await page.getByRole("button", { name: "2개 이미지 형식 변환 →" }).click();
  await expect(
    page.getByRole("strong").filter({ hasText: "2개 이미지 변환을 완료했어요." }),
  ).toBeVisible({ timeout: 20_000 });

  let downloads = 0;
  const pageErrors: string[] = [];
  page.on("download", () => {
    downloads += 1;
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.evaluate(() => {
    (window as Window & { __holdZipMicrotasks?: boolean }).__holdZipMicrotasks = true;
  });
  await page.getByRole("button", { name: "결과 2개 ZIP 다운로드 ↓" }).click();
  const archiveAction = page.getByRole("button", { name: "결과 2개 ZIP 다운로드 ↓" });
  await expect(archiveAction).toBeDisabled();
  await expect(page.getByRole("status")).toContainText("ZIP 파일을 만들고 있어요.");
  await archiveAction.evaluate((button: HTMLButtonElement) => button.click());
  await page.evaluate(() => {
    (window as Window & { __holdZipMicrotasks?: boolean }).__holdZipMicrotasks = false;
  });
  await page.getByRole("link", { name: "HereIsIt 홈" }).click();
  await page.evaluate(() => {
    (window as Window & { __releaseZipMicrotasks?: () => void }).__releaseZipMicrotasks?.();
  });
  await page.waitForTimeout(100);

  expect(downloads).toBe(0);
  expect(pageErrors).toEqual([]);
  await expect(page.getByText("ZIP 다운로드를 시작했어요.", { exact: true })).toHaveCount(0);
});
```

- [ ] **Step 4: Run the general-image tests and verify RED**

Run:

```bash
pnpm --filter @hereisit/web build
pnpm exec playwright test tests/e2e/image-workbench.spec.ts --project=chromium
```

Expected: new labels/statuses, Web Share zero-call assertions, retryable failure, and stale ZIP protection fail against the share-first implementation.

- [ ] **Step 5: Replace the individual share-first handler with synchronous download**

Remove `isAbortError` from the import and replace `saveItem` with:

```ts
const downloadItem = (item: WorkItem) => {
  const current = itemsRef.current.find((candidate) => candidate.id === item.id);
  if (
    item.resultUrl === undefined ||
    item.result === undefined ||
    current?.resultUrl !== item.resultUrl ||
    current.result !== item.result
  ) {
    return;
  }
  try {
    downloadUrl(item.resultUrl, item.result.suggestedName);
    setMessage("다운로드를 시작했어요.");
  } catch {
    setMessage("다운로드를 시작하지 못했어요. 다시 시도해 주세요.");
  }
};
```

Rename both callers to `downloadItem`, and use exact labels `이 이미지 다운로드 ↓` and `결과 다운로드 ↓`.

- [ ] **Step 6: Harden the on-demand ZIP lifecycle and update its copy**

Add an archive lease map beside `objectUrlsRef` and this cleanup helper immediately after `revokeOwnedUrl`:

```ts
const archiveLeasesRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

const releaseArchiveLeases = useCallback(() => {
  for (const [url, timeoutId] of archiveLeasesRef.current) {
    clearTimeout(timeoutId);
    revokeOwnedUrl(url);
  }
  archiveLeasesRef.current.clear();
}, [revokeOwnedUrl]);
```

Call `releaseArchiveLeases()` before starting another run and at the start of `invalidateResults()`, `removeItem()`, and `reset()`. Increment `activeRunRef.current` in each of those result-invalidating paths. In unmount cleanup, clear every lease timeout before the existing loop revokes all owned URLs, then empty `archiveLeasesRef`. Use this post-`await` shape:

```ts
const downloadAll = async () => {
  if (completedItems.length === 0 || archiving) return;
  const runId = activeRunRef.current;
  setArchiving(true);
  setMessage("ZIP 파일을 만들고 있어요.");
  try {
    const archive = await createZipArchive(
      completedItems.flatMap((item) =>
        item.result === undefined
          ? []
          : [{ name: item.result.suggestedName, bytes: item.result.bytes }],
      ),
    );
    if (activeRunRef.current !== runId) return;
    const url = createOwnedUrl(archive);
    try {
      downloadUrl(url, "hereisit-images.zip");
      const timeoutId = setTimeout(() => {
        if (!archiveLeasesRef.current.delete(url)) return;
        revokeOwnedUrl(url);
      }, 10_000);
      archiveLeasesRef.current.set(url, timeoutId);
    } catch (error) {
      revokeOwnedUrl(url);
      throw error;
    }
    setMessage("ZIP 다운로드를 시작했어요.");
  } catch {
    if (activeRunRef.current === runId) {
      setMessage("ZIP 파일을 만들지 못했어요. 개별 파일을 다운로드해 주세요.");
    }
  } finally {
    if (activeRunRef.current === runId) setArchiving(false);
  }
};
```

The batch label is exactly ``결과 ${completedItems.length}개 ZIP 다운로드 ↓``.

- [ ] **Step 7: Run focused image verification and commit**

Run:

```bash
pnpm exec playwright test tests/e2e/image-workbench.spec.ts --project=chromium
pnpm --filter @hereisit/web typecheck
```

Expected: all general-image cases pass; Web Share counters remain zero; direct and ZIP errors retain retryable results.

```bash
git add tests/e2e/support/result-download.ts tests/e2e/image-workbench.spec.ts apps/web/src/components/image-workbench.tsx
git commit -m "fix: make image results download only"
```

### Task 3: Make image-watermark results download-only

**Files:**

- Modify: `tests/e2e/image-watermark.spec.ts`
- Modify: `apps/web/src/components/image-watermark-workbench.tsx`
- Modify: `apps/web/src/components/image-workbench.module.css`
- Modify: `tests/e2e/mobile.spec.ts`

**Interfaces:**

- Consumes: Task 1 `downloadUrl()`, Task 2 result-delivery browser helpers, existing `activeGenerationRef`, `itemsRef`, archive lease map, and `dedupeArchiveNames()`.
- Produces: synchronous `downloadItem(item)` with current-result validation; unchanged collision-safe ZIP bytes and cleanup with download-only copy.

- [ ] **Step 1: Rewrite the watermark expectations before production code**

In `tests/e2e/image-watermark.spec.ts`:

1. Import `expectWebShareUnused`, `installAvailableWebShare`, `installDownloadActivationController`, and `setDownloadActivationBlocked` from `./support/result-download`.
2. Rename `text watermark uses the approved defaults and saves only on request` to `text watermark uses the approved defaults and downloads only on request`.
3. Call `installAvailableWebShare(page)` before that test's existing object-URL init script; remove its assignments of `navigator.share` and `navigator.canShare` to `undefined`.
4. Click `결과 다운로드 ↓`, retain the PNG filename/signature/dimension/pixel assertions, assert status `다운로드를 시작했어요.`, and call `expectWebShareUnused(page)`.
5. In the two-result collision-safe ZIP test, call `installAvailableWebShare(page)` before navigation, first click `선택 파일 다운로드 ↓`, assert the selected result name and `다운로드를 시작했어요.`, then click `결과 2개 ZIP 다운로드 ↓`; retain all archive-entry assertions, assert `ZIP 다운로드를 시작했어요.`, and call `expectWebShareUnused(page)`.
6. Change result-absence locators to `/결과 다운로드|ZIP 다운로드/` and every batch locator to `결과 N개 ZIP 다운로드 ↓`.
7. Delete the `for (const shareOutcome of ["resolve", "reject"])` delayed-share tests completely.

Add this replacement failure case:

```ts
test("keeps a watermark result retryable when download activation throws", async ({ page }) => {
  await installDownloadActivationController(page);
  await page.goto("/image/watermark");
  const source = await createSolidPng(page, 100, 60, "#ffffff");
  await setSourceFiles(page, {
    name: "retry.png",
    mimeType: "image/png",
    buffer: source,
  });
  await page.getByRole("button", { name: "1개 이미지에 워터마크 넣기 →" }).click();
  await waitForCompleted(page, 1);

  await setDownloadActivationBlocked(page, true);
  await page.getByRole("button", { name: "결과 다운로드 ↓" }).click();
  await expect(page.getByRole("status")).toContainText(
    "다운로드를 시작하지 못했어요. 다시 시도해 주세요.",
  );
  await expect(page.getByRole("button", { name: "결과 다운로드 ↓" })).toBeVisible();

  await setDownloadActivationBlocked(page, false);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "결과 다운로드 ↓" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("retry-watermarked-hereisit.png");
});
```

Update the existing archive-initiation failure test to expect the ZIP-specific corrective copy and keep its immediate URL-revocation assertion. Do not weaken the existing archive lease, setting/logo invalidation, rerun, reset, or object-URL checks.

After the existing duplicate-source setup and `waitForCompleted(page, 2)`, insert this exact delivery sequence before the existing ZIP-byte assertions:

```ts
const [selectedDownload] = await Promise.all([
  page.waitForEvent("download"),
  page.getByRole("button", { name: "선택 파일 다운로드 ↓" }).click(),
]);
expect(selectedDownload.suggestedFilename()).toBe("duplicate-watermarked-hereisit.png");
await expect(page.getByRole("status")).toContainText("다운로드를 시작했어요.");

const [archiveDownload] = await Promise.all([
  page.waitForEvent("download"),
  page.getByRole("button", { name: "결과 2개 ZIP 다운로드 ↓" }).click(),
]);
expect(archiveDownload.suggestedFilename()).toBe("hereisit-watermarked-images.zip");
await expect(page.getByRole("status")).toContainText("ZIP 다운로드를 시작했어요.");
await expectWebShareUnused(page);
```

Place `await installAvailableWebShare(page)` before that test's `page.goto()`. Rename the existing ZIP variable to `archiveDownload`, read its path for the existing deduplicated-entry assertions, and change the final download count from `1` to `2`.

- [ ] **Step 2: Run watermark tests and verify RED**

```bash
pnpm exec playwright test tests/e2e/image-watermark.spec.ts --project=chromium --grep "downloads only on request|collision-safe ZIP|retryable|archive URL"
```

Expected: new labels, zero Web Share calls, success messages, and retryable failure are not satisfied by the share-first handler.

- [ ] **Step 3: Replace `saveItem` with the validated direct-download handler**

Remove `isAbortError` from the import and replace the handler with:

```ts
const downloadItem = (item: WorkItem) => {
  if (item.result === undefined || item.resultUrl === undefined) return;
  const generation = activeGenerationRef.current;
  const current = itemsRef.current.find((candidate) => candidate.id === item.id);
  if (
    current?.resultUrl !== item.resultUrl ||
    current.result !== item.result ||
    activeGenerationRef.current !== generation
  ) {
    return;
  }
  try {
    downloadUrl(item.resultUrl, item.result.suggestedName);
    if (activeGenerationRef.current === generation) setMessage("다운로드를 시작했어요.");
  } catch {
    if (activeGenerationRef.current === generation) {
      setMessage("다운로드를 시작하지 못했어요. 다시 시도해 주세요.");
    }
  }
};
```

Rename callers to `downloadItem` and set labels exactly:

```tsx
선택 파일 다운로드 ↓
결과 다운로드 ↓
결과 {completedItems.length}개 ZIP 다운로드 ↓
```

- [ ] **Step 4: Keep the proven archive lifecycle and change only delivery outcomes**

In `downloadAll()` keep generation checks, name deduplication, lease timers, immediate exception cleanup, and stale-message guards. Change only:

```ts
setMessage("ZIP 다운로드를 시작했어요.");
```

and the error copy:

```ts
setMessage("ZIP 파일을 만들지 못했어요. 개별 결과를 다운로드해 주세요.");
```

Change remaining visible copy exactly:

```text
저장할 수 있어요.                 -> 다운로드할 수 있어요.
자동 저장하지 않으며              -> 자동 다운로드하지 않으며
명시적으로 저장할 때만 내려받아요. -> 다운로드 버튼을 누를 때만 내려받아요.
```

After a result exists, make rerun use `secondaryButton` and the single/ZIP download use `runButton`, without changing DOM order.

- [ ] **Step 5: Enforce desktop and mobile target geometry**

In `image-workbench.module.css`, change the shared result targets to at least 44px:

```css
.headerActions button,
.secondaryButton,
.cancelButton {
  min-height: 44px;
}

.inlineDownload {
  min-height: 44px;
}
```

In the watermark mobile case in `tests/e2e/mobile.spec.ts`, rename the sticky locator to `결과 다운로드 ↓`, also locate `선택 파일 다운로드 ↓`, and keep both width/height assertions at `>= 44` plus the existing no-overflow assertion.

- [ ] **Step 6: Run desktop/mobile watermark verification and commit**

```bash
pnpm exec playwright test tests/e2e/image-watermark.spec.ts --project=chromium
pnpm exec playwright test tests/e2e/image-watermark.spec.ts tests/e2e/mobile.spec.ts --project=mobile-chromium --grep "watermark"
pnpm --filter @hereisit/web typecheck
```

Expected: all watermark delivery, archive lifecycle, 44px, sticky, and overflow cases pass.

```bash
git add apps/web/src/components/image-watermark-workbench.tsx apps/web/src/components/image-workbench.module.css tests/e2e/image-watermark.spec.ts tests/e2e/mobile.spec.ts
git commit -m "fix: make watermark results download only"
```

### Task 4: Make general PDF and produced ZIP results download-only

**Files:**

- Modify: `tests/e2e/pdf-tools.spec.ts`
- Modify: `apps/web/src/components/pdf-workbench.tsx`
- Modify: `tests/e2e/tool-detail-shells.spec.ts`
- Modify: `tests/e2e/mobile.spec.ts`

**Interfaces:**

- Consumes: Task 1 `downloadUrl()`, Task 2 browser tripwire/controller, existing `resultUrl` state, `resultUrlRef`, `runRef`, and PDF Worker output metadata.
- Produces: synchronous `downloadResult()`; `PDF 다운로드 ↓` for one PDF and `ZIP 다운로드 ↓` for an already-produced archive.

- [ ] **Step 1: Lock PDF and ZIP behavior with failing browser assertions**

In `tests/e2e/pdf-tools.spec.ts`, import the Task 2 browser helpers. Update every ordinary locator from `PDF 저장·공유 ↓` to `PDF 다운로드 ↓`; update the split-every-page locator to `ZIP 다운로드 ↓`.

In `merges PDFs in the chosen order without external uploads`, call `installAvailableWebShare(page)` before `page.goto()`, add this counter before processing, and assert zero immediately after `2페이지 PDF 준비 완료`:

```ts
let downloadCount = 0;
page.on("download", () => {
  downloadCount += 1;
});

expect(downloadCount).toBe(0);
```

Retain the exact merged PDF assertions and add after the explicit download:

```ts
expect(downloadCount).toBe(1);
await expect(page.getByRole("status")).toContainText("다운로드를 시작했어요.");
await expectWebShareUnused(page);
```

In `splits every PDF page into a ZIP`, add the same tripwire, retain exact ZIP entries, and assert:

```ts
await expect(page.getByRole("status")).toContainText("ZIP 다운로드를 시작했어요.");
await expectWebShareUnused(page);
```

Add this activation-failure test:

```ts
test("keeps a prepared PDF result retryable when download activation fails", async ({ page }) => {
  await installDownloadActivationController(page);
  await page.goto("/pdf/merge");
  await page.locator("input[type=file]").setInputFiles([
    { name: "first.pdf", mimeType: "application/pdf", buffer: await createPdf([100]) },
    { name: "second.pdf", mimeType: "application/pdf", buffer: await createPdf([200]) },
  ]);
  await page.getByRole("button", { name: "2개 PDF 합치기 →" }).click();
  await expect(page.getByText("2페이지 PDF 준비 완료")).toBeVisible({ timeout: 20_000 });

  await setDownloadActivationBlocked(page, true);
  await page.getByRole("button", { name: "PDF 다운로드 ↓" }).click();
  await expect(page.getByRole("status")).toContainText(
    "다운로드를 시작하지 못했어요. 다시 시도해 주세요.",
  );
  await expect(page.getByText("2페이지 PDF 준비 완료")).toBeVisible();

  await setDownloadActivationBlocked(page, false);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "PDF 다운로드 ↓" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("merged-hereisit.pdf");
});
```

Update `tests/e2e/tool-detail-shells.spec.ts` organizer output to `PDF 다운로드 ↓`. In `tests/e2e/mobile.spec.ts`, update organizer and PDF-watermark output locators to `PDF 다운로드 ↓` while preserving 44px, sticky, and overflow assertions.

- [ ] **Step 2: Run general PDF cases and verify RED**

```bash
pnpm exec playwright test tests/e2e/pdf-tools.spec.ts tests/e2e/tool-detail-shells.spec.ts --project=chromium
pnpm exec playwright test tests/e2e/mobile.spec.ts --project=mobile-chromium --grep "PDF organizer|watermark Worker"
```

Expected: renamed buttons, started messages, zero share calls, and failure recovery fail against the share-first handler.

- [ ] **Step 3: Remove the share-only Blob reference and implement direct download**

In `pdf-workbench.tsx`:

- remove `isAbortError` from the import;
- remove `resultBlobRef` declaration and every assignment/reset;
- keep the local result Blob long enough to call `URL.createObjectURL(blob)`;
- keep `resultUrl` state/ref, `runRef`, Worker cancellation, and URL revocation.

Replace `saveResult` with:

```ts
const downloadResult = () => {
  const currentUrl = resultUrlRef.current;
  if (result === undefined || resultUrl === undefined || currentUrl !== resultUrl) return;
  try {
    downloadUrl(resultUrl, result.suggestedName);
    setMessage(
      result.mime === "application/zip"
        ? "ZIP 다운로드를 시작했어요."
        : "다운로드를 시작했어요.",
    );
  } catch {
    setMessage("다운로드를 시작하지 못했어요. 다시 시도해 주세요.");
  }
};
```

Use `onClick={downloadResult}` and:

```tsx
{result.mime === "application/zip" ? "ZIP 다운로드 ↓" : "PDF 다운로드 ↓"}
```

- [ ] **Step 4: Run focused PDF verification and commit**

```bash
pnpm exec playwright test tests/e2e/pdf-tools.spec.ts tests/e2e/tool-detail-shells.spec.ts --project=chromium
pnpm exec playwright test tests/e2e/mobile.spec.ts --project=mobile-chromium --grep "PDF organizer|watermark Worker"
pnpm --filter @hereisit/web typecheck
```

Expected: PDF/ZIP output bytes and names remain unchanged; downloads occur once without Web Share.

```bash
git add apps/web/src/components/pdf-workbench.tsx tests/e2e/pdf-tools.spec.ts tests/e2e/tool-detail-shells.spec.ts tests/e2e/mobile.spec.ts
git commit -m "fix: download PDF results directly"
```

### Task 5: Make scanned-PDF compression download-only

**Files:**

- Modify: `tests/e2e/pdf-compression.spec.ts`
- Modify: `apps/web/src/components/pdf-compress-workbench.tsx`
- Modify: `tests/e2e/mobile.spec.ts`

**Interfaces:**

- Consumes: Task 1 `downloadUrl()`, Task 2 browser helpers, existing `resultUrlRef`, compression result metadata, `runRef`, and object-URL lifecycle.
- Produces: synchronous `downloadResult()` with `PDF 다운로드 ↓`; no share operation state.

- [ ] **Step 1: Replace fallback-oriented tests with download-only tests**

In `tests/e2e/pdf-compression.spec.ts`:

- import Task 2's helpers;
- delete local `forceDownloadFallback()` and `installPendingShare()`;
- delete the final two tests about fulfilled/rejected pending shares;
- replace every `PDF 저장·공유 ↓` locator with `PDF 다운로드 ↓`;
- rename `compresses a known scan with the default preset and downloads only after one explicit save` to end in `explicit download`;
- call `installAvailableWebShare(page)` in both successful compression download tests;
- after each explicit download assert the exact started message and `expectWebShareUnused(page)`;
- retain exact PDF envelope, 1%-smaller, geometry, image-dimension, metadata, preset, no-reduction, cancel, and object-URL assertions.

Add this complete retry test:

```ts
test("keeps a compressed PDF result retryable when download activation fails", async ({
  browserName,
  page,
}) => {
  await installDownloadActivationController(page);
  const privacy = await prepareCompressedResult(page);
  await setDownloadActivationBlocked(page, true);
  await page.getByRole("button", { name: "PDF 다운로드 ↓" }).click();
  await expect(page.getByRole("status")).toContainText(
    "다운로드를 시작하지 못했어요. 다시 시도해 주세요.",
  );
  await expect(page.getByText("압축 PDF 준비 완료")).toBeVisible();
  await expect(page.getByRole("button", { name: "PDF 다운로드 ↓" })).toBeVisible();

  await setDownloadActivationBlocked(page, false);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "PDF 다운로드 ↓" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("scan-compressed-hereisit.pdf");
  expectCompletePdfEnvelope(await downloadedBytes(await download.path()));
  await expect(page.getByRole("status")).toContainText("다운로드를 시작했어요.");
  await privacy.assertClean(1, browserName !== "firefox");
});
```

Add this counter before `prepareCompressedResult(page)` in the existing preset/rerun/replacement/reset/unmount lifecycle test, and assert `expect(downloads).toBe(0)` after each prepared-result and invalidation checkpoint:

```ts
let downloads = 0;
page.on("download", () => {
  downloads += 1;
});
```

Update the scanned-compression mobile locator to `PDF 다운로드 ↓` without weakening its 44px/sticky/overflow checks.

- [ ] **Step 2: Run compression tests and verify RED**

```bash
pnpm exec playwright test tests/e2e/pdf-compression.spec.ts --project=chromium
pnpm exec playwright test tests/e2e/mobile.spec.ts --project=mobile-chromium --grep "scanned PDF compression"
```

Expected: new label/status, zero share calls, and retry behavior fail against the existing share promise.

- [ ] **Step 3: Delete share-promise state and implement synchronous PDF download**

In `pdf-compress-workbench.tsx` remove:

```ts
isAbortError
resultBlobRef
saveOperationRef
savingRef
```

Remove their assignments from `clearResult()`, `invalidateActiveWork()`, result completion, and unmount cleanup. Preserve `runRef`, inspection/job cancellation, `resultUrlRef`, and URL revocation. The result Blob remains a local variable used to create the URL.

Replace `saveResult` with:

```ts
const downloadResult = () => {
  const resultUrl = resultUrlRef.current;
  if (result === undefined || resultUrl === undefined) return;
  try {
    downloadUrl(resultUrl, result.suggestedName);
    setMessage("다운로드를 시작했어요.");
  } catch {
    setMessage("다운로드를 시작하지 못했어요. 다시 시도해 주세요.");
  }
};
```

Use `onClick={downloadResult}` and exact label `PDF 다운로드 ↓`.

- [ ] **Step 4: Run compression verification and commit**

```bash
pnpm exec playwright test tests/e2e/pdf-compression.spec.ts --project=chromium
pnpm exec playwright test tests/e2e/mobile.spec.ts --project=mobile-chromium --grep "scanned PDF compression"
pnpm --filter @hereisit/web typecheck
```

Expected: all compression output, no-reduction, cancel, lifecycle, mobile, and download-policy cases pass.

```bash
git add apps/web/src/components/pdf-compress-workbench.tsx tests/e2e/pdf-compression.spec.ts tests/e2e/mobile.spec.ts
git commit -m "fix: download compressed PDFs directly"
```

### Task 6: Make PDF-to-image results download-only and remove abort-share utilities

**Files:**

- Modify: `tests/e2e/pdf-to-images.spec.ts`
- Modify: `apps/web/src/components/pdf-to-image-workbench.tsx`
- Modify: `tests/e2e/mobile.spec.ts`
- Modify: `apps/web/src/lib/files.ts`
- Modify: `apps/web/src/lib/files.test.ts`

**Interfaces:**

- Consumes: Task 1 `downloadUrl()`, Task 2 browser helpers, existing `resultUrl` state/ref, `runRef`, PDF raster output metadata, and existing object-URL lifecycle.
- Produces: synchronous `downloadResult()` with `이미지 다운로드 ↓` or `ZIP 다운로드 ↓`; no remaining web-workbench caller of `isAbortError()`.

- [ ] **Step 1: Replace PDF-image fallback/share tests with direct-download expectations**

In `tests/e2e/pdf-to-images.spec.ts`:

- import Task 2's helpers;
- delete local `forceDownloadFallback()` and `installPendingShare()`;
- delete the final two fulfilled/rejected pending-share tests;
- replace `이미지 저장·공유 ↓` with `이미지 다운로드 ↓`;
- replace every `결과 N개 ZIP으로 받기 ↓` with `ZIP 다운로드 ↓`;
- change the cancel result-absence regex to `/이미지 다운로드|ZIP 다운로드/`;
- call `installAvailableWebShare(page)` before navigation in the two-page ZIP test and the rotated single-PNG test;
- retain exact filename, ordered ZIP-entry, PNG/JPEG signature, dimension, page-order, privacy, parser asset, and URL-revocation assertions;
- assert `다운로드를 시작했어요.` for one image, `ZIP 다운로드를 시작했어요.` for a ZIP, and `expectWebShareUnused(page)` in both cases.

Add this controlled failure test. `prepareSinglePageResult()` uses the default JPG/150 DPI settings and produces `report-page-001.jpg`:

```ts
test("keeps a prepared PDF image result retryable when download activation fails", async ({
  browserName,
  page,
}) => {
  await installDownloadActivationController(page);
  const privacy = await prepareSinglePageResult(page);
  await setDownloadActivationBlocked(page, true);
  await page.getByRole("button", { name: "이미지 다운로드 ↓" }).click();
  await expect(page.getByRole("status")).toContainText(
    "다운로드를 시작하지 못했어요. 다시 시도해 주세요.",
  );
  await expect(page.getByText("이미지 1개 준비 완료")).toBeVisible();
  await setDownloadActivationBlocked(page, false);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "이미지 다운로드 ↓" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("report-page-001.jpg");
  privacy.assertClean(browserName !== "firefox");
});
```

Retain the fixture's MIME and dimension checks. Add this counter before the first prepared result in the existing settings/rerun/replacement/reset/unmount URL-lifecycle test, and assert `expect(downloads).toBe(0)` after each result and invalidation checkpoint:

```ts
let downloads = 0;
page.on("download", () => {
  downloads += 1;
});
```

Update the PDF-image mobile locator to `이미지 다운로드 ↓` and retain 44px/sticky/overflow assertions.

- [ ] **Step 2: Run PDF-image tests and verify RED**

```bash
pnpm exec playwright test tests/e2e/pdf-to-images.spec.ts --project=chromium
pnpm exec playwright test tests/e2e/mobile.spec.ts --project=mobile-chromium --grep "PDF image conversion"
```

Expected: new labels/statuses, zero Web Share calls, and retry behavior fail against the existing save/share promise.

- [ ] **Step 3: Delete share-only state and implement synchronous image/ZIP download**

In `pdf-to-image-workbench.tsx`, remove:

```ts
isAbortError
const [saving, setSaving] = useState(false)
resultBlobRef
saveOperationRef
savingRef
```

Remove their reset, invalidation, completion, unmount, and JSX-disabled assignments. Keep the result Blob as a local variable for `URL.createObjectURL()`, and preserve `resultUrl` state/ref, `runRef`, Worker cancellation, and URL revocation.

Replace `saveResult` with:

```ts
const downloadResult = () => {
  const currentUrl = resultUrlRef.current;
  if (result === undefined || resultUrl === undefined || currentUrl !== resultUrl) return;
  try {
    downloadUrl(resultUrl, result.suggestedName);
    setMessage(
      result.outputFileCount === 1
        ? "다운로드를 시작했어요."
        : "ZIP 다운로드를 시작했어요.",
    );
  } catch {
    setMessage("다운로드를 시작하지 못했어요. 다시 시도해 주세요.");
  }
};
```

Use `onClick={downloadResult}` without `disabled={saving}` and render:

```tsx
{result.outputFileCount === 1 ? "이미지 다운로드 ↓" : "ZIP 다운로드 ↓"}
```

- [ ] **Step 4: Remove the now-unused share-cancellation helper**

First require zero web-workbench callers:

```bash
rg -n "isAbortError" apps/web/src/components
```

Expected: no output. Then delete this export from `apps/web/src/lib/files.ts`:

```ts
export function isAbortError(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === "AbortError";
}
```

Remove it from the `files.test.ts` import and delete its three assertions. Do not touch the private abort helpers in `packages/browser-runtime`; they protect Worker cancellation rather than result sharing.

- [ ] **Step 5: Run PDF-image and common verification and commit**

```bash
pnpm exec vitest run apps/web/src/lib/files.test.ts
pnpm exec playwright test tests/e2e/pdf-to-images.spec.ts --project=chromium
pnpm exec playwright test tests/e2e/mobile.spec.ts --project=mobile-chromium --grep "PDF image conversion"
pnpm --filter @hereisit/web typecheck
```

Expected: direct image/ZIP policy, output/lifecycle/privacy tests, and common file tests all pass.

```bash
git add apps/web/src/components/pdf-to-image-workbench.tsx apps/web/src/lib/files.ts apps/web/src/lib/files.test.ts tests/e2e/pdf-to-images.spec.ts tests/e2e/mobile.spec.ts
git commit -m "fix: download PDF image results directly"
```

### Task 7: Lock the global policy, responsive boundaries, release smokes, and documentation

**Files:**

- Create: `tests/result-download-policy.test.ts`
- Create: `scripts/support/result-download.mjs`
- Modify: `tests/e2e/mobile.spec.ts`
- Modify: `scripts/smoke-image-watermark.mjs`
- Modify: `scripts/smoke-pdf-compress.mjs`
- Modify: `scripts/smoke-pdf-to-images.mjs`
- Modify: `apps/web/src/components/tool-detail-page.tsx`
- Modify: `docs/architecture.md`
- Modify: `docs/deployment.md`
- Modify: `docs/testing/discovery-accessibility-checklist.md`
- Modify: `docs/superpowers/specs/2026-07-15-direct-download-default-design.md`

**Interfaces:**

- Consumes: all five migrated workbenches and the established Chromium/mobile Playwright fixtures.
- Produces: a permanent source-policy test, exact responsive-boundary coverage, and preview/production smokes that fail if Web Share is consulted.

- [ ] **Step 1: Add the source-policy invariant**

Create `tests/result-download-policy.test.ts`:

```ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const workbenches = [
  "apps/web/src/components/image-workbench.tsx",
  "apps/web/src/components/image-watermark-workbench.tsx",
  "apps/web/src/components/pdf-workbench.tsx",
  "apps/web/src/components/pdf-compress-workbench.tsx",
  "apps/web/src/components/pdf-to-image-workbench.tsx",
] as const;

const forbiddenResultDeliveryText = [
  "navigator.share",
  "navigator.canShare",
  "ShareData",
  "저장·공유",
  "공유 메뉴",
] as const;

describe("download-only result delivery policy", () => {
  for (const filename of workbenches) {
    it(`${filename} contains no result-sharing policy`, async () => {
      const source = await readFile(filename, "utf8");
      for (const forbidden of forbiddenResultDeliveryText) {
        expect(source, `${filename} contains ${forbidden}`).not.toContain(forbidden);
      }
      expect(source).toContain("다운로드");
    });
  }
});
```

Run:

```bash
pnpm exec vitest run tests/result-download-policy.test.ts
```

Expected: five cases pass after Tasks 2–6. If any case fails, remove the remaining production share code/copy rather than weakening the forbidden list.

- [ ] **Step 2: Exercise the exact responsive width boundaries**

Add this helper near `expectFunctionalTextFloor()` in `tests/e2e/mobile.spec.ts`:

```ts
const RESPONSIVE_RESULT_WIDTHS = [320, 390, 600, 601, 800, 801, 1280] as const;

async function expectResponsiveResultActions(
  page: import("@playwright/test").Page,
  actions: readonly Locator[],
): Promise<void> {
  for (const width of RESPONSIVE_RESULT_WIDTHS) {
    await page.setViewportSize({ width, height: 844 });
    for (const action of actions) {
      await expect(action).toBeVisible();
      const box = await action.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    const layout = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
  }
}
```

Add a general-image result case so the shared image workbench is verified directly:

```ts
test("keeps general image result actions touch-safe at every responsive boundary", async ({
  page,
}) => {
  let downloads = 0;
  page.on("download", () => {
    downloads += 1;
  });
  await page.goto("/image/convert");
  await page.locator("input[type=file]").setInputFiles([
    { name: "first.png", mimeType: "image/png", buffer: onePixelPng },
    { name: "second.png", mimeType: "image/png", buffer: onePixelPng },
  ]);
  await page.getByRole("button", { name: "2개 이미지 형식 변환 →" }).click();
  await expect(
    page.getByRole("strong").filter({ hasText: "2개 이미지 변환을 완료했어요." }),
  ).toBeVisible({ timeout: 20_000 });
  expect(downloads).toBe(0);
  await expectResponsiveResultActions(page, [
    page.getByRole("button", { name: "이 이미지 다운로드 ↓" }),
    page.getByRole("button", { name: "결과 2개 ZIP 다운로드 ↓" }),
  ]);
  expect(downloads).toBe(0);
});
```

After each of the following existing mobile tests reaches its completed result, call the helper with these exact locators:

```ts
// Scanned-PDF compression result
await expectResponsiveResultActions(page, [
  page.getByRole("button", { name: "PDF 다운로드 ↓" }),
]);

// PDF-to-image single result
await expectResponsiveResultActions(page, [
  page.getByRole("button", { name: "이미지 다운로드 ↓" }),
]);

// General PDF organizer result
await expectResponsiveResultActions(page, [
  page.getByRole("button", { name: "PDF 다운로드 ↓" }),
]);

// Image-watermark selected and sticky result actions
await expectResponsiveResultActions(page, [
  page.getByRole("button", { name: "선택 파일 다운로드 ↓" }),
  page.getByRole("button", { name: "결과 다운로드 ↓" }),
]);
```

Preserve every test's original 390px sticky-position, focus-order, and safe-area assertions before calling the helper, because widening the viewport changes the responsive mode.

- [ ] **Step 3: Install Web Share tripwires in all result release smokes**

In each of the three smoke scripts, replace any `navigator.share = undefined` setup and add this logic to the existing context init script:

```js
sessionStorage.setItem(
  "__hereisitWebShareCalls",
  JSON.stringify({ canShare: 0, share: 0 }),
);
const recordShareCall = (key) => {
  const calls = JSON.parse(
    sessionStorage.getItem("__hereisitWebShareCalls") ??
      '{"canShare":0,"share":0}',
  );
  calls[key] += 1;
  sessionStorage.setItem("__hereisitWebShareCalls", JSON.stringify(calls));
};
Object.defineProperty(navigator, "canShare", {
  configurable: true,
  value: () => {
    recordShareCall("canShare");
    return true;
  },
});
Object.defineProperty(navigator, "share", {
  configurable: true,
  value: async () => {
    recordShareCall("share");
    throw new Error("Result delivery must not call Web Share");
  },
});
```

After the explicit downloads, add:

```js
assert.deepEqual(
  await page.evaluate(() =>
    JSON.parse(
      sessionStorage.getItem("__hereisitWebShareCalls") ??
        '{"canShare":0,"share":0}',
    ),
  ),
  { canShare: 0, share: 0 },
  "Result delivery consulted Web Share.",
);
```

Use exact smoke locators:

```text
smoke-image-watermark.mjs: 결과 다운로드 ↓
smoke-pdf-compress.mjs:   PDF 다운로드 ↓
smoke-pdf-to-images.mjs:  이미지 다운로드 ↓ and ZIP 다운로드 ↓
```

Assert ordinary/ZIP started status after each click while retaining all current output, privacy, security-header, request, and console-sentinel assertions. Rename internal `saveResult` smoke helpers and assertion prose to `downloadResult`/`explicit download`.

- [ ] **Step 4: Align active documentation and approved status**

Apply these exact product-copy changes:

```text
apps/web/src/components/tool-detail-page.tsx
파일은 업로드되지 않으며 저장은 직접 선택해요.
-> 파일은 업로드되지 않으며 다운로드는 버튼을 눌러 직접 시작해요.

docs/testing/discovery-accessibility-checklist.md
explicit save action / save action / export/save action
-> explicit download action / download action / download action
```

In `docs/architecture.md`, replace active descriptions of an explicit save with an explicit download and add one result-delivery sentence: `Generated image, PDF, and ZIP results never use Web Share; an explicit download-labelled action activates the tab-owned Blob URL.`

In `docs/deployment.md`, replace active release-smoke and first-deploy uses of `save`, `saves`, and `explicit-only saves` with `download`, `downloads`, and `explicit-only downloads` where they refer to generated artifacts. Do not alter Cloudflare Git-integration instructions or processing disclosures.

Change the design header to:

```markdown
**Status:** Approved on 2026-07-15
```

Historical plans/specs remain unchanged as implementation history.

- [ ] **Step 5: Run policy, responsive, and smoke-focused verification**

```bash
pnpm exec vitest run tests/result-download-policy.test.ts apps/web/src/lib/files.test.ts
pnpm --filter @hereisit/web build
pnpm exec playwright test tests/e2e/mobile.spec.ts --project=mobile-chromium --grep "result actions|watermark|PDF organizer|scanned PDF compression|PDF image conversion"
```

Expected: policy and common unit tests pass; all five workbench-family result surfaces pass all seven widths without implicit downloads or horizontal overflow.

- [ ] **Step 6: Commit the release policy and documentation**

```bash
git add tests/result-download-policy.test.ts tests/e2e/mobile.spec.ts scripts/smoke-image-watermark.mjs scripts/smoke-pdf-compress.mjs scripts/smoke-pdf-to-images.mjs apps/web/src/components/tool-detail-page.tsx docs/architecture.md docs/deployment.md docs/testing/discovery-accessibility-checklist.md docs/superpowers/specs/2026-07-15-direct-download-default-design.md
git commit -m "test: enforce download-only result delivery"
```

### Task 8: Verify, publish, and deploy the exact implementation

**Files:**

- Verify only; modify a file only if a failing gate exposes a defect within this approved scope.

**Interfaces:**

- Consumes: Tasks 1–7, GitHub repository `liorium/hereisit`, existing CI, and Cloudflare Pages Git integration.
- Produces: a reviewed pull request, immutable preview evidence, a production deployment of the exact merged SHA, and four green production smokes.

- [ ] **Step 1: Run formatting, source-policy, and complete local verification**

```bash
pnpm lint:fix
if rg -n "navigator\.(share|canShare)|ShareData|저장·공유|공유 메뉴" \
  apps/web/src/components/image-workbench.tsx \
  apps/web/src/components/image-watermark-workbench.tsx \
  apps/web/src/components/pdf-workbench.tsx \
  apps/web/src/components/pdf-compress-workbench.tsx \
  apps/web/src/components/pdf-to-image-workbench.tsx; then
  exit 1
fi
pnpm verify
PLAYWRIGHT_WEBKIT=1 pnpm verify:all
```

Expected: the source scan prints nothing; lint, types, all unit tests, builds, export gates, and the complete available desktop/mobile browser matrix pass. If WebKit cannot launch locally, record it as not run and require exact-SHA GitHub CI to pass WebKit.

- [ ] **Step 2: Run all four smokes against the local static preview**

Start the non-interactive preview in a dedicated terminal:

```bash
pnpm --filter @hereisit/web preview:test
```

It serves `http://127.0.0.1:4173`. If this preview is shown to the user, explicitly tell them to forward port `4173`.

From another terminal run:

```bash
node scripts/smoke-navigation.mjs http://127.0.0.1:4173
node scripts/smoke-image-watermark.mjs http://127.0.0.1:4173
node scripts/smoke-pdf-compress.mjs http://127.0.0.1:4173
node scripts/smoke-pdf-to-images.mjs http://127.0.0.1:4173
```

Expected: all commands exit 0; ordinary and ZIP downloads retain exact bytes/names; Web Share calls remain zero; there are no external/write/body/redirect/page-error violations.

- [ ] **Step 3: Review the final diff and commit any formatter-only change**

```bash
git diff --check
git status --short
git diff --stat origin/main...HEAD
git log --oneline origin/main..HEAD
```

Expected: only approved files changed and the worktree is clean. If `pnpm lint:fix` changed approved files after Task 7, stage only those files and commit:

```bash
git add -u
git commit -m "style: format download-only delivery changes"
```

Do not create an empty formatting commit.

- [ ] **Step 4: Push the branch and open the pull request**

```bash
git push -u origin fix/direct-download-default
gh pr create \
  --repo liorium/hereisit \
  --base main \
  --head fix/direct-download-default \
  --title "fix: make result delivery download only" \
  --body "Removes result Web Share behavior, makes every image/PDF/ZIP result action download directly, adds cross-browser regression coverage, and updates release smokes and active documentation."
gh pr checks --repo liorium/hereisit --watch
```

Expected: GitHub verify/browser jobs and the Cloudflare Pages preview check succeed for the exact branch HEAD.

- [ ] **Step 5: Run the four smokes against the immutable Cloudflare preview**

Open the successful Cloudflare Pages check for the exact branch HEAD and copy its immutable `pages.dev` origin into `CLOUDFLARE_PREVIEW_ORIGIN`. Then run:

```bash
node scripts/smoke-navigation.mjs "$CLOUDFLARE_PREVIEW_ORIGIN"
node scripts/smoke-image-watermark.mjs "$CLOUDFLARE_PREVIEW_ORIGIN"
node scripts/smoke-pdf-compress.mjs "$CLOUDFLARE_PREVIEW_ORIGIN"
node scripts/smoke-pdf-to-images.mjs "$CLOUDFLARE_PREVIEW_ORIGIN"
```

Expected: all four exact-HEAD preview smokes exit 0. Record only origin, SHA, command, and exit status; never record selected filenames, bytes, thumbnails, or object URLs.

- [ ] **Step 6: Merge, wait for Git deployment, and verify production**

```bash
gh pr merge --repo liorium/hereisit --squash
gh run list --repo liorium/hereisit --branch main --limit 5
```

Wait until GitHub CI and the Cloudflare Pages production check are green for the squash-merge SHA. Do not run `wrangler pages deploy` or create a Direct Upload project. Then run:

```bash
node scripts/smoke-navigation.mjs https://hereisit.pages.dev
node scripts/smoke-image-watermark.mjs https://hereisit.pages.dev
node scripts/smoke-pdf-compress.mjs https://hereisit.pages.dev
node scripts/smoke-pdf-to-images.mjs https://hereisit.pages.dev
```

Expected: all production smokes exit 0 and prove direct-only result delivery with zero Web Share calls.

- [ ] **Step 7: Hand off the completed release and next discussion**

Report the production URL, pull request, merge SHA, CI/Cloudflare status, browser projects actually run, local/preview/production smoke results, and the browser-native download UI caveat. Then begin a separate product-design discussion about how HereIsIt can differentiate beyond the referenced iLove tool ecosystem and monetize; do not mix that roadmap into this release.

# Image Compression Workbench Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the image-compression workbench's simultaneous three-panel UI with focused setup,
processing, and result screens that emphasize exact size reduction and direct download.

**Architecture:** Keep the existing `ImageCompressWorkbench` processing, cancellation, remote-handle,
and download lifecycle. Derive one visible screen from existing state, add one small pure module for
screen and aggregate-size calculations, and extend the existing bounded ZIP streamer so one batch action
can include local, original-retained, and remote results.

**Tech Stack:** React 19, Next.js 16 App Router, TypeScript 6, CSS Modules, Vitest 4, Playwright 1.61,
existing `fflate` 0.8.3

## Global Constraints

- A file must not leave the device unless the UI explicitly says so before the run action.
- Keep the existing `image.optimize@1` contract, codecs, limits, policy refresh, cleanup, and direct
  download behavior unchanged.
- Show only setup, processing, or result controls at one time.
- A single result must show input bytes, output bytes, reduction, and one dominant download action.
- A batch result must show aggregate input bytes, output bytes, reduction, and one dominant ZIP action.
- An original-retained result must show equal sizes and must not claim that compression succeeded.
- Never log file contents, filenames, thumbnails, or remote result URLs.
- Add no dependency, component library, state-machine package, icon package, or animation package.
- Preserve visible focus, live status announcements, reduced motion, and a 44 CSS-pixel minimum action
  height.
- Local disk is constrained. Run targeted unit, formatting, and type checks locally; use push-triggered
  CI for a fresh production build and the Playwright matrix instead of creating a local container build.

---

## File map

### Create

- `apps/web/src/lib/image-compress-presentation.ts` — pure screen selection and aggregate-size summary.
- `apps/web/src/lib/image-compress-presentation.test.ts` — deterministic tests for the presentation
  calculations.

### Modify

- `apps/web/src/components/image-compress-workbench.tsx` — state-specific setup, processing, and result
  rendering; persistent result byte lengths; reset and download presentation.
- `apps/web/src/components/image-compress-workbench.module.css` — single-column focused stage layout,
  disclosures, result typography, details, and responsive behavior.
- `apps/web/src/lib/remote-image-archive.ts` — allow the current bounded streaming ZIP builder to consume
  local `Blob` entries as well as remote handles.
- `apps/web/src/lib/remote-image-archive.test.ts` — verify local, remote, and mixed archive behavior.
- `tests/e2e/image-workbench.spec.ts` — local setup, processing, single-result, original-retained, and
  local batch behavior.
- `tests/e2e/image-compression-server.spec.ts` — server disclosure, progress replacement, remote result,
  mixed/partial batch, reset cleanup, mobile, and accessibility behavior.

No registry, contract, worker, codec, API, database, deployment, or package-manifest file changes.

---

### Task 1: Lock down presentation-state and size-summary calculations

**Files:**

- Create: `apps/web/src/lib/image-compress-presentation.ts`
- Create: `apps/web/src/lib/image-compress-presentation.test.ts`

**Interfaces:**

- Produces:
  - `deriveImageCompressScreen(input): "setup" | "processing" | "result"`
  - `summarizeImageCompression(entries): ImageCompressionSummary | null`
- Consumes: positive integer byte lengths from already validated `File` and result descriptors.

- [ ] **Step 1: Write the failing pure tests**

Create `apps/web/src/lib/image-compress-presentation.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  deriveImageCompressScreen,
  summarizeImageCompression,
} from "./image-compress-presentation";

describe("image compression presentation", () => {
  it("shows exactly one screen from existing workbench state", () => {
    expect(
      deriveImageCompressScreen({ processing: false, archiving: false, completedCount: 0 }),
    ).toBe("setup");
    expect(
      deriveImageCompressScreen({ processing: true, archiving: false, completedCount: 1 }),
    ).toBe("processing");
    expect(
      deriveImageCompressScreen({ processing: false, archiving: true, completedCount: 2 }),
    ).toBe("processing");
    expect(
      deriveImageCompressScreen({ processing: false, archiving: false, completedCount: 1 }),
    ).toBe("result");
  });

  it("aggregates only completed result byte pairs", () => {
    expect(
      summarizeImageCompression([
        { inputBytes: 437_125, outputBytes: 171_532 },
        { inputBytes: 1_000, outputBytes: 1_000 },
      ]),
    ).toEqual({
      count: 2,
      inputBytes: 438_125,
      outputBytes: 172_532,
      reductionPercent: 60.6,
    });
  });

  it("returns no summary for an empty set and never reports negative reduction", () => {
    expect(summarizeImageCompression([])).toBeNull();
    expect(summarizeImageCompression([{ inputBytes: 100, outputBytes: 120 }])).toEqual({
      count: 1,
      inputBytes: 100,
      outputBytes: 120,
      reductionPercent: 0,
    });
  });
});
```

- [ ] **Step 2: Run the test and verify the module is missing**

Run:

```bash
pnpm exec vitest run apps/web/src/lib/image-compress-presentation.test.ts
```

Expected: FAIL because `image-compress-presentation.ts` does not exist.

- [ ] **Step 3: Implement the minimum pure module**

Create `apps/web/src/lib/image-compress-presentation.ts`:

```ts
export type ImageCompressScreen = "setup" | "processing" | "result";

export interface ImageCompressionSummary {
  readonly count: number;
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly reductionPercent: number;
}

export function deriveImageCompressScreen(input: {
  readonly processing: boolean;
  readonly archiving: boolean;
  readonly completedCount: number;
}): ImageCompressScreen {
  if (input.processing || input.archiving) return "processing";
  return input.completedCount > 0 ? "result" : "setup";
}

export function summarizeImageCompression(
  entries: readonly { readonly inputBytes: number; readonly outputBytes: number }[],
): ImageCompressionSummary | null {
  if (entries.length === 0) return null;
  const inputBytes = entries.reduce((sum, entry) => sum + entry.inputBytes, 0);
  const outputBytes = entries.reduce((sum, entry) => sum + entry.outputBytes, 0);
  const rawReduction = inputBytes > 0 ? ((inputBytes - outputBytes) / inputBytes) * 100 : 0;
  return {
    count: entries.length,
    inputBytes,
    outputBytes,
    reductionPercent: Math.max(0, Math.round(rawReduction * 10) / 10),
  };
}
```

- [ ] **Step 4: Run the focused unit test**

Run:

```bash
pnpm exec vitest run apps/web/src/lib/image-compress-presentation.test.ts
```

Expected: 3 tests PASS.

- [ ] **Step 5: Run formatting and type checks for the new files**

Run:

```bash
pnpm exec biome check apps/web/src/lib/image-compress-presentation.ts apps/web/src/lib/image-compress-presentation.test.ts
pnpm --filter @hereisit/web typecheck
```

Expected: both commands exit 0.

- [ ] **Step 6: Commit the calculation contract**

```bash
git add apps/web/src/lib/image-compress-presentation.ts apps/web/src/lib/image-compress-presentation.test.ts
git commit -m "Add image compression presentation model"
```

---

### Task 2: Replace the three-panel setup and processing UI

**Files:**

- Modify: `apps/web/src/components/image-compress-workbench.tsx:37-279,656-812`
- Modify: `apps/web/src/components/image-compress-workbench.module.css:1-209`
- Modify: `tests/e2e/image-workbench.spec.ts:389-429`
- Modify: `tests/e2e/image-compression-server.spec.ts:104-154,280-330`

**Interfaces:**

- Consumes: `deriveImageCompressScreen()` from Task 1.
- Produces: mutually exclusive `setup` and `processing` regions with the existing selection, policy,
  preset, progress, and cancellation handlers.

- [ ] **Step 1: Change browser assertions first**

In `tests/e2e/image-compression-server.spec.ts`, replace the local disclosure/mobile expectations and
add a setup hierarchy check:

```ts
await expect(page.getByText("파일은 업로드하지 않고 이 기기에서 처리해요.")).toBeVisible();
await expect(page.getByRole("button", { name: "이미지 선택" })).toBeEnabled();
await expect(page.getByText("압축 설정 · 추천")).toBeVisible();
await expect(page.getByRole("radio", { name: /최소 용량/ })).not.toBeVisible();
await page.getByText("압축 설정 · 추천").click();
await expect(page.getByRole("radio", { name: /최소 용량/ })).toBeVisible();
await expect(page.getByRole("button", { name: "용량 줄이기" })).toBeDisabled();
```

In the configured-server progress test, assert that setup is replaced:

```ts
await page.getByRole("button", { name: "용량 줄이기" }).click();
await expect(page.getByRole("heading", { name: "이미지 압축 중" })).toBeVisible();
await expect(page.getByRole("button", { name: "이미지 선택" })).toHaveCount(0);
await expect(page.getByText("안전하게 업로드 중")).toBeVisible();
await expect(page.getByRole("button", { name: "중단" })).toBeVisible();
```

In `tests/e2e/image-workbench.spec.ts`, update local progress assertions to use the same stage heading,
phase text, and `중단` label.

- [ ] **Step 2: Record the expected failing integration assertions**

Do not run a stale `apps/web/out` preview. Commit the red browser assertions and rely on the final
push-triggered CI build in Task 5 to execute them against a freshly exported app. Locally, verify that
the old labels still exist and the new labels do not:

```bash
rg -n '압축할 이미지 선택|1\\. 이미지 선택|3\\. 결과|이미지 용량 줄이기 →' apps/web/src/components/image-compress-workbench.tsx
rg -n '이미지 선택|이미지 압축 중|압축 설정 · 추천' apps/web/src/components/image-compress-workbench.tsx
```

Expected before implementation: the first search finds the old JSX; the second does not find all three
new controls.

- [ ] **Step 3: Derive the screen and compact policy copy**

Import Task 1:

```ts
import { deriveImageCompressScreen } from "../lib/image-compress-presentation";
```

Use exact concise policy strings when policy resolution settles:

```ts
setPolicy({ state: "local", text: "파일은 업로드하지 않고 이 기기에서 처리해요." });

setPolicy({
  state: "server",
  text: "파일은 HereIsIt 처리 서버로 전송되며 작업 후 자동 삭제를 시도해요.",
});
```

Derive values without adding a second stage state:

```ts
const completed = items.filter((item) => item.status === "completed");
const screen = deriveImageCompressScreen({
  processing,
  archiving,
  completedCount: completed.length,
});
const totalInputBytes = items.reduce((sum, item) => sum + item.file.size, 0);
const activeItem = items.find((item) => item.status === "processing");
const settledCount = items.filter(
  (item) => item.status === "completed" || item.status === "failed",
).length;
const presetLabels: Record<Preset, string> = {
  recommended: "추천",
  smallest: "최소 용량",
  lossless: "무손실",
};
const runDisabled =
  actionableCount === 0 || policy.state === "checking" || archiving || remoteDeliveryBusy;
const handleFileInputChange = (event: ChangeEvent<HTMLInputElement>) => {
  const input = event.currentTarget;
  void chooseFiles(input.files).finally(() => {
    input.value = "";
  });
};
```

- [ ] **Step 4: Replace the setup JSX**

Render one focused setup section when `screen === "setup"`:

```tsx
{screen === "setup" ? (
  <section className={styles.stage} aria-labelledby="compress-setup-title">
    <h2 id="compress-setup-title">이미지 용량 줄이기</h2>
    <button
      type="button"
      className={styles.picker}
      disabled={!executionReady || busy}
      onClick={() => fileInputRef.current?.click()}
    >
      이미지 선택
    </button>
    <input
      ref={fileInputRef}
      className={styles.fileInput}
      type="file"
      accept="image/jpeg,image/png,image/webp"
      multiple
      disabled={!executionReady || busy}
      onChange={handleFileInputChange}
    />
    <p className={styles.limits}>JPG, PNG, WebP · 파일당 30MB · 최대 20개</p>
    {items.length > 0 ? (
      <p className={styles.selectionSummary}>
        {items.length === 1
          ? `${items[0]?.file.name} · ${formatBytes(totalInputBytes)}`
          : `${items.length}개 이미지 · ${formatBytes(totalInputBytes)}`}
      </p>
    ) : null}
    <p className={styles.disclosure} data-policy={policy.state}>
      {policy.state === "checking" ? "처리 방식을 확인하고 있어요." : policy.text}
      {policy.state === "server" ? <a href="/privacy">자세히</a> : null}
    </p>
    <details className={styles.settings}>
      <summary>압축 설정 · {presetLabels[preset]}</summary>
      <div className={styles.presets} role="radiogroup" aria-label="압축 프리셋">
        {(
          [
            ["recommended", "추천", "품질과 용량의 균형"],
            ["smallest", "최소 용량", "더 강한 시각적 압축"],
            ["lossless", "무손실", "픽셀을 바꾸지 않고 정리"],
          ] as const
        ).map(([value, label, detail]) => (
          <label key={value} data-selected={preset === value}>
            <input
              type="radio"
              name="compress-preset"
              value={value}
              checked={preset === value}
              onChange={() => changePreset(value)}
            />
            <strong>{label}</strong>
            <span>{detail}</span>
          </label>
        ))}
      </div>
    </details>
    <p role="status" aria-live="polite" data-testid="image-workbench-status">
      {message}
    </p>
    <button
      type="button"
      className={styles.primaryAction}
      disabled={runDisabled}
      onClick={() => void processItems()}
    >
      용량 줄이기
    </button>
  </section>
) : null}
```

Keep the existing `changePreset()` handler and PNG guidance directly below the expanded radio group. Do
not create a new file-selection abstraction.

- [ ] **Step 5: Replace the processing JSX**

Render only progress and cancellation when `screen === "processing"`:

```tsx
{screen === "processing" ? (
  <section className={styles.stage} aria-labelledby="compress-progress-title">
    <h2 id="compress-progress-title">이미지 압축 중</h2>
    <p className={styles.progressCount}>
      {Math.min(items.length, settledCount + 1)}/{items.length}
    </p>
    <p role="status" aria-live="polite" data-testid="image-workbench-status">
      {archiving ? "ZIP을 준비하고 있어요." : phaseLabel(activeItem?.phase ?? null)}
    </p>
    <progress value={activeItem?.fraction ?? undefined} max={1} />
    <button type="button" className={styles.secondaryAction} onClick={cancelProcessing}>
      중단
    </button>
  </section>
) : null}
```

`cancelProcessing` calls only the existing controller and batch cancellation:

```ts
const cancelProcessing = () => {
  processingControllerRef.current?.abort();
  batchRef.current?.cancel();
};
```

- [ ] **Step 6: Replace the three-column CSS with one focused stage**

Use the existing CSS module and remove `.grid`, `.panel`, `.fileList`, `.results`, and fixed mobile
`.stickyAction` rules. Add:

```css
.workbench {
  width: min(100% - 40px, 760px);
  margin: 0 auto 80px;
}

.stage {
  display: grid;
  gap: 18px;
  padding: clamp(20px, 4vw, 40px);
  border: 1px solid var(--line);
  border-radius: 24px;
  background: var(--surface, #fff);
}

.stage h2,
.stage p {
  margin: 0;
}

.picker {
  width: 100%;
  min-height: 160px;
  border: 1px dashed currentColor;
  border-radius: 18px;
  background: transparent;
  color: inherit;
  font-weight: 800;
}

.disclosure {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  color: var(--muted, #667085);
  font-size: 0.88rem;
}

.primaryAction,
.secondaryAction {
  min-height: 48px;
  border: 0;
  border-radius: 12px;
  font-weight: 800;
}

.primaryAction {
  background: #4057f4;
  color: #fff;
}

@media (max-width: 480px) {
  .workbench {
    width: calc(100% - 24px);
    margin-bottom: 56px;
  }

  .stage {
    gap: 16px;
    padding: 20px 16px 24px;
    border-radius: 18px;
  }

  .picker {
    min-height: 132px;
  }
}
```

Keep visible `:focus-visible`, disabled, preset-selected, and progress-width rules. Do not add a fixed
mobile footer.

- [ ] **Step 7: Run fast local checks**

```bash
pnpm exec biome check apps/web/src/components/image-compress-workbench.tsx apps/web/src/components/image-compress-workbench.module.css tests/e2e/image-workbench.spec.ts tests/e2e/image-compression-server.spec.ts
pnpm --filter @hereisit/web typecheck
pnpm exec vitest run apps/web/src/lib/image-compress-presentation.test.ts
```

Expected: all commands exit 0.

- [ ] **Step 8: Commit the focused setup and progress views**

```bash
git add apps/web/src/components/image-compress-workbench.tsx apps/web/src/components/image-compress-workbench.module.css tests/e2e/image-workbench.spec.ts tests/e2e/image-compression-server.spec.ts
git commit -m "Simplify image compression setup"
```

---

### Task 3: Add honest single-result size comparison and restart

**Files:**

- Modify: `apps/web/src/components/image-compress-workbench.tsx:43-60,289-576,656-812`
- Modify: `apps/web/src/components/image-compress-workbench.module.css`
- Modify: `tests/e2e/image-workbench.spec.ts:332-387`
- Modify: `tests/e2e/image-compression-server.spec.ts:280-430`

**Interfaces:**

- Consumes: `summarizeImageCompression()` from Task 1 and existing local/remote result descriptors.
- Produces: persistent `outputByteLength` per completed item, one single-result panel, original-retained
  copy, and `다른 이미지 압축`.

- [ ] **Step 1: Write result-first browser assertions**

Update the local photo test:

```ts
await page.getByRole("button", { name: "용량 줄이기" }).click();
await expect(page.getByRole("heading", { name: "압축 완료" })).toBeVisible({
  timeout: 20_000,
});
await expect(page.getByText(`${formatBytes(input.byteLength)} →`, { exact: false })).toBeVisible();
await expect(page.getByText(/% 줄였어요$/)).toBeVisible();
await expect(page.getByRole("button", { name: "결과 다운로드 ↓" })).toBeVisible();
await expect(page.getByText("압축 설정 · 추천")).toHaveCount(0);
```

Import `formatBytes` into the test only if the test already resolves the workspace alias; otherwise
assert the rendered `KB →` pattern and verify exact output bytes after download.

Update original-retained assertions:

```ts
await expect(page.getByRole("heading", { name: "원본 유지" })).toBeVisible();
await expect(page.getByText("이미 충분히 작아 원본을 유지했어요")).toBeVisible();
await expect(page.getByText("68B → 68B")).toBeVisible();
await expect(page.getByRole("button", { name: "원본 다운로드 ↓" })).toBeVisible();
```

Update the configured-server test to assert that the result screen contains no setup or progress
controls and that the exact result `content-length` appears in the size comparison.

- [ ] **Step 2: Verify old copy remains before implementation**

```bash
rg -n '원본 파일을 그대로 내려받습니다|결과 다운로드|suggestSameFormatOptimizedName' apps/web/src/components/image-compress-workbench.tsx
rg -n '이미 충분히 작아 원본을 유지했어요|다른 이미지 압축|outputByteLength' apps/web/src/components/image-compress-workbench.tsx
```

Expected: old copy is present; the new result model and restart action are absent.

- [ ] **Step 3: Persist output bytes independently of remote-handle consumption**

Add to `WorkItem`:

```ts
readonly outputByteLength?: number;
```

Set it in every completion branch:

```ts
outputByteLength: result.byteLength, // runLocal fulfilled branch
outputByteLength: completedResult.value.descriptor.byteLength, // onEvent remote fulfilled branch
outputByteLength: result.value.descriptor.byteLength, // settled remote fulfilled branch
outputByteLength: source.file.size, // remote original-retained branch
outputByteLength: item.file.size, // local original-retained branch
```

Use the source item found by ID for remote original-retained completion so it records
`source.file.size`. Keep `outputByteLength` when changing `{ kind: "remote" }` to
`{ kind: "remote-consumed" }`.

Reset `outputByteLength` together with `result` in `changePreset()` and restart.

- [ ] **Step 4: Build the result summary from completed items**

Import Task 1:

```ts
import {
  deriveImageCompressScreen,
  summarizeImageCompression,
} from "../lib/image-compress-presentation";
```

Derive only valid pairs:

```ts
const resultItems = completed.filter(
  (item): item is WorkItem & { readonly outputByteLength: number } =>
    item.outputByteLength !== undefined,
);
const resultSummary = summarizeImageCompression(
  resultItems.map((item) => ({
    inputBytes: item.file.size,
    outputBytes: item.outputByteLength,
  })),
);
```

Format the percentage without introducing another helper:

```ts
const reductionText =
  resultSummary === null
    ? null
    : `${resultSummary.reductionPercent.toFixed(1).replace(/\\.0$/, "")}% 줄였어요`;
```

- [ ] **Step 5: Add restart cleanup**

Add one local handler that uses the existing cleanup function:

```ts
const resetWorkbench = async () => {
  processingControllerRef.current?.abort();
  batchRef.current?.cancel();
  const previous = itemsRef.current;
  itemsRef.current = [];
  setItems([]);
  await disposeRemoteItems(previous);
  setMessage(
    policy.state === "checking"
      ? "처리 방식을 확인하고 있어요."
      : policy.state === "server"
        ? "서버 처리 정책을 확인했어요."
        : policy.text,
  );
};
```

The click handler uses `void resetWorkbench()`. It must not clear or recreate the anonymous session.

- [ ] **Step 6: Render the single-result and original-retained views**

Inside `screen === "result"`, branch on one `resultItem`:

```tsx
<section className={styles.resultStage} aria-labelledby="compress-result-title">
  <h2 id="compress-result-title">
    {resultItem.result?.kind === "original" ? "원본 유지" : "압축 완료"}
  </h2>
  <p className={styles.sizeComparison}>
    <span>{formatBytes(resultItem.file.size)}</span>
    <span aria-hidden="true">→</span>
    <span>{formatBytes(resultItem.outputByteLength)}</span>
  </p>
  <p className={styles.reduction}>
    {resultItem.result?.kind === "original"
      ? "이미 충분히 작아 원본을 유지했어요"
      : reductionText}
  </p>
  <p role="status" aria-live="polite" data-testid="image-workbench-status">
    {message}
  </p>
  <button className={styles.primaryAction} type="button" onClick={() => void downloadItem(resultItem)}>
    {resultItem.result?.kind === "original" ? "원본 다운로드 ↓" : "결과 다운로드 ↓"}
  </button>
  <button className={styles.textAction} type="button" onClick={() => void resetWorkbench()}>
    다른 이미지 압축
  </button>
</section>
```

Keep the existing disabled `다운로드 완료` state for consumed remote results.

- [ ] **Step 7: Add result typography without decorative UI**

```css
.resultStage {
  display: grid;
  gap: 18px;
  padding: clamp(24px, 5vw, 48px);
  text-align: center;
  border: 1px solid var(--line);
  border-radius: 24px;
  background: var(--surface, #fff);
}

.sizeComparison {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 0.4em;
  font-size: clamp(1.75rem, 6vw, 3rem);
  font-weight: 800;
  letter-spacing: -0.04em;
  font-variant-numeric: tabular-nums;
}

.reduction {
  color: #2f6b55;
  font-weight: 700;
}

.textAction {
  min-height: 44px;
  border: 0;
  background: transparent;
  color: var(--muted, #667085);
  text-decoration: underline;
  text-underline-offset: 3px;
}
```

- [ ] **Step 8: Run focused local checks**

```bash
pnpm exec biome check apps/web/src/components/image-compress-workbench.tsx apps/web/src/components/image-compress-workbench.module.css tests/e2e/image-workbench.spec.ts tests/e2e/image-compression-server.spec.ts
pnpm --filter @hereisit/web typecheck
pnpm exec vitest run apps/web/src/lib/image-compress-presentation.test.ts
```

Expected: all commands exit 0.

- [ ] **Step 9: Commit the single-result view**

```bash
git add apps/web/src/components/image-compress-workbench.tsx apps/web/src/components/image-compress-workbench.module.css tests/e2e/image-workbench.spec.ts tests/e2e/image-compression-server.spec.ts
git commit -m "Focus image compression results"
```

---

### Task 4: Support aggregate batch results and one mixed-source ZIP

**Files:**

- Modify: `apps/web/src/lib/remote-image-archive.ts:1-111`
- Modify: `apps/web/src/lib/remote-image-archive.test.ts:1-101`
- Modify: `apps/web/src/components/image-compress-workbench.tsx:576-654,656-812`
- Modify: `apps/web/src/components/image-compress-workbench.module.css`
- Modify: `tests/e2e/image-workbench.spec.ts:511-618`
- Modify: `tests/e2e/image-compression-server.spec.ts:560-625`

**Interfaces:**

- Renames: `buildRemoteImageArchive()` → `buildImageArchive()`.
- Produces: `ImageArchiveEntry`, accepting either a remote handle or a local `Blob`.
- Consumes: completed items with persistent `outputByteLength` from Task 3.

- [ ] **Step 1: Write mixed-archive unit tests first**

Update the import and add to `remote-image-archive.test.ts`:

```ts
import { unzipSync } from "fflate";
import { buildImageArchive } from "./remote-image-archive";

it("archives local and remote entries together and acknowledges only the remote result", async () => {
  const order: string[] = [];
  const remote = handle("remote", order);
  const archive = await buildImageArchive({
    entries: [
      { kind: "local", filename: "local.txt", blob: new Blob(["local"]) },
      { kind: "remote", filename: "remote.txt", handle: remote },
    ],
    byteBudget: 1_024,
  });
  const files = unzipSync(new Uint8Array(await archive.blob.arrayBuffer()));
  expect(new TextDecoder().decode(files["local.txt"])).toBe("local");
  expect(new TextDecoder().decode(files["remote.txt"])).toBe("remote");
  await archive.acknowledgeAfterHandoff();
  expect(order).toContain("ack:remote");
  archive.dispose();
});
```

Keep the existing budget, sequential streaming, duplicate-name, cancellation, and deferred
acknowledgement tests.

- [ ] **Step 2: Run the archive test and verify the new API is missing**

```bash
pnpm exec vitest run apps/web/src/lib/remote-image-archive.test.ts
```

Expected: FAIL because `buildImageArchive` and local entries are not implemented.

- [ ] **Step 3: Generalize the existing bounded archive loop**

In `remote-image-archive.ts`:

```ts
export type ImageArchiveEntry =
  | {
      readonly kind: "remote";
      readonly filename: string;
      readonly handle: RemoteDownloadHandle;
    }
  | {
      readonly kind: "local";
      readonly filename: string;
      readonly blob: Blob;
    };

export async function buildImageArchive(input: {
  readonly entries: readonly ImageArchiveEntry[];
  readonly byteBudget: number;
  readonly signal?: AbortSignal;
}): Promise<{
  readonly blob: Blob;
  acknowledgeAfterHandoff(): Promise<void>;
  dispose(): void;
}> {
```

Calculate the budget from `blob.size` or `handle.descriptor.byteLength`. In the existing sequential loop,
choose the stream source without buffering a second whole copy:

```ts
let part: RemoteArchivePart | null = null;
let byteLength: number;
let stream: ReadableStream<Uint8Array>;
if (source.kind === "remote") {
  part = await source.handle.fetchForArchive({
    remainingByteBudget: input.byteBudget - consumedBytes,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  currentPart = part;
  byteLength = part.byteLength;
  stream = part.stream;
} else {
  byteLength = source.blob.size;
  stream = source.blob.stream();
}
const reader = stream.getReader();
```

After reading an entry, append `() => part.acknowledge()` only when `part` is non-null, then set
`currentPart = null`. On failure, keep the existing `currentPart?.cancelStream()` and terminate the
existing `Zip`. Preserve sequential reads, deduplicated names, output chunk cleanup, and the current byte
budget.

- [ ] **Step 4: Run the archive unit tests**

```bash
pnpm exec vitest run apps/web/src/lib/remote-image-archive.test.ts
```

Expected: all archive tests PASS.

- [ ] **Step 5: Map every downloadable completed item to one archive entry**

Import the generalized type and builder:

```ts
import {
  buildImageArchive,
  type ImageArchiveEntry,
  remoteArchiveByteBudget,
} from "../lib/remote-image-archive";
```

Replace `remoteEntries` with:

```ts
const archiveEntries = resultItems.flatMap<ImageArchiveEntry>((item) => {
  const filename = suggestSameFormatOptimizedName(item.file.name, item.mime);
  if (item.result?.kind === "remote") {
    return [{ kind: "remote", filename, handle: item.result.handle }];
  }
  if (item.result?.kind === "local") {
    return [
      {
        kind: "local",
        filename,
        blob: new Blob([item.result.result.bytes], { type: item.result.result.mime }),
      },
    ];
  }
  if (item.result?.kind === "original") {
    return [{ kind: "local", filename, blob: item.file }];
  }
  return [];
});
```

Compute `archiveBytes` from each local `blob.size` or remote descriptor. Use `buildImageArchive()` in
the existing `downloadArchive()` lifecycle. Acknowledge and mark only remote entries consumed after
download handoff; local results remain individually downloadable:

```ts
const remoteArchiveIds = new Set(
  archiveEntries.flatMap((entry) =>
    entry.kind === "remote"
      ? [
          resultItems.find(
            (item) =>
              item.result?.kind === "remote" && item.result.handle === entry.handle,
          )?.id,
        ].filter((id): id is string => id !== undefined)
      : [],
  ),
);
const markRemoteArchiveEntriesConsumed = (itemMessage: string) => {
  setItems((current) =>
    current.map((item) =>
      remoteArchiveIds.has(item.id)
        ? { ...item, result: { kind: "remote-consumed" }, message: itemMessage }
        : item,
    ),
  );
};
```

Call `markRemoteArchiveEntriesConsumed("다운로드 완료")` only after the ZIP handoff and remote
acknowledgements complete. Keep the current handoff-uncertain message and consumption behavior when
browser activation occurred but acknowledgement fails.

- [ ] **Step 6: Render aggregate batch results with collapsed individual details**

Use the Task 3 `resultSummary`:

```tsx
<section className={styles.resultStage} aria-labelledby="compress-result-title">
  <h2 id="compress-result-title">{resultSummary.count}개 이미지 압축 완료</h2>
  <p className={styles.sizeComparison}>
    <span>{formatBytes(resultSummary.inputBytes)}</span>
    <span aria-hidden="true">→</span>
    <span>{formatBytes(resultSummary.outputBytes)}</span>
  </p>
  <p className={styles.reduction}>{reductionText}</p>
  {archiveEntries.length >= 2 && archiveBytes <= budget ? (
    <button className={styles.primaryAction} type="button" onClick={() => void downloadArchive()}>
      결과 {archiveEntries.length}개 ZIP 다운로드 ↓
    </button>
  ) : (
    <p>용량이 커서 개별 다운로드만 지원해요.</p>
  )}
  <details className={styles.individualResults} open={archiveBytes > budget}>
    <summary>파일별 결과 보기</summary>
    <ul>
      {items.map((item) => (
        <li key={item.id}>
          <div>
            <strong>{item.file.name}</strong>
            {item.outputByteLength === undefined ? (
              <span>{item.message}</span>
            ) : (
              <span>
                {formatBytes(item.file.size)} → {formatBytes(item.outputByteLength)}
              </span>
            )}
          </div>
          {item.status === "completed" &&
          item.result !== undefined &&
          item.result.kind !== "remote-consumed" ? (
            <button type="button" onClick={() => void downloadItem(item)}>
              {item.result.kind === "original" ? "원본 다운로드 ↓" : "결과 다운로드 ↓"}
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  </details>
</section>
```

Each row shows filename, `input → output`, current failure/original-retained copy, and the existing
individual download action when its result is valid. Do not render the list outside `<details>`.

- [ ] **Step 7: Update batch browser assertions**

For local and remote two-item tests:

```ts
await expect(page.getByRole("heading", { name: "2개 이미지 압축 완료" })).toBeVisible();
await expect(page.getByText(/KB → .*KB/)).toBeVisible();
await expect(page.getByRole("button", { name: "결과 2개 ZIP 다운로드 ↓" })).toBeVisible();
await expect(page.getByRole("button", { name: /개별 다운로드/ })).toHaveCount(0);
await page.getByText("파일별 결과 보기").click();
await expect(page.getByRole("button", { name: "결과 다운로드 ↓" })).toHaveCount(2);
```

Keep ZIP contents, retryable activation, remote acknowledgement, and no-Web-Share assertions. Add one
mixed-source test where one server result is retryable and falls back locally; its ZIP must contain both
expected names.

- [ ] **Step 8: Run focused local checks**

```bash
pnpm exec vitest run apps/web/src/lib/remote-image-archive.test.ts apps/web/src/lib/image-compress-presentation.test.ts
pnpm exec biome check apps/web/src/lib/remote-image-archive.ts apps/web/src/lib/remote-image-archive.test.ts apps/web/src/components/image-compress-workbench.tsx apps/web/src/components/image-compress-workbench.module.css tests/e2e/image-workbench.spec.ts tests/e2e/image-compression-server.spec.ts
pnpm --filter @hereisit/web typecheck
```

Expected: all commands exit 0.

- [ ] **Step 9: Commit aggregate results**

```bash
git add apps/web/src/lib/remote-image-archive.ts apps/web/src/lib/remote-image-archive.test.ts apps/web/src/components/image-compress-workbench.tsx apps/web/src/components/image-compress-workbench.module.css tests/e2e/image-workbench.spec.ts tests/e2e/image-compression-server.spec.ts
git commit -m "Add aggregate image compression results"
```

---

### Task 5: Close failure, accessibility, responsive, and CI verification

**Files:**

- Modify: `apps/web/src/components/image-compress-workbench.tsx`
- Modify: `apps/web/src/components/image-compress-workbench.module.css`
- Modify: `tests/e2e/image-workbench.spec.ts`
- Modify: `tests/e2e/image-compression-server.spec.ts`

**Interfaces:**

- Consumes: all completed presentation and archive behavior from Tasks 1-4.
- Produces: final recovery behavior and verification evidence for release.

- [ ] **Step 1: Add missing failure and restart assertions**

Cover these exact cases in the existing E2E specs:

```ts
await expect(page.getByText("다운로드를 시작하지 못했어요. 다시 시도해 주세요.")).toBeVisible();
await expect(page.getByRole("button", { name: "결과 다운로드 ↓" })).toBeVisible();

await page.getByRole("button", { name: "다른 이미지 압축" }).click();
await expect(page.getByRole("button", { name: "이미지 선택" })).toBeVisible();
await expect(page.getByRole("heading", { name: /압축 완료|원본 유지/ })).toHaveCount(0);
```

For a partial batch, assert that the summary counts only downloadable items, the individual disclosure
shows the failed filename and corrective error, and successful items remain downloadable.

For server restart, retain the existing assertion that an unconsumed remote result is disposed through
the job `DELETE` request.

- [ ] **Step 2: Add 320px, 390px, keyboard, and live-region assertions**

```ts
for (const width of [320, 390]) {
  await page.setViewportSize({ width, height: 720 });
  await page.goto("/image/compress");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  expect(
    (await page.getByRole("button", { name: "이미지 선택" }).boundingBox())?.height ?? 0,
  ).toBeGreaterThanOrEqual(44);
}

await page.keyboard.press("Tab");
await expect(page.getByRole("link", { name: "HereIsIt 홈" })).toBeFocused();
```

Tab until the image-selection action is reached, expand settings with the keyboard, and verify each
radio has a visible accessible name. During processing, assert the phase appears in the live status.
After completion, assert the result heading and size comparison precede the download action in DOM order.

- [ ] **Step 3: Make only the minimum corrective JSX/CSS changes**

Use inline status copy in the current stage; do not add toast, modal, skeleton library, or error page.
Ensure:

```css
.primaryAction:focus-visible,
.secondaryAction:focus-visible,
.textAction:focus-visible,
.picker:focus-visible,
.settings summary:focus-visible,
.individualResults summary:focus-visible {
  outline: 3px solid color-mix(in srgb, #4057f4 45%, transparent);
  outline-offset: 3px;
}

button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
```

Use `aria-live="polite"` for progress and results. Use an assertive role only for a terminal error that
prevents every selected item from completing.

- [ ] **Step 4: Run all focused local verification**

```bash
pnpm exec vitest run apps/web/src/lib/image-compress-presentation.test.ts apps/web/src/lib/remote-image-archive.test.ts apps/web/src/lib/local-image-optimize-fallback.test.ts
pnpm exec biome check apps/web/src/lib/image-compress-presentation.ts apps/web/src/lib/image-compress-presentation.test.ts apps/web/src/lib/remote-image-archive.ts apps/web/src/lib/remote-image-archive.test.ts apps/web/src/components/image-compress-workbench.tsx apps/web/src/components/image-compress-workbench.module.css tests/e2e/image-workbench.spec.ts tests/e2e/image-compression-server.spec.ts
pnpm --filter @hereisit/web typecheck
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit final UI verification changes**

```bash
git add apps/web/src/components/image-compress-workbench.tsx apps/web/src/components/image-compress-workbench.module.css tests/e2e/image-workbench.spec.ts tests/e2e/image-compression-server.spec.ts
git commit -m "Verify focused image compression flow"
```

- [ ] **Step 6: Push once and use the fresh CI build for the browser matrix**

```bash
git push origin main
gh run watch "$(gh run list --workflow CI --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
```

Expected: the push-triggered CI run succeeds, including production build and Playwright projects. Do not
run a local container build on the constrained disk.

- [ ] **Step 7: Verify the deployed preview at desktop and mobile**

Open the deployed compression route and check:

1. setup shows one selection-to-run path;
2. policy disclosure is visible before run;
3. processing replaces setup;
4. result replaces processing;
5. exact sizes and reduction are readable;
6. one result downloads directly;
7. a batch downloads as ZIP;
8. original-retained copy is honest;
9. 320px and 390px have no horizontal overflow.

Record the deployed URL and CI run ID in the handoff. Do not claim deployment success until both CI and
the live browser checks pass.

# Image Watermark Worker File I/O Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move image-watermark source and logo file reads from the UI realm into the dedicated Worker without changing output quality, public tool behavior, or privacy.

**Architecture:** Keep the existing bounded two-Worker scheduler and byte-based image pipeline. Replace only the internal tab-to-Worker input transport with an exact `{ name, mimeHint, byteLength, file }` envelope; the Worker validates and reads the native `File`, then constructs the existing byte input for the unchanged pipeline.

**Tech Stack:** TypeScript, native `File` structured clone, Web Workers, `OffscreenCanvas`, Vitest, Playwright in GitHub Actions.

## Global Constraints

- Keep `image.watermark@1`, its settings, result fields, output naming, format, quality, warnings, and download-only UX unchanged.
- Keep processing local; add no network request, server fallback, dependency, codec, or UI redesign.
- Keep the 100-item, 50MiB-per-source, 250MiB-batch, 10MiB-logo, 100MiB-per-result, and 500MiB-batch-result limits.
- Keep automatic concurrency at one Worker for unknown or at most 4GiB device memory and at most two Workers otherwise.
- Never log file contents, filenames, thumbnails, object URLs, or presigned URLs.
- Validate every Worker message and every post-read byte length at the Worker trust boundary.
- Do not run Playwright locally; the protected pull request runs Chromium, Firefox, WebKit, and mobile projects in GitHub Actions.

---

## File Map

- `packages/tool-contracts/src/index.ts` — defines the internal file-envelope type used by watermark Worker requests while preserving byte inputs used by the image pipeline.
- `packages/browser-runtime/src/run-image-watermark-batch.ts` — validates public batch inputs, schedules Workers, and sends native `File` envelopes without reading bytes.
- `packages/browser-runtime/src/image-watermark.worker.ts` — validates file envelopes, reads native files, converts them to the existing byte input, and owns source/logo read failures.
- `packages/browser-runtime/src/run-image-watermark-batch.test.ts` — proves the UI realm never reads source/logo bytes and preserves scheduling, result limits, and cancellation.
- `packages/browser-runtime/src/image-watermark.worker.test.ts` — proves source/logo reads, metadata validation, wrong-length rejection, cancellation, and pipeline handoff inside the Worker.
- `docs/architecture.md` — replaces the obsolete retained-logo-buffer description with the Worker-owned file-I/O boundary.

---

### Task 1: Move source image reads into the Worker

**Files:**
- Modify: `packages/tool-contracts/src/index.ts:374-450`
- Modify: `packages/browser-runtime/src/run-image-watermark-batch.ts:82-320,731-830`
- Modify: `packages/browser-runtime/src/image-watermark.worker.ts:35-175,342-430`
- Test: `packages/browser-runtime/src/run-image-watermark-batch.test.ts`
- Test: `packages/browser-runtime/src/image-watermark.worker.test.ts`

**Interfaces:**
- Consumes: public `ImageWatermarkBatchItem.file: File` and existing `ImageWatermarkInput` byte shape used by `processImageWatermarkPipeline()`.
- Produces: `ImageWatermarkWorkerFileInput = { name: string; mimeHint: string; byteLength: number; file: File }`; the `run` Worker request uses it while the pipeline keeps `ImageWatermarkInput`.

- [ ] **Step 1: Add a failing batch-runner test proving source bytes stay out of the UI realm**

Use a native file and spy on its read method:

```ts
it("dispatches the source File without reading it in the UI realm", async () => {
  installSupportedRuntime();
  const file = new File([pngBuffer(58)], "source.png", { type: "image/png" });
  const read = vi.spyOn(file, "arrayBuffer");
  const handle = runImageWatermarkBatch([item("source", file)], { concurrency: 1 });
  const worker = StubWorker.instances[0] as StubWorker;

  worker.emit(readyEvent());
  const posted = await waitForMessage(worker, "run");

  expect(read).not.toHaveBeenCalled();
  expect(posted.transfer).toEqual([]);
  expect(posted.message).toMatchObject({
    type: "run",
    input: {
      name: "source.png",
      mimeHint: "image/png",
      byteLength: 58,
      file,
    },
  });
  handle.cancel();
});
```

Update `fakeFile()` to construct a native `File` and override only `arrayBuffer` when a hostile read is required. Remove the fake global `File` class from `installSupportedRuntime()`.

- [ ] **Step 2: Add failing Worker tests for source success and trust-boundary failures**

Replace the Worker request helper with a native file envelope:

```ts
function workerFileInput(file = new File([Uint8Array.of(0x89, 0x50, 0x4e, 0x47)], "photo.png", {
  type: "image/png",
})) {
  return { name: file.name, mimeHint: file.type, byteLength: file.size, file };
}
```

Add focused cases:

```ts
it("reads a source File inside the Worker before pipeline handoff", async () => {
  const file = new File([Uint8Array.of(0x89, 0x50, 0x4e, 0x47)], "photo.png", {
    type: "image/png",
  });
  const read = vi.spyOn(file, "arrayBuffer");
  pipelineMocks.process.mockResolvedValue(result());
  const scope = await loadWorker();

  scope.dispatch(runRequest("job-file", { input: workerFileInput(file) }));
  await vi.waitFor(() => expect(pipelineMocks.process).toHaveBeenCalledOnce());

  expect(read).toHaveBeenCalledOnce();
  expect(pipelineMocks.process.mock.calls[0]?.[0]).toMatchObject({
    name: "photo.png",
    mimeHint: "image/png",
    byteLength: 4,
  });
  expect(new Uint8Array(pipelineMocks.process.mock.calls[0]?.[0].bytes)).toEqual(
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47),
  );
});

it.each([
  ["name", { name: "other.png" }],
  ["MIME", { mimeHint: "image/jpeg" }],
  ["size", { byteLength: 5 }],
])("rejects mismatched source %s metadata", async (_label, override) => {
  const scope = await loadWorker();
  scope.dispatch(runRequest("job-mismatch", {
    input: { ...workerFileInput(), ...override },
  }));
  await flushWorker();
  expect(terminalPosts(scope, "job-mismatch")).toMatchObject([
    { event: { type: "failed", error: { code: "INVALID_SPEC" } } },
  ]);
  expect(pipelineMocks.process).not.toHaveBeenCalled();
});
```

Add exact read-failure coverage:

```ts
it("maps a rejected source read to a retryable corrupt-input error", async () => {
  const file = new File([Uint8Array.of(1, 2, 3, 4)], "photo.png", { type: "image/png" });
  vi.spyOn(file, "arrayBuffer").mockRejectedValue(new DOMException("read failed", "NotReadableError"));
  const scope = await loadWorker();

  scope.dispatch(runRequest("job-unreadable", { input: workerFileInput(file) }));
  await vi.waitFor(() => expect(terminalPosts(scope, "job-unreadable")).toHaveLength(1));

  expect(terminalPosts(scope, "job-unreadable")).toMatchObject([
    { event: { type: "failed", error: { code: "CORRUPT_INPUT", retryable: true } } },
  ]);
  expect(pipelineMocks.process).not.toHaveBeenCalled();
});

it("rejects a source read whose returned length changed", async () => {
  const file = new File([Uint8Array.of(1, 2, 3, 4)], "photo.png", { type: "image/png" });
  vi.spyOn(file, "arrayBuffer").mockResolvedValue(new ArrayBuffer(5));
  const scope = await loadWorker();

  scope.dispatch(runRequest("job-wrong-length", { input: workerFileInput(file) }));
  await vi.waitFor(() => expect(terminalPosts(scope, "job-wrong-length")).toHaveLength(1));

  expect(terminalPosts(scope, "job-wrong-length")).toMatchObject([
    { event: { type: "failed", error: { code: "CORRUPT_INPUT", retryable: false } } },
  ]);
  expect(pipelineMocks.process).not.toHaveBeenCalled();
});

it("settles cancellation once while a source File read is pending", async () => {
  const pending = deferred<ArrayBuffer>();
  const file = new File([Uint8Array.of(1, 2, 3, 4)], "photo.png", { type: "image/png" });
  vi.spyOn(file, "arrayBuffer").mockReturnValue(pending.promise);
  const scope = await loadWorker();

  scope.dispatch(runRequest("job-reading", { input: workerFileInput(file) }));
  await flushWorker();
  scope.dispatch({ protocol: 1, type: "cancel", jobId: "job-reading" });
  pending.resolve(Uint8Array.of(1, 2, 3, 4).buffer);
  await flushWorker();

  expect(terminalPosts(scope, "job-reading")).toEqual([cancelledTerminalPost("job-reading")]);
  expect(pipelineMocks.process).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Run the focused tests to establish RED**

Run:

```bash
pnpm exec vitest run \
  packages/browser-runtime/src/run-image-watermark-batch.test.ts \
  packages/browser-runtime/src/image-watermark.worker.test.ts
```

Expected: FAIL because the runner still calls `arrayBuffer()`, the request contains `bytes`, and the Worker does not accept `file`.

- [ ] **Step 4: Add the internal Worker file-envelope contract**

Keep `ImageWatermarkInput` unchanged and add:

```ts
export interface ImageWatermarkWorkerFileInput {
  name: string;
  mimeHint: string;
  byteLength: number;
  file: File;
}
```

Change only the `type: "run"` branch of `ImageWatermarkWorkerRequest` to use `ImageWatermarkWorkerFileInput`. Leave `configure-logo` on `ImageWatermarkLogoInput` until Task 2.

- [ ] **Step 5: Send the native source File directly from the batch runner**

Make `CapturedFile` retain the native file instead of a read callback:

```ts
interface CapturedFile {
  name: string;
  mimeHint: string;
  size: number;
  file: File;
}

function captureFile(value: unknown): CapturedFile | undefined {
  if (typeof File === "undefined" || !(value instanceof File)) return undefined;
  try {
    const { name, type: mimeHint, size } = value;
    if (
      !isBoundedString(name, 1, MAX_INPUT_NAME_LENGTH) ||
      !isBoundedString(mimeHint, 0, MAX_MIME_HINT_LENGTH) ||
      !Number.isSafeInteger(size)
    ) return undefined;
    return { name, mimeHint, size, file: value };
  } catch {
    return undefined;
  }
}
```

Remove source `read()` and `validatedReadBuffer()` use from `assignNext()`. Post this request without a transfer list:

```ts
const request: ImageWatermarkWorkerRequest = {
  protocol: WORKER_PROTOCOL_VERSION,
  type: "run",
  jobId,
  tool: IMAGE_WATERMARK_TOOL_ID,
  toolVersion: IMAGE_WATERMARK_TOOL_VERSION,
  input: {
    name: captured.name,
    mimeHint: captured.mimeHint,
    byteLength: captured.size,
    file: captured.file,
  },
  spec: captured.spec,
  ...(captured.needsLogo ? { logoAssetId } : {}),
};
slot.state = "running";
slot.worker.postMessage(request);
```

Remove the now-unused `reading` slot state after all source-read branches are gone.

- [ ] **Step 6: Validate and read the source File inside the Worker**

Add exact envelope parsing:

```ts
function parseFileInput(value: unknown, maximumBytes: number): ImageWatermarkWorkerFileInput | undefined {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["name", "mimeHint", "byteLength", "file"])) {
    return undefined;
  }
  const { name, mimeHint, byteLength, file } = value;
  if (
    typeof File === "undefined" ||
    !(file instanceof File) ||
    !isBoundedString(name, 1, MAX_INPUT_NAME_LENGTH) ||
    !isBoundedString(mimeHint, 0, MAX_MIME_HINT_LENGTH) ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 1 ||
    byteLength > maximumBytes ||
    file.name !== name ||
    file.type !== mimeHint ||
    file.size !== byteLength
  ) return undefined;
  return { name, mimeHint, byteLength, file };
}
```

Add `readFileInput(input, signal)` that calls `input.file.arrayBuffer()`, checks cancellation, ordinary `ArrayBuffer`, and exact length, then returns the existing byte-based `ImageWatermarkInput`. Throw `ImageWatermarkPipelineError("CORRUPT_INPUT", ..., true)` on read rejection and the same code with `retryable: false` on a malformed return.

In `startRun()`, report the existing validating phase before the read, then read before `processImageWatermarkPipeline()`:

```ts
postProgress(job, sequence, "validating", 0.01);
sequence += 1;
const byteInput = await readFileInput(request.input, job.controller.signal);
const output = await processImageWatermarkPipeline(
  byteInput,
  spec,
  logo,
  report,
  job.controller.signal,
);
```

If a valid job ID has an invalid `run` envelope, call `invalidRun(jobId)` instead of waiting for the watchdog.

- [ ] **Step 7: Run the focused tests and typecheck**

Run:

```bash
pnpm exec vitest run \
  packages/browser-runtime/src/run-image-watermark-batch.test.ts \
  packages/browser-runtime/src/image-watermark.worker.test.ts
pnpm typecheck
```

Expected: all focused tests and all package typechecks PASS.

- [ ] **Step 8: Commit the source-file transport**

```bash
git add packages/tool-contracts/src/index.ts \
  packages/browser-runtime/src/run-image-watermark-batch.ts \
  packages/browser-runtime/src/run-image-watermark-batch.test.ts \
  packages/browser-runtime/src/image-watermark.worker.ts \
  packages/browser-runtime/src/image-watermark.worker.test.ts
git commit -m "perf: read watermark sources inside Worker"
```

---

### Task 2: Move logo reads into the Worker and remove retained UI buffers

**Files:**
- Modify: `packages/tool-contracts/src/index.ts:381,430-445`
- Modify: `packages/browser-runtime/src/run-image-watermark-batch.ts:576-880,1120-1170`
- Modify: `packages/browser-runtime/src/image-watermark.worker.ts:40-330`
- Test: `packages/browser-runtime/src/run-image-watermark-batch.test.ts`
- Test: `packages/browser-runtime/src/image-watermark.worker.test.ts`
- Modify: `docs/architecture.md:71-82,190-200`

**Interfaces:**
- Consumes: `ImageWatermarkWorkerFileInput` and `readFileInput()` from Task 1.
- Produces: both `configure-logo` and `run` Worker requests use the same file envelope; no source/logo byte buffer remains in the batch runner.

- [ ] **Step 1: Add a failing runner test proving logo bytes stay out of the UI realm**

```ts
it("dispatches the logo File to every Worker without reading it in the UI realm", async () => {
  installSupportedRuntime({ deviceMemory: 8, cores: 8 });
  const logo = new File([pngBuffer(58)], "logo.png", { type: "image/png" });
  const read = vi.spyOn(logo, "arrayBuffer");
  const handle = runImageWatermarkBatch(
    [item("one", undefined, logoSpec), item("two", undefined, logoSpec)],
    { concurrency: 2, logoFile: logo },
  );

  for (const worker of StubWorker.instances) worker.emit(readyEvent());
  const messages = await Promise.all(
    StubWorker.instances.map((worker) => waitForMessage(worker, "configure-logo")),
  );

  expect(read).not.toHaveBeenCalled();
  expect(messages.every(({ transfer }) => transfer.length === 0)).toBe(true);
  expect(messages.map(({ message }) => (message as { input: unknown }).input)).toEqual([
    { name: "logo.png", mimeHint: "image/png", byteLength: 58, file: logo },
    { name: "logo.png", mimeHint: "image/png", byteLength: 58, file: logo },
  ]);
  handle.cancel();
});
```

- [ ] **Step 2: Add failing Worker tests for logo read success and failure**

Add exact success and failure cases to `image-watermark.worker.test.ts`:

```ts
it("reads and prepares a logo File inside the Worker", async () => {
  const file = new File([Uint8Array.of(1, 2, 3, 4)], "logo.png", { type: "image/png" });
  const read = vi.spyOn(file, "arrayBuffer");
  pipelineMocks.prepareLogo.mockResolvedValue(preparedLogo("logo"));
  const scope = await loadWorker();

  scope.dispatch(configureRequest("asset-file", { input: workerFileInput(file) }));
  await vi.waitFor(() => expect(pipelineMocks.prepareLogo).toHaveBeenCalledOnce());

  expect(read).toHaveBeenCalledOnce();
  expect(new Uint8Array(pipelineMocks.prepareLogo.mock.calls[0]?.[0].bytes)).toEqual(
    Uint8Array.of(1, 2, 3, 4),
  );
  expect(logoTerminalPosts(scope, "asset-file")).toMatchObject([
    { event: { type: "logo-ready" } },
  ]);
});

it.each([
  ["rejected read", () => Promise.reject(new DOMException("read failed", "NotReadableError")), true],
  ["changed length", () => Promise.resolve(new ArrayBuffer(5)), false],
])("rejects a logo %s without caching it", async (_label, makeReadResult, retryable) => {
  const file = new File([Uint8Array.of(1, 2, 3, 4)], "logo.png", { type: "image/png" });
  vi.spyOn(file, "arrayBuffer").mockImplementation(makeReadResult);
  const scope = await loadWorker();

  scope.dispatch(configureRequest("asset-bad", { input: workerFileInput(file) }));
  await vi.waitFor(() => expect(logoTerminalPosts(scope, "asset-bad")).toHaveLength(1));

  expect(logoTerminalPosts(scope, "asset-bad")).toMatchObject([
    { event: { type: "logo-failed", error: { code: "CORRUPT_INPUT", retryable } } },
  ]);
  expect(pipelineMocks.prepareLogo).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Run the focused tests to establish RED**

```bash
pnpm exec vitest run \
  packages/browser-runtime/src/run-image-watermark-batch.test.ts \
  packages/browser-runtime/src/image-watermark.worker.test.ts
```

Expected: FAIL because the runner still reads and copies the logo buffer and the Worker still expects logo `bytes`.

- [ ] **Step 4: Switch logo requests to the file envelope**

Change the `configure-logo` request input in `ImageWatermarkWorkerRequest` to `ImageWatermarkWorkerFileInput` while keeping `ImageWatermarkLogoInput` as the byte shape consumed by `prepareImageWatermarkLogo()`.

In `configureLogo()`, call `readFileInput(request.input, configuration.controller.signal)` before `prepareImageWatermarkLogo()`. Reuse the existing error mapping and logo cleanup paths.

If a valid asset ID has an invalid `configure-logo` envelope, call `invalidLogo(assetId)` immediately.

- [ ] **Step 5: Remove retained logo bytes and send the native File from the runner**

Delete these runner members and helpers:

```ts
let logoReadStarted = false;
let retainedLogo: Uint8Array | undefined;
const releaseLogo = ...;
const beginLogoRead = ...;
```

Make `configureLogo()` post the captured file envelope without a transfer list:

```ts
input: {
  name: capturedLogo.name,
  mimeHint: capturedLogo.mimeHint,
  byteLength: capturedLogo.size,
  file: capturedLogo.file,
},
```

On Worker readiness, set the slot to `ready` and call `configureLogo(slot)` directly. Remove every `releaseLogo()` terminal call because the runner no longer owns logo bytes.

- [ ] **Step 6: Update architecture and privacy documentation**

Replace the old runner-read paragraph with:

```md
The runner structured-clones each validated source/logo `File` to an active Worker without reading or
retaining its bytes in the UI realm. Each Worker validates the envelope against the native `File`, reads
and length-checks it, decodes one reusable logo bitmap, and closes that bitmap when the Worker is
replaced, cancelled, fails, or finishes.
```

Update the privacy bullet to state that source/logo `File` handles move only to dedicated Workers, only Workers read the bytes, and no object URL, remote decoder, upload, or server fallback is used.

- [ ] **Step 7: Run focused tests, typecheck, and static documentation checks**

```bash
pnpm exec vitest run \
  packages/browser-runtime/src/run-image-watermark-batch.test.ts \
  packages/browser-runtime/src/image-watermark.worker.test.ts \
  packages/browser-runtime/src/image-watermark-pipeline.test.ts
pnpm typecheck
git diff --check
! rg -n "retainedLogo|logoReadStarted|beginLogoRead|captured\.read\(\)" \
  packages/browser-runtime/src/run-image-watermark-batch.ts
```

Expected: all tests and typechecks PASS; the legacy-buffer search returns no matches.

- [ ] **Step 8: Commit logo transport and documentation**

```bash
git add packages/tool-contracts/src/index.ts \
  packages/browser-runtime/src/run-image-watermark-batch.ts \
  packages/browser-runtime/src/run-image-watermark-batch.test.ts \
  packages/browser-runtime/src/image-watermark.worker.ts \
  packages/browser-runtime/src/image-watermark.worker.test.ts \
  docs/architecture.md
git commit -m "perf: read watermark logos inside Worker"
```

---

### Task 3: Verify, publish, deploy, and clean up

**Files:**
- Inspect: all files changed since `origin/main`
- Test: repository verification and hosted browser matrix

**Interfaces:**
- Consumes: completed Worker-owned source/logo transport from Tasks 1 and 2.
- Produces: a merged protected-branch change with passing CI, Cloudflare Pages, processing staging deployment, and a clean synchronized local `main`.

- [ ] **Step 1: Run the complete non-browser verification locally**

```bash
pnpm verify
```

Expected: lint, typecheck, unit tests, Worker tests, image-engine fuzz, builds, and export checks PASS. Do not run local Playwright.

- [ ] **Step 2: Inspect the complete change**

```bash
git diff --stat origin/main...HEAD
git diff --name-status origin/main...HEAD
git diff --check origin/main...HEAD
git status --short
```

Expected: only the approved design/plan, contracts, watermark runner/Worker/tests, and architecture documentation are changed; no generated output or unrelated file is present.

- [ ] **Step 3: Push and open the pull request**

```bash
git push -u origin agent/image-watermark-worker-io
```

Create `/tmp/hereisit-image-watermark-worker-io-pr.md` with `apply_patch` using this exact body:

```md
## 변경 내용

- 이미지 워터마크 원본과 로고 파일을 전용 Worker에서 읽도록 변경했습니다.
- Worker가 파일 봉투와 실제 파일 메타데이터 및 읽은 바이트 길이를 다시 검증합니다.
- 기존 합성·인코딩·다운로드 동작과 처리 한도는 유지했습니다.

## 효과

UI 영역이 원본·로고 바이트를 읽거나 보관하지 않아 대용량·다중 이미지 처리 중 메모리 압력과 화면 멈춤 가능성을 줄입니다.

## 검증

- Worker 파일 읽기와 신뢰 경계 단위 테스트
- 배치 순서·오류·취소·메모리 한도 회귀 테스트
- `pnpm verify`
```

Then run:

```bash
gh pr create --base main --head agent/image-watermark-worker-io \
  --title "perf: keep watermark file reads off UI thread" \
  --body-file /tmp/hereisit-image-watermark-worker-io-pr.md
```

Delete `/tmp/hereisit-image-watermark-worker-io-pr.md` with `apply_patch` immediately after PR creation.

- [ ] **Step 4: Wait for all protected pull-request checks**

```bash
gh pr checks --watch --fail-fast
```

Expected: `verify`, `browser`, and `Cloudflare Pages` PASS. The browser job must cover Chromium, Firefox, WebKit, mobile Chromium, mobile Firefox, mobile WebKit, and the product-analytics subset.

- [ ] **Step 5: Merge and verify the main-branch release**

```bash
gh pr merge --squash --delete-branch
git fetch origin --prune
git switch main
git pull --ff-only
```

Wait for the merge commit's `verify`, `Cloudflare Pages`, and `Deploy successful main CI commit to staging` checks. `browser` is expected to be skipped on the main push because the protected PR already ran it.

- [ ] **Step 6: Remove disposable task state and report exact evidence**

```bash
git branch --list 'agent/image-watermark-worker-io'
git stash list
git status --short --branch
docker system df
```

Expected: the task branch is absent after confirmed squash merge, there is no task stash, local `main` equals `origin/main`, and no task-created Docker container, image, or build cache remains. Preserve shared browser caches and unrelated active worktrees.

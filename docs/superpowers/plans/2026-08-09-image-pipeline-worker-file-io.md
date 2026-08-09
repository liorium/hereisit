# Common Image Pipeline Worker File I/O Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the common image Worker own source-file reads so resize, conversion, and the smart-compression batch stage no longer allocate their transfer buffer in the UI realm.

**Architecture:** The UI batch runner sends an exact `{ name, mimeHint, byteLength, file }` envelope with a native `File`. The existing image Worker validates and reads it, converts it to the unchanged byte-based pipeline input, and returns the existing result contract. Runtime validation, cancellation, limits, codecs, output behavior, and public UI remain unchanged except for removing the UI-realm read.

**Tech Stack:** TypeScript 6, native Web Workers, native `File` structured clone, `ArrayBuffer`, Zod contracts, Vitest, Next.js, GitHub Actions, Cloudflare Pages.

## Global Constraints

- Keep `image.pipeline` at tool version `2`; its settings, result fields, output naming, format, quality, warnings, timings, and download-only UX remain unchanged.
- Keep processing local; add no network request, server fallback, dependency, codec, or UI redesign.
- Keep the 50MiB-per-input, 50,000,000-input-pixel, 16,384-dimension, 25,000,000-output-pixel, 100MiB-per-result, 500MiB-batch-result, two-Worker, and 180-second job limits.
- Keep automatic concurrency at one Worker for unknown or at most 4GiB device memory and at most two Workers otherwise.
- Keep the initial image-compression selection read and lossless local metadata processing out of scope; only remove the additional common-batch UI read.
- Never log file contents, filenames, thumbnails, object URLs, generated URLs, or Worker payloads.
- Validate every Worker request, native file envelope, post-read byte length, and terminal result byte buffer at its trust boundary.
- Do not run Playwright locally; the protected pull request runs Chromium, Firefox, WebKit, mobile Chromium, mobile Firefox, mobile WebKit, and product analytics in GitHub Actions.

---

## File Map

- `packages/tool-contracts/src/index.ts` — defines one shared native-File Worker envelope while retaining public `BatchImageItem` and byte-pipeline inputs.
- `packages/browser-runtime/src/run-image-batch.ts` — schedules Workers, sends native Files without reading them, validates Worker events/results, and owns batch limits/cancellation.
- `packages/browser-runtime/src/run-image-batch.test.ts` — proves UI-realm non-reading, structured clone shape, scheduling, limits, crashes, and cancellation.
- `packages/browser-runtime/src/image.worker.ts` — validates requests, reads native Files, checks returned bytes, and calls the existing pipeline.
- `packages/browser-runtime/src/image.worker.test.ts` — proves hostile-boundary, read, error, concurrency, and cancellation behavior.
- `tests/e2e/image-workbench.spec.ts` — keeps controlled image Worker doubles on the native-File envelope used by protected browser CI.
- `docs/architecture.md` — records the common image Worker file-I/O boundary and the compression exceptions.

### Task 1: Send native source Files from the batch runner

**Files:**
- Modify: `packages/tool-contracts/src/index.ts:281-324`
- Modify: `packages/browser-runtime/src/run-image-batch.ts:1-280`
- Modify: `packages/browser-runtime/src/run-image-batch.test.ts:1-131`

**Interfaces:**
- Consumes: existing `BatchImageItem`, `ImagePipelineSpec`, `WorkerEvent`, and `processImagePipeline()` result contract.
- Produces: `WorkerFileInput`, `ImageWorkerFileInput`, and an `ImageRunRequest.input` containing a native `File`; Task 2 consumes that request.

- [ ] **Step 1: Replace duck-typed test files with tiny native Files and record posted transfers**

Use a native file helper so the regression test exercises structured clone semantics. The Worker stub must retain both message and transfer list:

```ts
function fakeFile(name: string, bytes = Uint8Array.of(1, 2, 3)): File {
  return new File([bytes], name, { type: "image/png" });
}

interface PostedRequest {
  request: WorkerRequest;
  transfer: readonly Transferable[];
}

postMessage(request: WorkerRequest, transfer: readonly Transferable[] = []): void {
  this.posts.push({ request, transfer });
  // Existing completion behavior follows.
}
```

- [ ] **Step 2: Write the failing UI-realm non-read test**

Add a test with a real `File`, spy on `arrayBuffer`, start one item, and inspect the Worker post:

```ts
it("posts the native source File without reading it in the UI realm", async () => {
  installRuntime(CompletingWorker);
  const file = fakeFile("private.png");
  const read = vi.spyOn(file, "arrayBuffer");
  const handle = runImageBatch([{ itemId: "one", file, spec }], { concurrency: 1 });
  const worker = CompletingWorker.created[0] as CompletingWorker;
  const posted = worker.posts.find(({ request }) => request.type === "run");

  expect(read).not.toHaveBeenCalled();
  expect(posted?.transfer).toEqual([]);
  expect(posted?.request).toMatchObject({
    type: "run",
    input: { name: "private.png", mimeHint: "image/png", byteLength: 3, file },
  });
  handle.cancel();
  await handle.result;
});
```

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
pnpm exec vitest run packages/browser-runtime/src/run-image-batch.test.ts
```

Expected: FAIL because `file.arrayBuffer()` is called, `input.bytes` is posted, and the buffer is transferred.

- [ ] **Step 4: Add one shared native-File envelope type without changing the public pipeline version**

In `packages/tool-contracts/src/index.ts`, use one shape for both image Workers:

```ts
export interface WorkerFileInput {
  name: string;
  mimeHint: string;
  byteLength: number;
  file: File;
}

export type ImageWorkerFileInput = WorkerFileInput;
export type ImageWatermarkWorkerFileInput = WorkerFileInput;
```

Change only `ImageRunRequest.input`:

```ts
export interface ImageRunRequest {
  protocol: 1;
  type: "run";
  jobId: string;
  tool: "image.pipeline";
  toolVersion: typeof IMAGE_TOOL_VERSION;
  input: ImageWorkerFileInput;
  spec: ImagePipelineSpec;
}
```

Do not change `IMAGE_TOOL_VERSION`, `BatchImageItem`, `ImagePipelineResult`, or byte-based pipeline inputs.

- [ ] **Step 5: Replace the batch runner read with a synchronous native-File envelope**

Require `File` in runtime support, remove `WorkerSlot.generation`, remove the `async`/`await` and transfer list from `assignNext()`, then post:

```ts
function assignNext(slot: WorkerSlot): void {
  if (cancelled || settled || slot.itemIndex !== undefined || nextIndex >= items.length) return;
  const index = nextIndex++;
  const item = items[index];
  if (item === undefined) return;
  slot.itemIndex = index;
  slot.jobId = makeJobId(item.itemId);
  armSlotTimeout(slot);
  const request: WorkerRequest = {
    protocol: WORKER_PROTOCOL_VERSION,
    type: "run",
    jobId: slot.jobId,
    tool: IMAGE_TOOL_ID,
    toolVersion: IMAGE_TOOL_VERSION,
    input: {
      name: item.file.name,
      mimeHint: item.file.type,
      byteLength: item.file.size,
      file: item.file,
    },
    spec: item.spec,
  };
  try {
    slot.worker.postMessage(request);
  } catch {
    replaceCrashedWorker(slot, WORKER_FAILURE_ERROR);
  }
}
```

Use the existing Korean Worker failure copy. Do not read bytes in a fallback branch.

- [ ] **Step 6: Add runner regression cases for scheduling, trust boundaries, and cancellation**

Add focused cases proving:

```ts
expect(firstRead).not.toHaveBeenCalled();
expect(secondRead).not.toHaveBeenCalled();
expect(worker.posts.filter(({ request }) => request.type === "run")).toHaveLength(2);
```

Also cancel immediately after dispatch, emit a late completion from the stub, and assert one cancelled result with no later `item-complete` event. Preserve one Worker when `deviceMemory` is absent, maximum two Workers otherwise, output ordering, timeout replacement, and 500MiB aggregate-result rejection.

Change the test result helper so `bytes.byteLength === byteLength`; then add malformed correlated events for a non-ordinary buffer, declared/actual length mismatch, `100MiB + 1` result, invalid MIME, unsafe name, invalid warning, negative timing, regressive sequence, and invalid public failure payload. A malformed event must reject the active item with sanitized `WORKER_CRASH` and replace that slot rather than waiting for timeout. A well-formed result over 100MiB uses `MEMORY_LIMIT`; a well-formed aggregate over 500MiB preserves the existing batch error.

Implement local validators in `run-image-batch.ts`; do not add a utility module:

```ts
function parseWorkerEvent(value: unknown): ParsedWorkerEvent | undefined;
function parsePipelineResult(value: unknown): ImagePipelineResult | undefined;
function parseToolError(value: unknown): ToolErrorPayload | undefined;
```

Require plain records with exact enumerable string keys, safe IDs/text, known MIME/phase/warning/error values, nonnegative finite timings, positive safe dimensions/attempt counts, an ordinary own-key-free `ArrayBuffer`, and actual/declared result length equality. Add `lastSequence = -1` and `lastFraction = 0` per slot, reset them on assignment, and reject malformed or regressive correlated events. Do not inspect or log file names or byte contents.

- [ ] **Step 7: Run Task 1 checks and commit**

Run:

```bash
pnpm exec vitest run packages/browser-runtime/src/run-image-batch.test.ts packages/tool-contracts/src/index.test.ts
pnpm typecheck
git diff --check
```

Expected: all PASS and `rg -n 'item\.file\.arrayBuffer\(' packages/browser-runtime/src/run-image-batch.ts` returns no matches.
Also search every `image.pipeline` Worker double and `input.bytes` consumer; update only controlled image Worker doubles to consume the exact native-File envelope. Do not run Playwright locally.

Commit:

```bash
git add packages/tool-contracts/src/index.ts \
  packages/browser-runtime/src/run-image-batch.ts \
  packages/browser-runtime/src/run-image-batch.test.ts
git commit -m "perf: send image sources directly to Worker"
```

### Task 2: Validate and read the File inside the image Worker

**Files:**
- Create: `packages/browser-runtime/src/image.worker.test.ts`
- Modify: `packages/browser-runtime/src/image.worker.ts:1-87`

**Interfaces:**
- Consumes: Task 1 `ImageWorkerFileInput` inside `ImageRunRequest` and existing `processImagePipeline(input, spec, report)`.
- Produces: validated byte input `{ name, mimeHint, byteLength, bytes }` and the unchanged `WorkerEvent` stream.

- [ ] **Step 1: Build a real Worker-scope test harness and mock only the existing pipeline seam**

Create a `StubWorkerScope` with `postMessage()` and `dispatch()`. Mock `processImagePipeline` and `ImagePipelineError`, not `File.arrayBuffer()` globally:

```ts
const pipelineMocks = vi.hoisted(() => ({
  process: vi.fn(),
  PipelineError: class extends Error {
    constructor(
      readonly code: ToolErrorPayload["code"],
      message: string,
      readonly retryable = false,
    ) {
      super(message);
    }
  },
}));

vi.mock("./image-pipeline", () => ({
  processImagePipeline: pipelineMocks.process,
  ImagePipelineError: pipelineMocks.PipelineError,
}));
```

Reset modules and globals around each test, stub `self`, import `./image.worker`, and retain posted events and transfer lists.

- [ ] **Step 2: Write failing success and trust-boundary tests**

Use a request helper with exact keys:

```ts
function runRequest(file = new File([Uint8Array.of(1, 2, 3)], "photo.png", {
  type: "image/png",
})): Record<string, unknown> {
  return {
    protocol: 1,
    type: "run",
    jobId: "job-1",
    tool: "image.pipeline",
    toolVersion: 2,
    input: { name: file.name, mimeHint: file.type, byteLength: file.size, file },
    spec,
  };
}
```

Add tests that expect:

- pipeline receives an ordinary `ArrayBuffer` containing the File bytes;
- exact-shaped input with a non-native `file` is `INVALID_SPEC`;
- extra request/input keys, hostile prototypes, and throwing getters do not escape the handler;
- name, MIME, and declared-size mismatches fail as `INVALID_SPEC` before pipeline use; actual metadata-matching empty and `50MiB + 1` native Files fail as non-retryable `MEMORY_LIMIT` before reading;
- valid job IDs receive exactly one terminal event.

- [ ] **Step 3: Write failing read-error, wrong-buffer, concurrency, and cancellation tests**

Create native Files with an own `arrayBuffer` method for controlled failures:

```ts
Object.defineProperty(file, "arrayBuffer", {
  value: vi.fn().mockRejectedValue(new Error("PRIVATE_READ_FAILURE")),
});
```

Expect public errors never to contain the private string. Add separate cases for a prototype-null `ArrayBuffer`, a valid buffer with a changed length, a second run while one read is pending, and cancellation before the deferred read resolves. Cancellation must create one `CANCELLED` terminal event and no pipeline call or later completion.

- [ ] **Step 4: Run Worker tests and verify RED**

Run:

```bash
pnpm exec vitest run packages/browser-runtime/src/image.worker.test.ts
```

Expected: FAIL because the current Worker passes the File envelope directly to the byte pipeline and lacks runtime parsing/read/cancellation ownership.

- [ ] **Step 5: Add minimal exact-envelope parsing and Worker-owned file reading**

Implement local helpers in `image.worker.ts`; do not create another module:

```ts
function parseFileInput(value: unknown): ImageWorkerFileInput | undefined;
function parseRunEnvelope(value: unknown): {
  jobId: string;
  tool: unknown;
  toolVersion: unknown;
  input: ImageWorkerFileInput;
  spec: unknown;
} | undefined;
async function readFileInput(
  input: ImageWorkerFileInput,
  signal: AbortSignal,
): Promise<{ name: string; mimeHint: string; byteLength: number; bytes: ArrayBuffer }>;
```

Use plain-record and exact-key checks. Bound IDs to 128 characters, names to 512, MIME hints to 100, and inputs to `50 * 1024 * 1024`. Require `file instanceof File` and exact metadata equality first; matching native-File envelopes below 1 byte or above the input limit return non-retryable `MEMORY_LIMIT` before reading, while malformed or metadata-mismatched envelopes remain `INVALID_SPEC`. Require an ordinary own-key-free `ArrayBuffer` and post-read length equality.

Validate `spec` with `imagePipelineSpecSchema.safeParse()` before reading the file. Read untrusted request fields only inside guarded parsing so hostile getters and prototypes cannot escape the message handler. Unknown exceptions must use the fixed public message `이미지를 처리하는 중 오류가 발생했습니다.` rather than `error.message`.

Map errors exactly:

```ts
new ImagePipelineError("CORRUPT_INPUT", "이미지 파일을 읽지 못했습니다.", true)
new ImagePipelineError("CORRUPT_INPUT", "이미지 파일 크기를 확인하지 못했습니다.")
```

- [ ] **Step 6: Serialize one active job and suppress late completion**

Replace the bare cancelled-ID set with one active job controller:

```ts
interface ActiveJob {
  jobId: string;
  controller: AbortController;
}

let activeJob: ActiveJob | undefined;
```

For an exact `{ protocol: 1, type: "cancel", jobId }` request, abort only a matching active job. Before read, after read, during progress, and before complete, call `signal.throwIfAborted()`. Map that abort to non-retryable `CANCELLED` with `작업을 중단했습니다.`. A concurrent run receives one retryable `WORKER_CRASH`; a valid malformed request receives non-retryable `INVALID_SPEC`. Always clear `activeJob` only if it still refers to that job.

- [ ] **Step 7: Run Task 2 checks and commit**

Run:

```bash
pnpm exec vitest run \
  packages/browser-runtime/src/image.worker.test.ts \
  packages/browser-runtime/src/run-image-batch.test.ts \
  packages/browser-runtime/src/image-pipeline.test.ts
pnpm lint
pnpm typecheck
git diff --check
```

Expected: all PASS with no warning and no filename/private error text in output.

Commit:

```bash
git add packages/browser-runtime/src/image.worker.ts \
  packages/browser-runtime/src/image.worker.test.ts
git commit -m "perf: read image sources inside Worker"
```

### Task 3: Document and verify the completed runtime

**Files:**
- Modify: `docs/architecture.md`
- Inspect: every file changed since `origin/main`

**Interfaces:**
- Consumes: reviewed Tasks 1 and 2.
- Produces: a fully verified merge candidate with accurate privacy/performance documentation.

- [ ] **Step 1: Update architecture wording without overstating browser guarantees**

Document these exact relationships:

```md
- 크기 조절과 형식 변환의 전체 파일 읽기는 전용 이미지 Worker가 수행한다.
- 스마트 로컬 압축은 공통 배치 단계의 추가 UI 전체 읽기를 피하지만, 파일 선택 검사와 무손실 로컬 메타데이터 처리는 아직 UI 영역에서 파일을 읽는다.
- 네이티브 File 구조화 복제의 브라우저 내부 복사 전략은 보장하지 않는다. 제품 코드가 전송용 전체 ArrayBuffer를 UI 영역에 만들지 않는 것을 보장한다.
```

Keep the no-upload guarantee and do not claim total processing time or encoding speed improvements without measurements.

- [ ] **Step 2: Run complete local non-browser verification**

Run:

```bash
pnpm verify
```

Expected: audit, Biome, 11-package typecheck, unit tests, Worker integration, seeded image-engine fuzz, builds, static export, discovery boundaries, and bundle budgets PASS. Do not run local Playwright.

- [ ] **Step 3: Inspect exact scope and commit documentation**

Run:

```bash
git diff --stat origin/main...HEAD
git diff --name-status origin/main...HEAD
git diff --check origin/main...HEAD
git status --short
rg -n 'item\.file\.arrayBuffer\(' packages/browser-runtime/src/run-image-batch.ts
```

Expected: only the spec/plan, tool contract, common image runner/Worker/tests, and architecture document changed; the final `rg` returns no matches.

Commit:

```bash
git add docs/architecture.md
git commit -m "docs: describe common image Worker I/O"
```

### Task 4: Publish, verify hosted browsers, deploy, and clean

**Files:**
- Inspect: complete merge-candidate diff and GitHub/Cloudflare checks
- Temporary: `/tmp/hereisit-image-pipeline-worker-io-pr.md` (delete immediately after PR creation)

**Interfaces:**
- Consumes: final reviewed branch from Tasks 1–3.
- Produces: protected squash merge, passing main release/staging deployment, synchronized local `main`, and zero task-created temporary/Docker state.

The controller must complete the mandatory broad whole-branch code review and its single fix wave, if any, after Task 3 and before dispatching this release task. Task 4 introduces no source change; its later task review validates release and cleanup evidence.

- [ ] **Step 1: Re-run final-head gate before publication**

Run `pnpm verify`, `git diff --check origin/main...HEAD`, and `git status --short`. Expected: exact final HEAD is green and clean; no local Playwright.

- [ ] **Step 2: Push and create a ready pull request**

Create the body with `apply_patch`:

```md
## 변경 내용

- 이미지 크기 조절·형식 변환의 원본 파일을 전용 Worker에서 읽도록 변경했습니다.
- Worker가 파일 봉투와 실제 메타데이터 및 읽은 바이트 길이를 다시 검증합니다.
- 기존 변환·인코딩·다운로드 동작과 처리 한도는 유지했습니다.

## 효과

UI 영역이 Worker 전송용 전체 파일 버퍼를 만들지 않아 대용량·다중 이미지 처리 중 메모리 압력과 화면 멈춤 가능성을 줄입니다.

## 검증

- Worker 파일 읽기·신뢰 경계·취소 단위 테스트
- 배치 순서·오류·Worker 교체·메모리 한도 회귀 테스트
- `pnpm verify`
```

Then run:

```bash
git push -u origin agent/image-pipeline-worker-io
gh pr create --base main --head agent/image-pipeline-worker-io \
  --title "perf: keep common image file reads off UI thread" \
  --body-file /tmp/hereisit-image-pipeline-worker-io-pr.md
```

Delete the temporary body immediately with `apply_patch`.

- [ ] **Step 3: Require all protected pull-request checks**

Run:

```bash
gh pr checks --watch --fail-fast
```

Expected: `verify`, `browser`, and Cloudflare Pages PASS. The browser job must run Chromium, Firefox, WebKit, mobile Chromium, mobile Firefox, mobile WebKit, and product analytics.

- [ ] **Step 4: Squash merge and verify the release**

Run:

```bash
gh pr merge --squash --delete-branch
git -C /home/ubuntu/workspace/projects/hereisit pull --ff-only
```

Wait for merge-SHA main `verify`, Cloudflare Pages, and `Deploy successful main CI commit to staging`. Main-push `browser` is expected to skip because the protected PR already ran it. Do not bypass protection.

- [ ] **Step 5: Remove only task-created runtime state and report exact evidence**

Remove task-created Docker images, containers, volumes, build cache, and the temporary PR body after merge/deploy verification; preserve shared Playwright browser caches and unrelated worktrees. Keep this plan's SDD workspace and `/tmp/hereisit-image-pipeline-worker-io` worktree until the controller completes the Task 4 release review. The controller then deletes only this plan's SDD workspace and worktree.

Verify:

```bash
git -C /home/ubuntu/workspace/projects/hereisit status --short --branch
git -C /home/ubuntu/workspace/projects/hereisit rev-parse HEAD origin/main
git branch --list 'agent/image-pipeline-worker-io'
git stash list
docker ps -aq
docker images -q
docker system df
docker builder du
```

Expected before controller cleanup: local `main` equals `origin/main`, the task branch/stash/temp body are absent, and task-created images, containers, volumes, and build cache are zero. After Task 4 review, the controller also removes this plan's SDD workspace and `/tmp/hereisit-image-pipeline-worker-io` worktree and verifies their absence.

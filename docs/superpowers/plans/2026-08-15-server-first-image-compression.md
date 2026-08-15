# Server-First Image Compression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing native image server engine the default `/image/compress` path while retaining a persistent local-browser option and safe automatic local fallback.

**Architecture:** Keep `PolicyView` as server availability and add one persisted `ImageCompressionLocation` user preference. The workbench combines preference and policy at run time, reusing the existing remote batch and local Worker functions without changing their contracts.

**Tech Stack:** React 19, TypeScript, localStorage, Vitest, Playwright source tests in GitHub Actions, existing `@hereisit/server-runtime` and browser Worker packages.

## Global Constraints

- This change applies only to `/image/compress`; other tools remain local-first.
- Default new-browser selection is `server`; a saved explicit user choice wins on later visits.
- Display `선택한 파일을 HereIsIt 서버에서 처리하고 완료 후 삭제해요.` before execution.
- Local mode must create no job and upload no file bytes.
- Server failure may fall back locally only through the existing retryable-result boundary.
- Preserve the exact monthly estimated-cost ceiling `5,000,000µUSD`.
- Never log file contents, filenames, thumbnails, source/result bytes, or signed URLs.
- Add no dependency and do not run Playwright locally.

---

### Task 1: Persist the image-compression execution choice

**Files:**
- Modify: `AGENTS.md`
- Modify: `apps/web/src/lib/processing-config.ts`
- Test: `apps/web/src/lib/processing-config.test.ts`

**Interfaces:**
- Produces: `type ImageCompressionLocation = "server" | "local"`
- Produces: `readImageCompressionLocation(storage?: Storage): ImageCompressionLocation`
- Produces: `writeImageCompressionLocation(value: ImageCompressionLocation, storage?: Storage): void`

- [ ] **Step 1: Write failing storage tests**

Add tests proving an empty or malformed store returns `"server"`, a saved `"local"` value is restored,
and denied storage does not throw.

```ts
expect(readImageCompressionLocation(new FakeStorage())).toBe("server");
storage.setItem("hereisit.image-compression-location.v1", "local");
expect(readImageCompressionLocation(storage)).toBe("local");
expect(() => writeImageCompressionLocation("server", brokenStorage)).not.toThrow();
```

- [ ] **Step 2: Run the RED test**

Run: `pnpm exec vitest run apps/web/src/lib/processing-config.test.ts`

Expected: FAIL because the two preference helpers do not exist.

- [ ] **Step 3: Implement the minimal storage helpers**

Use one constant key and accept only the exact strings `server` and `local`. Catch storage access errors
and default to `server`; do not add a storage abstraction.

Also narrow the first AGENTS product principle: `/image/compress` is server-default only when the explicit
server notice is visible; every other tool remains local-first.

- [ ] **Step 4: Run the focused test and typecheck**

Run:

```bash
pnpm exec vitest run apps/web/src/lib/processing-config.test.ts
pnpm --filter @hereisit/web typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md apps/web/src/lib/processing-config.ts apps/web/src/lib/processing-config.test.ts
git commit -m "feat: remember image processing location"
```

### Task 2: Make server processing the default workbench choice

**Files:**
- Modify: `apps/web/src/components/image-compress-workbench.tsx`
- Modify: `apps/web/src/components/image-compress-workbench.module.css`
- Test: `apps/web/src/lib/image-compress-presentation.test.ts`
- Modify: `apps/web/src/lib/image-compress-presentation.ts`

**Interfaces:**
- Consumes: `ImageCompressionLocation`, `readImageCompressionLocation`, `writeImageCompressionLocation`
- Produces: `resolveImageCompressionExecution(preference, policy): "server" | "local" | "checking"`

- [ ] **Step 1: Write RED execution-resolution tests**

Add a pure helper test matrix:

```ts
expect(resolveImageCompressionExecution("local", "checking")).toBe("local");
expect(resolveImageCompressionExecution("local", "server")).toBe("local");
expect(resolveImageCompressionExecution("server", "server")).toBe("server");
expect(resolveImageCompressionExecution("server", "local")).toBe("local");
expect(resolveImageCompressionExecution("server", "checking")).toBe("checking");
```

- [ ] **Step 2: Run the RED presentation test**

Run: `pnpm exec vitest run apps/web/src/lib/image-compress-presentation.test.ts`

Expected: FAIL because `resolveImageCompressionExecution` is missing.

- [ ] **Step 3: Implement the pure resolver**

Return local immediately for an explicit local preference. Otherwise map the current policy state without
copying policy-fetch logic into the helper.

- [ ] **Step 4: Add preference state and one accessible choice group**

Initialize state with `readImageCompressionLocation()`. Render a two-option radio group in setup:

```tsx
<fieldset className={styles.executionModes}>
  <legend>처리 방식</legend>
  <label data-selected={location === "server"}>
    <input type="radio" name="image-processing-location" value="server" />
    <strong>고성능 서버 압축</strong>
    <span>선택한 파일을 HereIsIt 서버에서 처리하고 완료 후 삭제해요.</span>
  </label>
  <label data-selected={location === "local"}>
    <input type="radio" name="image-processing-location" value="local" />
    <strong>내 기기에서 처리</strong>
    <span>파일 전송 없음</span>
  </label>
</fieldset>
```

The server option remains the initial selection. The existing privacy link stays adjacent to the server
description. Use existing colors, borders, focus styles, and 44px targets; add only the CSS needed for a
two-column desktop/one-column mobile radio group.

- [ ] **Step 5: Route runs through preference plus policy**

In `processItems`, skip the forced policy refresh when the user selected local. When server is selected,
retain the current refresh and remote batch. Keep `PolicyView` unchanged so a fallback does not overwrite
the saved user preference. Derive `runDisabled` from the effective execution so local codec capability is
checked only for local runs.

Use the existing fallback array. Change its status copy to exactly:
`서버를 사용할 수 없어 이 기기에서 처리했어요.`

- [ ] **Step 6: Run focused checks**

Run:

```bash
pnpm exec vitest run apps/web/src/lib/processing-config.test.ts apps/web/src/lib/image-compress-presentation.test.ts apps/web/src/lib/local-image-optimize-fallback.test.ts
pnpm --filter @hereisit/web typecheck
pnpm exec biome check apps/web/src/components/image-compress-workbench.tsx apps/web/src/components/image-compress-workbench.module.css apps/web/src/lib/processing-config.ts apps/web/src/lib/image-compress-presentation.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/image-compress-workbench.tsx apps/web/src/components/image-compress-workbench.module.css apps/web/src/lib/image-compress-presentation.ts apps/web/src/lib/image-compress-presentation.test.ts
git commit -m "feat: default image compression to server"
```

### Task 3: Lock the server/local lifecycle in hosted browser source

**Files:**
- Modify: `tests/e2e/image-compression-server.spec.ts`
- Modify: `tests/e2e/mobile.spec.ts`

**Interfaces:**
- Consumes: existing strict policy, job, upload, result, download, and deletion route doubles
- Produces: hosted acceptance coverage; no production interface

- [ ] **Step 1: Add server-default and local-negative E2E cases**

Add assertions that the server radio is selected before file selection, the exact server notice is visible,
and clicking `용량 줄이기` reaches the existing `image.optimize@1` route double.

Add a local-mode case that selects `내 기기에서 처리`, runs a PNG, and records zero `/v1/jobs` and upload
requests. Reload once and assert the local choice persists; switch back to server and assert persistence.

- [ ] **Step 2: Add fallback and mobile assertions**

Reuse the existing retryable rejection fixture. Assert one remote attempt, one local Worker run, the exact
fallback copy, and no duplicate result. At 320px assert no horizontal overflow and visible keyboard focus
for both execution choices.

- [ ] **Step 3: Run non-browser source gates only**

Run:

```bash
pnpm --filter @hereisit/web typecheck
pnpm exec biome check tests/e2e/image-compression-server.spec.ts tests/e2e/mobile.spec.ts
git diff --check
```

Expected: PASS. Do not install or run Playwright locally.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/image-compression-server.spec.ts tests/e2e/mobile.spec.ts
git commit -m "test: cover server-first image compression"
```

### Task 4: Verify the runtime change

**Files:**
- Verify only

- [ ] **Step 1: Run the focused suite**

Run all touched Vitest files plus the existing server-runtime image batch tests.

- [ ] **Step 2: Run repository verification**

Run: `pnpm verify`

Expected: lint, all package typechecks, unit/integration tests, fuzz, builds, export, discovery, and bundle
budgets pass.

- [ ] **Step 3: Inspect scope and cleanup**

Run:

```bash
git diff --check origin/main...HEAD
git status --short
```

Remove generated `.next`, `out`, `dist`, test output, temporary Docker containers/images, and local
Playwright output created by verification. Preserve only tracked source and required audit evidence.

# Tool Discovery and Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace HereIsIt's workbench-first home and image/PDF-only navigation with fast catalog search, local file recommendations, domain tabs, a complete catalog, local favorites/recent tools, and an honest workflows preview.

**Architecture:** Discovery routes import only catalog metadata and small browser utilities. File selection reads bounded prefixes locally, builds deterministic recommendations, and hands `File` references to a chosen tool through one-use memory; destination workbenches still perform complete validation and require an explicit start action. Versioned ID-only preferences power recent/favorite surfaces without accounts or file-derived persistence.

**Tech Stack:** React 19, Next.js 16 static export, TypeScript 6, CSS Modules, Vitest 4 with Node environment, Playwright 1.61, Node.js 24 scripts, existing HereIsIt catalog and workbenches.

## Global Constraints

- Complete `2026-07-14-tool-catalog-foundation.md` first and use its exact exported names.
- Work in the same isolated feature worktree; do not push or merge auto-deploying `main` during implementation.
- Add no runtime dependency. Use platform `File`, `Blob`, `URLSearchParams`, `localStorage`, `<dialog>`, and React/Next APIs.
- Discovery routes and shared navigation must not import workbenches, Workers, PDF.js, codecs, editors, WASM, `@hereisit/browser-runtime`, `@hereisit/image-tool`, or `@hereisit/pdf-tool`.
- Never upload, decode, thumbnail, create object URLs for, log, or persist a selected source file during recommendation.
- Never log or persist filenames, prefix bytes, MIME hints, detected kinds, recommendation state, object URLs, or presigned URLs.
- Inspect at most 100 files, at most 64 KiB per file, and at most two prefixes concurrently. Every lease releases in `finally`.
- Pending handoff is module-scoped memory only, expires at exactly 60 seconds, matches one available tool ID, and is consumed once.
- Persistent preferences contain available tool IDs only, are deduplicated, and are capped at 12; denied storage falls back to memory.
- Catalog-owned tool links use Next client navigation and `prefetch={false}`. No file-derived value enters a URL.
- Home shows at most 12 tools; header shows at most four featured and four recent tools; `/tools` reveals 24 at a time.
- Preserve every processor contract, file/result behavior, warning, naming rule, Worker policy, and explicit start/save action.
- Use RED → GREEN → REFACTOR and make the focused Conventional Commit listed in each task.

---

## File Map

### New pure browser modules

- `apps/web/src/lib/file-selection-detection.ts` and `.test.ts` — bounded concurrent prefix orchestration.
- `apps/web/src/lib/file-recommendations.ts` and `.test.ts` — whole-selection and grouped recommendation planning.
- `apps/web/src/lib/pending-tool-selection.ts` and `.test.ts` — 60-second one-use in-memory handoff.
- `apps/web/src/lib/tool-preferences.ts` and `.test.ts` — ID-only recent/favorite external store.
- `apps/web/src/lib/use-tool-preferences.ts` — `useSyncExternalStore` adapter.
- `apps/web/src/lib/use-pending-tool-files.ts` — destination handoff adapter.

### New discovery components and routes

- `apps/web/src/components/tool-card.tsx` and `.module.css` — available/planned cards with optional favorite control.
- `apps/web/src/components/favorite-tool-button.tsx` — explicit favorite toggle.
- `apps/web/src/components/tool-visit-tracker.tsx` — recent-ID recorder.
- `apps/web/src/components/catalog-search.tsx` and `.module.css` — five-result local search/suggestions.
- `apps/web/src/components/domain-tool-tabs.tsx` and `.module.css` — roving responsive domain tabs and attached panel.
- `apps/web/src/components/home-file-launcher.tsx` and `.module.css` — local detection/recommendation UI.
- `apps/web/src/components/home-discovery.tsx` and `.module.css` — home composition.
- `apps/web/src/components/tool-catalog-browser.tsx` and `.module.css` — URL-backed catalog filtering and paging.
- `apps/web/src/components/my-tools.tsx` and `.module.css` — local favorites/recent view.
- `apps/web/src/app/tools/page.tsx`, `apps/web/src/app/my-tools/page.tsx`, `apps/web/src/app/workflows/page.tsx` — static discovery routes.

### Modified integration files

- `apps/web/src/components/site-header.tsx` plus new `site-header.module.css` — desktop mega/search and mobile dialog drawer.
- `apps/web/src/app/page.tsx`, `apps/web/src/app/sitemap.ts`, `apps/web/src/app/globals.css` — discovery home, indexable tools route, obsolete home styles.
- Existing page templates, all 11 route modules, and five workbenches — typed tool IDs, recent tracking, handoff, shared source limits.
- Existing image/PDF E2E suites — move home workbench assumptions to canonical tool routes.

### New verification assets

- `tests/e2e/support/privacy-observer.ts` — reusable network/log/storage sentinel observer.
- `tests/e2e/discovery.spec.ts`, `tests/e2e/discovery-mobile.spec.ts` — desktop/mobile discovery behavior.
- `scripts/verify-discovery-imports.mjs` — source/import boundary check.
- `scripts/fixtures/discovery-import-boundary/safe.ts` and `forbidden.ts` — immutable verifier self-test graphs.
- `tests/discovery-import-verifier.test.ts` — proves the import gate accepts/rejects fixtures without editing product sources.
- `scripts/verify-discovery-bundles.mjs` and `scripts/discovery-bundle-baseline.json` — gzip budgets.
- `docs/testing/discovery-accessibility-checklist.md` — manual VoiceOver/NVDA release checklist.

### Task 1: Orchestrate bounded, cancellable prefix detection

**Files:**
- Create: `apps/web/src/lib/file-selection-detection.ts`
- Create: `apps/web/src/lib/file-selection-detection.test.ts`

**Interfaces:**
- Consumes: `detectFileKindPrefix()`, `FileKind`, and `MAX_FILE_KIND_PREFIX_BYTES` from the lightweight registry subpaths.
- Produces: generation-safe detection results/progress used only by `HomeFileLauncher`.

~~~ts
export const MAX_LAUNCHER_FILES = 100;
export const MAX_DETECTION_CONCURRENCY = 2;
export interface FilePrefixLease { readonly bytes: Uint8Array; release(): void }
export interface FileDetectionItem { file: File; detectedKind: FileKind | null }
export interface DetectionProgress { completed: number; total: number }
export interface DetectFileSelectionOptions {
  isCurrent(): boolean;
  onProgress(progress: DetectionProgress): void;
  readPrefix?(file: File): Promise<FilePrefixLease>;
  detect?(prefix: Uint8Array, file: File): FileKind | undefined;
}
export class LauncherFileLimitError extends Error { readonly maximum = MAX_LAUNCHER_FILES }
export function readFilePrefix(file: File): Promise<FilePrefixLease>;
export function detectFileSelection(
  files: readonly File[],
  options: DetectFileSelectionOptions,
): Promise<readonly FileDetectionItem[] | null>;
~~~

- [ ] **Step 1: Write failing concurrency, cancellation, and release tests**

Use deferred fake prefix leases and assert:

~~~ts
expect(progress).toEqual([{ completed: 0, total: 3 }]);
expect(maximumConcurrentReads).toBeLessThanOrEqual(2);
expect(releaseCounts).toEqual([1, 1, 1]);
expect(results?.map(({ detectedKind }) => detectedKind)).toEqual([
  "image/png", "application/pdf", null,
]);
~~~

Add separate cases proving: 101 files throw `LauncherFileLimitError` before `readPrefix` is called; a stale generation stops scheduling new reads and returns `null`; every lease already acquired by either of the two workers is released exactly once and no later read is scheduled; detector exceptions release all acquired leases before rejecting; progress increments exactly once after every completed prefix; empty selection reports `0/0` and returns `[]`; `readFilePrefix()` slices `0..65_536` and its getter returns an empty view after `release()`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm test apps/web/src/lib/file-selection-detection.test.ts --run`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement lease and two-worker scheduling**

~~~ts
export async function readFilePrefix(file: File): Promise<FilePrefixLease> {
  let bytes = new Uint8Array(
    await file.slice(0, MAX_FILE_KIND_PREFIX_BYTES).arrayBuffer(),
  );
  return {
    get bytes() { return bytes; },
    release() { bytes = new Uint8Array(); },
  };
}

export async function detectFileSelection(
  files: readonly File[],
  {
    isCurrent,
    onProgress,
    readPrefix: read = readFilePrefix,
    detect = (bytes, file) => detectFileKindPrefix(bytes, {
      mime: file.type,
      extension: /(?:\.[^.]+)?$/.exec(file.name)?.[0],
    }),
  }: DetectFileSelectionOptions,
): Promise<readonly FileDetectionItem[] | null> {
  if (files.length > MAX_LAUNCHER_FILES) throw new LauncherFileLimitError();
  onProgress({ completed: 0, total: files.length });
  if (files.length === 0) return Object.freeze([]);
  const results: FileDetectionItem[] = new Array(files.length);
  let nextIndex = 0;
  let completed = 0;
  let firstFailure: unknown;
  async function worker(): Promise<void> {
    while (isCurrent() && firstFailure === undefined) {
      const index = nextIndex;
      if (index >= files.length) return;
      nextIndex += 1;
      const file = files[index];
      if (file === undefined) return;
      let lease: FilePrefixLease | undefined;
      try {
        lease = await read(file);
        if (!isCurrent()) continue;
        const detectedKind = detect(lease.bytes, file) ?? null;
        if (isCurrent()) results[index] = { file, detectedKind };
      } catch (error) {
        firstFailure ??= error;
        throw error;
      } finally {
        lease?.release();
        completed += 1;
        if (isCurrent()) onProgress({ completed, total: files.length });
      }
    }
  }
  const settlements = await Promise.allSettled(
    Array.from({ length: Math.min(MAX_DETECTION_CONCURRENCY, files.length) }, worker),
  );
  const rejected = settlements.find(
    (settlement): settlement is PromiseRejectedResult => settlement.status === "rejected",
  );
  if (rejected !== undefined) throw firstFailure ?? rejected.reason;
  return isCurrent() ? Object.freeze(results) : null;
}
~~~

Do not call `console`, `fetch`, `URL.createObjectURL`, a decoder, or a full-file validator. In the error path, invalidate the UI generation before showing a corrective message.

- [ ] **Step 4: Verify GREEN and commit**

Run: `pnpm test apps/web/src/lib/file-selection-detection.test.ts --run && pnpm --filter @hereisit/web typecheck`

Expected: PASS with peak concurrency two and every acquired lease released once.

~~~bash
git add apps/web/src/lib/file-selection-detection.ts apps/web/src/lib/file-selection-detection.test.ts
git commit -m "feat: detect launcher files with bounded reads"
~~~

### Task 2: Plan recommendations and one-use handoff

**Files:**
- Create: `apps/web/src/lib/file-recommendations.ts`
- Create: `apps/web/src/lib/file-recommendations.test.ts`
- Create: `apps/web/src/lib/pending-tool-selection.ts`
- Create: `apps/web/src/lib/pending-tool-selection.test.ts`

**Interfaces:**
- Consumes: `FileDetectionItem`, catalog capability helpers, labels, and exact available IDs.
- Produces: deterministic recommendation groups and the only allowed in-memory `File` transfer boundary.

~~~ts
export interface DetectedFileItem { file: File; detectedKind: FileKind }
export interface FileRecommendationGroup {
  kind: FileKind | "mixed";
  items: readonly DetectedFileItem[];
  recommendations: readonly ToolRecommendation[];
}
export type FileRecommendationPlan =
  | { state: "unsupported"; unknownCount: number; groups: readonly [] }
  | { state: "complete"; unknownCount: number; groups: readonly [FileRecommendationGroup] }
  | { state: "grouped"; unknownCount: number; groups: readonly FileRecommendationGroup[] };
export function planFileRecommendations(
  items: readonly FileDetectionItem[],
): FileRecommendationPlan;

export const PENDING_TOOL_SELECTION_TTL_MS = 60_000;
export type PendingToolSelectionResult =
  | { state: "consumed"; items: readonly DetectedFileItem[] }
  | { state: "empty" | "expired" | "target-mismatch" };
export function replacePendingToolSelection(
  targetToolId: AvailableToolId,
  items: readonly DetectedFileItem[],
  now?: number,
): void;
export function consumePendingToolSelection(
  targetToolId: AvailableToolId,
  now?: number,
): PendingToolSelectionResult;
export function clearPendingToolSelection(): void;
~~~

- [ ] **Step 1: Write failing whole-selection and grouped-fallback tests**

Assert a JPEG+PNG selection offers mixed-compatible image tools as one complete group; a PNG+PDF selection with no complete match produces two groups in first-seen order; a JPEG+unknown selection is grouped rather than falsely described as complete; all-unknown input is `unsupported`; a PDF merge recommendation says one more file is needed; 21 PDFs are `too-many`; planned tools never occur.

~~~ts
expect(planFileRecommendations([png, pdf])).toMatchObject({
  state: "grouped",
  unknownCount: 0,
  groups: [{ kind: "image/png" }, { kind: "application/pdf" }],
});
~~~

- [ ] **Step 2: Write failing handoff lifetime tests**

Use injected monotonic numbers plus Vitest fake timers and cover replacement, proactive release at exact `60_000`, mismatch clearing, one-consume behavior, explicit clear, and a copied/frozen item array. After timer expiry, the module may retain one non-persistent target-ID tombstone for a single `expired` result, but it must retain no `File` reference:

~~~ts
replacePendingToolSelection("image.compress", [png], 1_000);
expect(consumePendingToolSelection("image.compress", 60_999)).toMatchObject({ state: "consumed" });
expect(consumePendingToolSelection("image.compress", 61_000)).toEqual({ state: "empty" });

replacePendingToolSelection("image.compress", [png], 1_000);
expect(consumePendingToolSelection("image.compress", 61_000)).toEqual({ state: "expired" });

replacePendingToolSelection("image.compress", [png], 1_000);
await vi.advanceTimersByTimeAsync(60_000);
expect(consumePendingToolSelection("image.compress", 61_000)).toEqual({ state: "expired" });
expect(consumePendingToolSelection("image.compress", 61_001)).toEqual({ state: "empty" });

replacePendingToolSelection("image.compress", [png], 1_000);
expect(consumePendingToolSelection("image.resize", 1_001)).toEqual({ state: "target-mismatch" });
expect(consumePendingToolSelection("image.compress", 1_002)).toEqual({ state: "empty" });
~~~

Also prove the module never calls storage/history/URL/console functions.

- [ ] **Step 3: Run both tests and verify RED**

Run: `pnpm test apps/web/src/lib/file-recommendations.test.ts apps/web/src/lib/pending-tool-selection.test.ts --run`

Expected: FAIL because both modules are missing.

- [ ] **Step 4: Implement deterministic grouping and terminal clearing**

`planFileRecommendations()` counts null kinds and builds the known list. It tries `recommendAvailableTools()` on the complete selection only when `unknownCount === 0`, returning `complete` whenever at least one compatible recommendation exists, including needs-more/too-many. Otherwise it calls `groupDetectedKinds()`, preserves original file/index pairing, discards groups without recommendations, and returns `grouped` or `unsupported`. Thus an unsupported file can never be silently omitted from a supposedly complete handoff.

~~~ts
let pending: {
  targetToolId: AvailableToolId;
  items: readonly DetectedFileItem[];
  createdAtMonotonicMs: number;
} | null = null;
let expiredTargetToolId: AvailableToolId | null = null;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;

function clearExpiryTimer(): void {
  if (expiryTimer !== null) clearTimeout(expiryTimer);
  expiryTimer = null;
}

export function replacePendingToolSelection(
  targetToolId: AvailableToolId,
  items: readonly DetectedFileItem[],
  now = performance.now(),
): void {
  clearExpiryTimer();
  expiredTargetToolId = null;
  pending = { targetToolId, items: Object.freeze([...items]), createdAtMonotonicMs: now };
  const createdAt = now;
  expiryTimer = setTimeout(() => {
    if (pending?.createdAtMonotonicMs !== createdAt) return;
    expiredTargetToolId = pending.targetToolId;
    pending = null;
    expiryTimer = null;
  }, PENDING_TOOL_SELECTION_TTL_MS);
}

export function consumePendingToolSelection(
  targetToolId: AvailableToolId,
  now = performance.now(),
): PendingToolSelectionResult {
  const current = pending;
  pending = null;
  clearExpiryTimer();
  if (current === null) {
    if (expiredTargetToolId === null) return { state: "empty" };
    expiredTargetToolId = null;
    return { state: "expired" };
  }
  expiredTargetToolId = null;
  if (now - current.createdAtMonotonicMs >= PENDING_TOOL_SELECTION_TTL_MS) {
    return { state: "expired" };
  }
  if (current.targetToolId !== targetToolId) return { state: "target-mismatch" };
  return { state: "consumed", items: current.items };
}

export function clearPendingToolSelection(): void {
  clearExpiryTimer();
  pending = null;
  expiredTargetToolId = null;
}
~~~

- [ ] **Step 5: Verify GREEN and commit**

Run: `pnpm test apps/web/src/lib/file-recommendations.test.ts apps/web/src/lib/pending-tool-selection.test.ts --run && pnpm --filter @hereisit/web typecheck`

Expected: PASS; pending references clear on every terminal path.

~~~bash
git add apps/web/src/lib/file-recommendations.ts apps/web/src/lib/file-recommendations.test.ts apps/web/src/lib/pending-tool-selection.ts apps/web/src/lib/pending-tool-selection.test.ts
git commit -m "feat: plan local file recommendations and handoff"
~~~

### Task 3: Add ID-only preferences and reusable tool cards

**Files:**
- Create: `apps/web/src/lib/tool-preferences.ts`
- Create: `apps/web/src/lib/tool-preferences.test.ts`
- Create: `apps/web/src/lib/use-tool-preferences.ts`
- Create: `apps/web/src/components/tool-card.tsx`
- Create: `apps/web/src/components/tool-card.module.css`
- Create: `apps/web/src/components/favorite-tool-button.tsx`
- Create: `apps/web/src/components/tool-visit-tracker.tsx`

**Interfaces:**
- Consumes: available catalog selectors and IDs only.
- Produces: one external store and the card/tracker interfaces reused by header, home, catalog, my-tools, and Plan 3.

~~~ts
export const MAX_PERSONAL_TOOLS = 12;
export const FAVORITES_STORAGE_KEY = "hereisit.favorite-tools.v1";
export const RECENT_STORAGE_KEY = "hereisit.recent-tools.v1";
export interface ToolPreferencesSnapshot {
  favorites: readonly AvailableToolId[];
  recent: readonly AvailableToolId[];
  persistence: "local" | "memory";
}
export interface ToolPreferencesStore {
  getSnapshot(): ToolPreferencesSnapshot;
  subscribe(listener: () => void): () => void;
  recordRecent(id: AvailableToolId): void;
  toggleFavorite(id: AvailableToolId): void;
}
export function createToolPreferencesStore(
  resolveStorage?: () => Pick<Storage, "getItem" | "setItem">,
): ToolPreferencesStore;
export function normalizeStoredToolIds<T extends string>(
  value: unknown,
  resolveId: (value: string) => T | undefined,
  limit?: number,
): readonly T[];
export const toolPreferencesStore: ToolPreferencesStore;
export function useToolPreferences(): ToolPreferencesSnapshot;
export function ToolCard(props: {
  tool: AvailableToolEntry;
  context?: "catalog" | "related";
}): ReactNode;
export function FavoriteToolButton(props: { toolId: AvailableToolId }): ReactNode;
export function ToolVisitTracker(props: { toolId: AvailableToolId }): null;
~~~

- [ ] **Step 1: Write failing storage and fallback tests**

Test valid ID filtering, malformed JSON, non-array values, removed/planned IDs, stable de-duplication, newest-first recents, explicit favorite toggles, caps at 12, one subscriber notification per changed snapshot, no notification for an identical recent head, denied read, denied write, and memory continuity after denial. Because the current catalog has only 11 available IDs, call `normalizeStoredToolIds()` with 13 synthetic strings and an injected resolver to prove it returns the first 12; do not mistake the current inventory size for cap coverage. Inspect every fake `setItem` value and assert it is a JSON array of IDs with no other keys.

- [ ] **Step 2: Run the store test and verify RED**

Run: `pnpm test apps/web/src/lib/tool-preferences.test.ts --run`

Expected: FAIL because the store does not exist.

- [ ] **Step 3: Implement a stable external-store snapshot**

Resolve storage lazily on the first client mutation/read, call `normalizeStoredToolIds(value, (id) => findAvailableToolById(id)?.id, MAX_PERSONAL_TOOLS)`, and cache one frozen snapshot object until data changes. The server snapshot is the frozen empty state and must not resolve `window.localStorage`. If any client storage operation throws, switch permanently to in-memory state for that document and publish `persistence: "memory"`; never write a diagnostic marker. `useToolPreferences()` calls `useSyncExternalStore(store.subscribe, store.getSnapshot, getEmptyServerSnapshot)`.

Implement `FavoriteToolButton` as a real button with `aria-pressed`, visible `즐겨찾기 추가/해제` text for assistive technology, and `stopPropagation()` only to prevent a surrounding card click. Implement `ToolCard` with a separate Next `<Link prefetch={false}>` and sibling favorite button—never nest the button inside the link. Planned cards are not passed to this component. `ToolVisitTracker` records once in an effect and renders `null`.

- [ ] **Step 4: Add component styling and typecheck**

Use CSS grid, a minimum 44px favorite target, visible `:focus-visible`, line wrapping at 200% zoom, `prefers-reduced-motion`, and no fixed card height. Keep all labels rendered as React text.

Run: `pnpm test apps/web/src/lib/tool-preferences.test.ts --run && pnpm --filter @hereisit/web typecheck`

Expected: PASS with no React code added to the Node unit-test environment.

- [ ] **Step 5: Commit preferences and cards**

~~~bash
git add apps/web/src/lib/tool-preferences.ts apps/web/src/lib/tool-preferences.test.ts apps/web/src/lib/use-tool-preferences.ts apps/web/src/components/tool-card.tsx apps/web/src/components/tool-card.module.css apps/web/src/components/favorite-tool-button.tsx apps/web/src/components/tool-visit-tracker.tsx
git commit -m "feat: add local tool preferences and cards"
~~~

### Task 4: Replace the global header and add local catalog search

**Files:**
- Create: `apps/web/src/components/catalog-search.tsx`
- Create: `apps/web/src/components/catalog-search.module.css`
- Create: `apps/web/src/components/site-header.module.css`
- Modify: `apps/web/src/components/site-header.tsx`
- Create: `tests/e2e/discovery.spec.ts`
- Create: `tests/e2e/discovery-mobile.spec.ts`

**Interfaces:**
- Consumes: `searchAvailableTools()`, domain definitions, `selectHomeTools()`, preferences, and available routes.
- Produces: the single global overlay owner (`mega | search | drawer | null`) used on every route.

~~~ts
export interface CatalogSearchProps {
  idPrefix: string;
  variant: "hero" | "header" | "drawer" | "catalog";
  initialQuery?: string;
  query?: string;
  onQueryChange?(query: string): void;
  onSubmitQuery?(query: string): void;
  onNavigate?(): void;
}
export function CatalogSearch(props: CatalogSearchProps): ReactNode;
export function SiteHeader(props: { activePath?: string }): ReactNode;
~~~

- [ ] **Step 1: Add failing desktop/mobile header assertions**

Create the first sections of `tests/e2e/discovery.spec.ts` and `tests/e2e/discovery-mobile.spec.ts` asserting desktop labels `모든 도구`, `워크플로`, `내 도구`, `검색`; `aria-expanded`; seven real domain links; no more than four featured/recent links; outside/Escape close and focus return. Mobile asserts one menu trigger, modal dialog, initially focused close control, two-column domain list, trapped Tab, inert background, locked body scroll, Escape close, and trigger focus restoration.

- [ ] **Step 2: Run the focused browser tests and verify RED**

Run after `pnpm --filter @hereisit/web build` with the existing preview fixture:

`pnpm exec playwright test tests/e2e/discovery.spec.ts tests/e2e/discovery-mobile.spec.ts --project=chromium --project=mobile-chromium`

Expected: FAIL because the current header contains only image/PDF anchors.

- [ ] **Step 3: Implement accessible search behavior**

`CatalogSearch` keeps raw text locally when `query` is undefined; when `query` is supplied it is controlled and calls `onQueryChange`, so `/tools` Back/Forward updates the visible input from current `useSearchParams()` state rather than a stale initializer. It derives at most five available matches for a non-empty normalized query; an empty query renders no blank suggestion overlay. It exposes `role="listbox"`/`role="option"` plus `aria-activedescendant`, and supports ArrowUp/Down, Enter, Escape, touch, and visible focus. Selecting a suggestion uses `router.push(tool.route)`; submitting calls `onSubmitQuery` when supplied, otherwise navigates to `'/tools?' + serializeCatalogUrlState(...)`; empty submission closes suggestions. A polite result-count live region updates through a 150ms timeout that is cleared on the next keystroke/unmount. It never reads preferences or files.

- [ ] **Step 4: Implement the one-owner header state machine**

Mark `site-header.tsx` as a client component, preserve the optional `activePath` prop for current and Plan 3 detail pages, and store only:

~~~ts
type GlobalOverlay = "mega" | "search" | "drawer" | null;
const [overlay, setOverlay] = useState<GlobalOverlay>(null);
~~~

Opening one overlay replaces the previous value. Desktop mega is a navigation disclosure, not `role="menu"`; keep focus on the trigger at open so Tab reaches its first link. Close on an outside `pointerdown` and Escape, restoring the initiating trigger. Render `HereIsIt | 모든 도구 | 워크플로 | 내 도구 | 검색`, a restrained `준비 중` label beside workflows, seven domain URLs, up to four featured and four recent tools, and links to `/tools` and `/workflows`.

Use one native `<dialog>` for mobile. On open call `showModal()`, focus its close button, set the application sibling inert, and lock body overflow; on close/cleanup undo all three and focus the mobile trigger. All links use Next `Link` and tool links set `prefetch={false}`.

- [ ] **Step 5: Verify GREEN and commit**

Run:

~~~bash
pnpm --filter @hereisit/web build
pnpm exec playwright test tests/e2e/discovery.spec.ts tests/e2e/discovery-mobile.spec.ts --project=chromium --project=mobile-chromium
~~~

Expected: PASS for header/search semantics, keyboard flow, and responsive drawer.

~~~bash
git add apps/web/src/components/catalog-search.tsx apps/web/src/components/catalog-search.module.css apps/web/src/components/site-header.tsx apps/web/src/components/site-header.module.css tests/e2e/discovery.spec.ts tests/e2e/discovery-mobile.spec.ts
git commit -m "feat: add scalable global navigation"
~~~

### Task 5: Build the discovery home and destination handoff

**Files:**
- Create: `apps/web/src/components/domain-tool-tabs.tsx`
- Create: `apps/web/src/components/domain-tool-tabs.module.css`
- Create: `apps/web/src/components/home-file-launcher.tsx`
- Create: `apps/web/src/components/home-file-launcher.module.css`
- Create: `apps/web/src/components/home-discovery.tsx`
- Create: `apps/web/src/components/home-discovery.module.css`
- Create: `apps/web/src/lib/use-pending-tool-files.ts`
- Modify: `apps/web/src/app/page.tsx`
- Modify: `apps/web/src/app/globals.css`
- Modify: `apps/web/src/components/image-workbench.tsx`
- Modify: `apps/web/src/components/image-watermark-workbench.tsx`
- Modify: `apps/web/src/components/pdf-workbench.tsx`
- Modify: `apps/web/src/components/pdf-to-image-workbench.tsx`
- Modify: `apps/web/src/components/pdf-compress-workbench.tsx`
- Modify: `apps/web/src/components/image-tool-page.tsx`
- Modify: `apps/web/src/components/pdf-tool-page.tsx`
- Modify: `apps/web/src/components/pdf-editing-tool-page.tsx`
- Modify: `apps/web/src/app/image/compress/page.tsx`
- Modify: `apps/web/src/app/image/resize/page.tsx`
- Modify: `apps/web/src/app/image/convert/page.tsx`
- Modify: `apps/web/src/app/image/watermark/page.tsx`
- Modify: `apps/web/src/app/pdf/merge/page.tsx`
- Modify: `apps/web/src/app/pdf/split/page.tsx`
- Modify: `apps/web/src/app/pdf/organize/page.tsx`
- Modify: `apps/web/src/app/pdf/watermark/page.tsx`
- Modify: `apps/web/src/app/pdf/to-image/page.tsx`
- Modify: `apps/web/src/app/pdf/image-to-pdf/page.tsx`
- Modify: `apps/web/src/app/pdf/compress/page.tsx`
- Modify: `apps/web/src/lib/site.test.ts`
- Modify: `tests/e2e/image-workbench.spec.ts`
- Modify: `tests/e2e/mobile.spec.ts`
- Modify: `tests/e2e/discovery.spec.ts`
- Modify: `tests/e2e/discovery-mobile.spec.ts`
- Create: `tests/e2e/support/privacy-observer.ts`
- Modify: `tests/e2e/pdf-compression.spec.ts`

**Interfaces:**
- Consumes: catalog home selectors, Tasks 1–3, keyed `sourceFileLimits`, current workbench intake callbacks.
- Produces: processor-free home UI and narrow destination adapters; Plan 3 keeps the same `toolId` props.

~~~ts
export function DomainToolTabs(props: {
  selected: DiscoveryDomainId;
  onSelect(id: DiscoveryDomainId): void;
  recentToolIds: readonly AvailableToolId[];
}): ReactNode;
export function HomeFileLauncher(): ReactNode;
export function usePendingToolFiles(options: {
  toolId: AvailableToolId;
  ready: boolean;
  acceptFiles(files: readonly File[]): void | Promise<void>;
  onReselectRequired(message: "파일을 다시 선택해 주세요"): void;
}): void;
~~~

- [ ] **Step 1: Extract the privacy observer and extend failing home/responsive tests**

Move the robust network/console/storage/object-URL sentinel instrumentation from `pdf-compression.spec.ts` into `tests/e2e/support/privacy-observer.ts`, exporting `installPrivacyObserver(page)` and a `read()` result containing external requests, write requests, console messages, storage writes, and object URLs. Update the original PDF compression test to use it first, preserving every existing assertion; this proves the helper before the new launcher relies on it.

~~~ts
export interface PrivacyObservation {
  requestCount: number;
  externalRequests: readonly string[];
  writeRequests: readonly string[];
  consoleMessages: readonly string[];
  storageWrites: readonly string[];
  objectUrls: readonly string[];
}
export async function installPrivacyObserver(page: Page): Promise<{
  read(): Promise<PrivacyObservation>;
}>;
~~~

Assert the home has search, a separate file chooser/drop zone, all eight tabs, an always-present attached `tabpanel`, correct heading/count, max 12 cards, and domain `모두 보기` URL. Verify keyboard roving: Left/Right wrap, Home/End jump, Up/Down do not change tabs. At desktop tabs occupy one eight-item row, medium four per row, and mobile two per row; cards use multiple columns without horizontal overflow.

Select PNG/PDF fixtures and assert immediate `0/N개 형식 확인 중`, incrementing progress, complete/grouped recommendations, no auto-navigation, explicit `도구 선택`, `다른 파일 선택`, and `파일 없이 도구 찾기`. Select 101 files and assert none are read. Snapshot `requestCount` immediately before file selection and require the same count after detection/recommendation, proving even same-origin GET traffic is zero during selection; the external/write arrays alone are insufficient. Use sentinel filename/bytes and assert no log, storage, history, URL, thumbnail, or object URL receives them.

- [ ] **Step 2: Run home tests and verify RED**

Run: `pnpm exec playwright test tests/e2e/discovery.spec.ts tests/e2e/discovery-mobile.spec.ts --project=chromium --project=mobile-chromium`

Expected: FAIL because home still eagerly mounts `ImageWorkbench`.

- [ ] **Step 3: Implement home tabs and launcher generation control**

Replace `page.tsx` with a server shell containing `SiteHeader`, `HomeDiscovery`, and `SiteFooter`; remove its workbench import. `HomeDiscovery` renders hero `CatalogSearch`, `HomeFileLauncher`, and `DomainToolTabs`. Tabs use the catalog's fixed DOM order and one tab stop. CSS grid uses `repeat(8, 1fr)`, then four at the medium breakpoint and two at mobile; visually connect selected tab and panel without reordering DOM.

`HomeFileLauncher` increments `generationRef.current` for selection/reset/unmount, calls `detectFileSelection` with an `isCurrent` closure, catches the count limit before displaying results, and stores only live `FileDetectionItem` objects in component memory. When the user explicitly chooses a ready or needs-more recommendation, select the shown group, call `replacePendingToolSelection(tool.id, items)`, then `router.push(tool.route)`. Recommendation actions are buttons, not hard-navigation anchors, so no prefetch can race the memory record; any ordinary fallback tool link uses `prefetch={false}`. Disable too-many actions and never auto-run.

Expose detection progress and non-blocking status through a polite live region. Put count-limit, unknown-kind, and too-many corrections next to the chooser/recommendation they affect; move focus to an error summary only when a submitted recommendation cannot continue. Reset/unmount invalidate detection state but do not clear a just-created handoff during route transition; consumption, replacement, explicit handoff cancellation, or its 60-second timer owns that record's cleanup.

- [ ] **Step 4: Add one-attempt destination consumption**

~~~ts
export function usePendingToolFiles({
  toolId, ready, acceptFiles, onReselectRequired,
}: UsePendingToolFilesOptions): void {
  const attemptedToolId = useRef<AvailableToolId | null>(null);
  useEffect(() => {
    if (!ready || attemptedToolId.current === toolId) return;
    attemptedToolId.current = toolId;
    const result = consumePendingToolSelection(toolId);
    if (result.state === "consumed") {
      void acceptFiles(result.items.map(({ file }) => file));
    } else if (result.state === "expired" || result.state === "target-mismatch") {
      onReselectRequired("파일을 다시 선택해 주세요");
    }
  }, [acceptFiles, onReselectRequired, ready, toolId]);
}
~~~

An `empty` result shows the ordinary selector with no special message, covering reload/hard navigation honestly. Every destination routes handed-off files through the same existing `addFiles`/`chooseFile` validation path used by manual selection and retains the explicit process button.

- [ ] **Step 5: Key every page/workbench and remove limit duplication**

Give all five workbench components `toolId: AvailableToolId`. Give the three temporary detail templates the same required prop, pass it from all 11 routes, render `<ToolVisitTracker toolId={toolId} />`, and forward it to the workbench. Move `pdf-workbench.tsx` and the temporary PDF editing template from `site.ts` types to `PdfEditingIntent`/`isPdfEditingIntent` exported by `tool-implementations.ts`. Each workbench reads `getToolImplementation(toolId).sourceFileLimits`; delete duplicated source count/per-file/total constants. At component entry, fail fast when the keyed implementation intent/profile does not match the workbench prop (for example `implementation.intent !== intent` in the shared image/PDF workbenches, or a non-`pdf-to-images` bundle in the dedicated renderer). Add a pure ID-to-intent/profile table assertion to `site.test.ts`; existing route E2E proves every real composition passes the guards. Keep the watermark-logo 10 MiB secondary-input constant and scanned-PDF 100-page runtime limit because neither describes primary launcher files.

Map IDs exactly: pipeline routes use their own `image.*` ID; watermark uses `image.watermark`; editing intents use `pdf.merge`, `pdf.split`, `pdf.organize`, `pdf.watermark`, `pdf.image-to-pdf`; dedicated workbenches use `pdf.to-image` and `pdf.compress-scanned`. Add an assertion in `site.test.ts` that launcher count bounds equal the values now consumed by workbenches.

Keep the Plan 1 catalog/legacy join explicit in every route. The three route shapes are:

~~~tsx
// Image pipeline routes; substitute the exact ID/key for resize and convert.
const toolId = "image.compress" satisfies AvailableToolId;
const catalogTool = getAvailableToolById(toolId);
const tool = imageTools.compress;
export const metadata = createToolMetadata(catalogTool);
export default function Page() {
  return <ImageToolPage
    tool={tool}
    toolId={toolId}
    imageWorkbench={<ImageWorkbench intent={tool.intent} toolId={toolId} />}
  />;
}

// Editing PDF routes; PdfEditingToolPage forwards tool.intent and toolId to PdfWorkbench.
const toolId = "pdf.merge" satisfies AvailableToolId;
const catalogTool = getAvailableToolById(toolId);
const tool = pdfTools.merge;
export const metadata = createToolMetadata(catalogTool);
export default function Page() {
  return <PdfEditingToolPage tool={tool} toolId={toolId} />;
}

// Dedicated workbench routes use PdfToolPage and pass the same ID to both layers.
const toolId = "pdf.to-image" satisfies AvailableToolId;
const catalogTool = getAvailableToolById(toolId);
const tool = pdfTools["to-image"];
export const metadata = createToolMetadata(catalogTool);
export default function Page() {
  return <PdfToolPage
    tool={tool}
    toolId={toolId}
    workbench={<PdfToImageWorkbench toolId={toolId} />}
  />;
}
~~~

Apply those shapes with this exact route map: compress/resize/convert use `ImageToolPage` + `ImageWorkbench`; image watermark uses `ImageToolPage` + `ImageWatermarkWorkbench`; merge/split/organize/PDF-watermark/image-to-PDF use `PdfEditingToolPage`; PDF-to-image uses `PdfToolPage` + `PdfToImageWorkbench`; `/pdf/compress` uses `toolId="pdf.compress-scanned"`, `pdfTools.compress`, `PdfToolPage`, and `PdfCompressWorkbench`. No route derives an ID from a path string.

- [ ] **Step 6: Move old home E2E assumptions to canonical routes**

Change image-workbench cases that visit `/` to `/image/compress`, `/image/resize`, or `/image/convert` according to intent. Change the mobile home assertion to expect the launcher/tabs, while existing processor mobile cases visit their canonical routes. Do not weaken output, warning, cancellation, or privacy assertions.

- [ ] **Step 7: Verify GREEN and commit**

Run:

~~~bash
pnpm test apps/web/src/lib/file-selection-detection.test.ts apps/web/src/lib/file-recommendations.test.ts apps/web/src/lib/pending-tool-selection.test.ts apps/web/src/lib/site.test.ts --run
pnpm --filter @hereisit/web build
pnpm exec playwright test tests/e2e/discovery.spec.ts tests/e2e/discovery-mobile.spec.ts tests/e2e/image-workbench.spec.ts tests/e2e/mobile.spec.ts --project=chromium --project=mobile-chromium
~~~

Expected: PASS; home route closure contains no processing code and handed-off files still require normal validation/start.

~~~bash
git add apps/web/src/app/page.tsx apps/web/src/app/globals.css apps/web/src/components/domain-tool-tabs.tsx apps/web/src/components/domain-tool-tabs.module.css apps/web/src/components/home-file-launcher.tsx apps/web/src/components/home-file-launcher.module.css apps/web/src/components/home-discovery.tsx apps/web/src/components/home-discovery.module.css apps/web/src/lib/use-pending-tool-files.ts apps/web/src/components/image-workbench.tsx apps/web/src/components/image-watermark-workbench.tsx apps/web/src/components/pdf-workbench.tsx apps/web/src/components/pdf-to-image-workbench.tsx apps/web/src/components/pdf-compress-workbench.tsx apps/web/src/components/image-tool-page.tsx apps/web/src/components/pdf-tool-page.tsx apps/web/src/components/pdf-editing-tool-page.tsx apps/web/src/app/image apps/web/src/app/pdf apps/web/src/lib/site.test.ts tests/e2e/support/privacy-observer.ts tests/e2e/pdf-compression.spec.ts tests/e2e/image-workbench.spec.ts tests/e2e/mobile.spec.ts tests/e2e/discovery.spec.ts tests/e2e/discovery-mobile.spec.ts
git commit -m "feat: add local-first home discovery"
~~~

### Task 6: Add `/tools`, `/my-tools`, and honest `/workflows`

**Files:**
- Create: `apps/web/src/components/tool-catalog-browser.tsx`
- Create: `apps/web/src/components/tool-catalog-browser.module.css`
- Create: `apps/web/src/components/my-tools.tsx`
- Create: `apps/web/src/components/my-tools.module.css`
- Create: `apps/web/src/app/tools/page.tsx`
- Create: `apps/web/src/app/my-tools/page.tsx`
- Create: `apps/web/src/app/workflows/page.tsx`
- Modify: `apps/web/src/app/sitemap.ts`
- Modify: `scripts/verify-static-export.mjs`
- Modify: `tests/e2e/discovery.spec.ts`
- Modify: `tests/e2e/discovery-mobile.spec.ts`
- Modify: `tests/e2e/tool-pages.spec.ts`

**Interfaces:**
- Consumes: catalog URL-state functions, separate available/planned selectors, preferences, cards, and search.
- Produces: three static routes with correct canonical/indexing behavior and no fake functionality.

- [ ] **Step 1: Write failing catalog URL/history tests**

Cover `/tools?q=png&domain=image&purpose=convert&planned=1`, invalid-value recovery, AND semantics, result count, 24-card initial cap, another 24 per `더 보기`, reset on filter changes, query typing with `history.replaceState`, explicit tabs/purpose/planned toggles with pushed history, back/forward restoration, one canonical `/tools`, empty reset action, and no horizontal overflow. Planned results appear in a separate labelled region only when enabled and have `준비 중` with no link/button.

- [ ] **Step 2: Write failing personal/workflow route tests**

Assert favorite toggling updates `/my-tools`, recent IDs are newest first, both cap at 12, storage denial displays a subtle memory-only explanation while search/processing still work, empty state links to featured tools and `/tools`, and only IDs are stored. Assert `/my-tools` metadata is `noindex,follow` and absent from sitemap.

Assert `/workflows` is `noindex,follow`, absent from sitemap, explains explicit local chaining as future work, labels every example `준비 중`, links only to available individual tools, and contains no builder, disabled primary CTA, fake run button, or execution claim.

- [ ] **Step 3: Run route tests and verify RED**

Run: `pnpm --filter @hereisit/web build && pnpm exec playwright test tests/e2e/discovery.spec.ts tests/e2e/discovery-mobile.spec.ts --project=chromium --project=mobile-chromium`

Expected: FAIL because the three routes do not exist.

- [ ] **Step 4: Implement the static catalog island**

`app/tools/page.tsx` exports fixed canonical metadata and wraps `ToolCatalogBrowser` in `Suspense` with a catalog-card fallback; do not accept dynamic server `searchParams`. The client browser calls `useSearchParams()`, parses safe state, and maintains `visibleCount=24`. Pass `query={state.query}` to `CatalogSearch`; its `onQueryChange` performs `router.replace`, while submit and explicit tab/purpose/planned changes use `router.push`. Back/Forward therefore re-parses URL state and controls the visible input. Every filter change resets the count. Render available results first and call `selectPlannedTools()` only for the separate planned region.

Domain controls reuse the tab semantics and 8/4/2 layout; purpose controls wrap. Mobile cards use two columns where width/text permits, then one. No state derived from selected files/preferences enters the query string.

- [ ] **Step 5: Implement personal and preparation pages**

`MyTools` maps stored IDs through `findAvailableToolById()`, silently ignores removed IDs, renders favorite/recent sections with `ToolCard`, and shows the memory explanation only for `persistence: "memory"`. Export:

~~~ts
export const metadata: Metadata = {
  title: "내 도구",
  robots: { index: false, follow: true },
  alternates: { canonical: "/my-tools" },
};
~~~

Use equivalent `noindex,follow` metadata for `/workflows`. Its examples are static explanatory cards with `준비 중`; their only actions are ordinary available-tool links.

All three routes render the global `SiteHeader` and `SiteFooter`. `/tools` places `ToolCatalogBrowser` between them; `/my-tools` places `MyTools` between them; `/workflows` keeps its explanatory content server-rendered between them.

Add `/tools` to sitemap at priority 0.8. Do not add `/my-tools` or `/workflows`. Extend the already catalog-derived `verify-static-export.mjs` to require all three discovery HTML files, `/tools` sitemap/canonical, both noindex pages, and zero planned-route output; keep route checks independent of image/PDF directory prefixes so future domains require no verifier edit.

- [ ] **Step 6: Update old publication assertions**

Change `tool-pages.spec.ts` navigation/publication enumeration to use `/tools`; retain direct checks for all 11 canonical routes. Do not expect planned cards on home, suggestions, favorites, recent, related actions, metadata, or sitemap.

- [ ] **Step 7: Verify GREEN and commit**

Run:

~~~bash
pnpm --filter @hereisit/web build
pnpm verify:export
pnpm exec playwright test tests/e2e/discovery.spec.ts tests/e2e/discovery-mobile.spec.ts tests/e2e/tool-pages.spec.ts --project=chromium --project=mobile-chromium
~~~

Expected: PASS with shareable catalog state, useful local personal tools, and no workflow execution surface.

~~~bash
git add apps/web/src/components/tool-catalog-browser.tsx apps/web/src/components/tool-catalog-browser.module.css apps/web/src/components/my-tools.tsx apps/web/src/components/my-tools.module.css apps/web/src/app/tools/page.tsx apps/web/src/app/my-tools/page.tsx apps/web/src/app/workflows/page.tsx apps/web/src/app/sitemap.ts scripts/verify-static-export.mjs tests/e2e/discovery.spec.ts tests/e2e/discovery-mobile.spec.ts tests/e2e/tool-pages.spec.ts
git commit -m "feat: add complete tool discovery routes"
~~~

### Task 7: Lock privacy, accessibility, and discovery bundle budgets

**Files:**
- Modify: `tests/e2e/support/privacy-observer.ts`
- Modify: `tests/e2e/pdf-compression.spec.ts`
- Modify: `tests/e2e/discovery.spec.ts`
- Modify: `tests/e2e/discovery-mobile.spec.ts`
- Create: `scripts/verify-discovery-imports.mjs`
- Create: `scripts/fixtures/discovery-import-boundary/safe.ts`
- Create: `scripts/fixtures/discovery-import-boundary/forbidden.ts`
- Create: `tests/discovery-import-verifier.test.ts`
- Create: `scripts/verify-discovery-bundles.mjs`
- Create: `scripts/discovery-bundle-baseline.json`
- Create: `docs/testing/discovery-accessibility-checklist.md`
- Modify: `scripts/verify-static-export.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: completed exported routes and Next build manifests.
- Produces: reusable privacy observation plus source and gzip release gates.

- [ ] **Step 1: Prove and finalize the reusable privacy observer without weakening it**

Keep the interface extracted in Task 5:

~~~ts
export interface PrivacyObservation {
  requestCount: number;
  externalRequests: readonly string[];
  writeRequests: readonly string[];
  consoleMessages: readonly string[];
  storageWrites: readonly string[];
  objectUrls: readonly string[];
}
export async function installPrivacyObserver(page: Page): Promise<{
  read(): Promise<PrivacyObservation>;
}>;
~~~

Add deliberate test-only injections proving it catches `fetch`, POST, console, storage, beacon/XHR, and object-URL violations, then clear those injections before real assertions. Do not record request bodies or actual user filenames in diagnostics. Both the original compression suite and discovery suites must consume the same helper.

- [ ] **Step 2: Complete browser privacy and keyboard coverage**

Use sentinel test fixtures and assert selection/detection/handoff produce no external request or write method; no sentinel filename/bytes/detected kind enters URL, history, persistent storage, console, analytics/error surfaces, thumbnail, or object URL. Verify destination revalidation, expiry/mismatch reselect messages, reload's ordinary selector, and one-use consumption.

Add reduced-motion, 200% zoom, enlarged mobile text, keyboard-only search/menu/tabs, exact focus return, and no-overflow assertions. Run the same discovery cases in desktop Chromium/Firefox, mobile Chromium, and WebKit at the final gate.

- [ ] **Step 3: Add a static source-import gate**

`verify-discovery-imports.mjs` starts from home, `/tools`, `/my-tools`, `/workflows`, header, search, tabs, cards, launcher, preferences, and catalog entrypoints; parse imports with installed TypeScript and fail if their transitive runtime closure reaches a workbench, Worker, `browser-runtime`, `image-tool`, `pdf-tool`, PDF.js, codec/editor/WASM marker, or processing contract runtime. Print module paths only. Accept repeatable `--entrypoint <relative-path>` arguments solely to test an alternate graph.

Create immutable fixtures:

~~~ts
// scripts/fixtures/discovery-import-boundary/safe.ts
export const fixture = "safe";

// scripts/fixtures/discovery-import-boundary/forbidden.ts
import "@hereisit/pdf-tool";
export const fixture = "forbidden";
~~~

In `tests/discovery-import-verifier.test.ts`, launch Node with `execFile`: the safe entrypoint must exit 0; the forbidden entrypoint must reject with a nonzero exit and stderr naming `forbidden.ts` plus `@hereisit/pdf-tool`. Never add/remove a forbidden import in a real product file as a self-test.

Run: `pnpm test tests/discovery-import-verifier.test.ts --run`

Expected: PASS with one accepted and one deliberately rejected fixture process.

- [ ] **Step 4: Record and enforce gzip budgets**

`verify-discovery-bundles.mjs` reads Next's build manifests and exported HTML, separates framework chunks shared by every route, calculates unique route-owned and combined discovery-shared gzip bytes, and supports `--write-baseline`. Fail when:

- any one of `/`, `/tools`, `/my-tools`, `/workflows` owns more than 76,800 gzip bytes;
- their discovery-only shared layer exceeds 122,880 gzip bytes;
- after baseline creation, either value grows by more than `min(10_240, floor(baseline * 0.10))`;
- any discovery closure contains a forbidden processor marker regardless of byte size.

Create JSON with schema:

~~~json
{
  "schemaVersion": 1,
  "routes": { "/": 0, "/tools": 0, "/my-tools": 0, "/workflows": 0 },
  "discoveryShared": 0,
  "frameworkSharedReported": 0
}
~~~

Generate real nonzero values only after the production build: `node scripts/verify-discovery-bundles.mjs --write-baseline`; inspect and commit the result. Do not hand-edit zero placeholders into the committed baseline.

- [ ] **Step 5: Wire verification and document manual checks**

Change `verify:export` to run static export, discovery imports, and discovery bundle checks in sequence. The accessibility checklist records date/browser/result fields for VoiceOver+Safari and NVDA+Firefox-or-Chrome, covering header, search, tabs, launcher, and one representative tool page; it clearly states Playwright is the automated gate and unavailable manual platforms are recorded as not run, never silently claimed.

- [ ] **Step 6: Run the complete discovery gate and commit**

Run:

~~~bash
pnpm test tests/discovery-import-verifier.test.ts --run
pnpm verify
pnpm exec playwright test tests/e2e/discovery.spec.ts --project=chromium --project=firefox
PLAYWRIGHT_WEBKIT=1 pnpm exec playwright test tests/e2e/discovery.spec.ts tests/e2e/discovery-mobile.spec.ts
pnpm verify:all
~~~

Expected: every command exits 0; discovery closures contain no processor and gzip values are within absolute/baseline budgets.

~~~bash
git add tests/e2e/support/privacy-observer.ts tests/e2e/pdf-compression.spec.ts tests/e2e/discovery.spec.ts tests/e2e/discovery-mobile.spec.ts tests/discovery-import-verifier.test.ts scripts/verify-discovery-imports.mjs scripts/fixtures/discovery-import-boundary/safe.ts scripts/fixtures/discovery-import-boundary/forbidden.ts scripts/verify-discovery-bundles.mjs scripts/discovery-bundle-baseline.json scripts/verify-static-export.mjs docs/testing/discovery-accessibility-checklist.md package.json
git commit -m "test: enforce discovery privacy and performance"
~~~

## Completion Checkpoint

This plan is complete when all discovery routes are useful without an account, file recommendation is demonstrably local/bounded/cancellable, handoff never bypasses destination validation, preferences contain IDs only, planned cards have no actions/routes, responsive keyboard behavior passes, and `pnpm verify:all` plus bundle gates pass. Continue with `2026-07-14-tool-detail-shells-migration.md` before removing temporary detail templates or compatibility adapters.

# Tool Detail Shells and Release Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all 11 existing processors into catalog-driven `file` or `workspace` detail shells, remove the old rigid three-step/same-format templates, clean migration adapters, and release the scalable navigation through the existing Cloudflare Git pipeline.

**Architecture:** Each route continues to import only its own workbench and injects that `ReactNode` into one lightweight shared shell. The shell reads catalog identity, implementation copy, execution disclosure, preferences, and exactly three related tools; it never owns processor selection or dynamically imports workbenches. Migration proceeds through one representative file route and one workspace route, then image routes, then PDF routes, followed by compatibility cleanup and release smoke checks.

**Tech Stack:** React 19 server/client components, Next.js 16 static export, TypeScript 6, CSS Modules, Vitest 4, Playwright 1.61, Node.js 24 release scripts, GitHub CI, Cloudflare Pages Git integration.

## Global Constraints

- Complete the catalog-foundation and discovery-navigation plans first in the same isolated feature worktree.
- Preserve every canonical URL, processor contract, source/result limit, Worker boundary, progress/cancellation path, warning, filename rule, explicit start action, and explicit save action.
- Never create a central tool-ID-to-workbench import map. Each route directly imports only its own workbench.
- Current inventory supports `file` and `workspace`; validate but do not render an unused `quick` shell or create a fake quick route.
- All current tools remain `execution: "browser"` and visibly say `이 기기에서 처리`; a future server tool requires a separately reviewed pre-transfer disclosure.
- File and result data stay local. Never log source bytes, filenames, thumbnails, object URLs, or presigned URLs.
- Related actions come only from the catalog's ordered three IDs. Do not regenerate a same-format list.
- Discovery/header bundles must remain processor-free and within Plan 2 gzip budgets after every route migration.
- Production deploys only from the GitHub-connected Cloudflare Pages `main` branch. Never run `wrangler pages project create`, `wrangler pages deploy`, or Direct Upload.
- Use RED → GREEN → REFACTOR and the focused Conventional Commit listed in each task.

---

## File Map

### New shared shell and release verification

- `apps/web/src/components/tool-detail-page.tsx` — catalog-driven file/workspace page composition.
- `apps/web/src/components/tool-detail-page.module.css` — responsive shared detail presentation.
- `tests/e2e/tool-detail-shells.spec.ts` — shell, relation, responsive, and accessibility regression coverage.
- `tests/tool-route-import-boundary.test.ts` — requires each route to directly import exactly its assigned workbench.
- `apps/web/src/lib/tool-implementations.test.ts` — final keyed implementation ownership tests.
- `scripts/smoke-navigation.mjs` — GET-only local/preview/production navigation smoke.

### Migrated route modules

- `apps/web/src/app/image/compress/page.tsx`, `resize/page.tsx`, `convert/page.tsx`, `watermark/page.tsx`.
- `apps/web/src/app/pdf/merge/page.tsx`, `split/page.tsx`, `organize/page.tsx`, `watermark/page.tsx`, `image-to-pdf/page.tsx`, `to-image/page.tsx`, `compress/page.tsx`.

### Removed compatibility UI/data

- `apps/web/src/components/image-tool-page.tsx`.
- `apps/web/src/components/pdf-tool-page.tsx`.
- `apps/web/src/components/pdf-editing-tool-page.tsx`.
- `apps/web/src/lib/site.ts` and `apps/web/src/lib/site.test.ts` after all consumers are migrated.
- Obsolete detail classes in `apps/web/src/app/globals.css`.

### Updated long-lived files

- `apps/web/src/lib/tool-implementations.ts` — retain only runtime/bundle/limit/detail-copy fields.
- `apps/web/src/components/pdf-compress-workbench.tsx` — consume its warning from final implementation data.
- `scripts/verify-static-export.mjs`, `tests/e2e/tool-pages.spec.ts`, and processor suites — final shell expectations.
- `README.md`, `docs/architecture.md`, `docs/deployment.md` — catalog, local discovery, shell, bundle, and release behavior.

### Task 1: Add representative file and workspace shells

**Files:**
- Create: `apps/web/src/components/tool-detail-page.tsx`
- Create: `apps/web/src/components/tool-detail-page.module.css`
- Create: `tests/e2e/tool-detail-shells.spec.ts`
- Create: `tests/tool-route-import-boundary.test.ts`
- Modify: `apps/web/src/app/image/compress/page.tsx`
- Modify: `apps/web/src/app/pdf/organize/page.tsx`
- Modify: `tests/e2e/mobile.spec.ts`

**Interfaces:**
- Consumes: `getAvailableToolById()`, `getRelatedAvailableTools()`, `getToolImplementation()`, `ToolCard`, `FavoriteToolButton`, `ToolVisitTracker`, and a route-owned workbench node.
- Produces: the only shared detail shell interface used by every remaining route.

~~~tsx
export interface ToolDetailPageProps {
  toolId: AvailableToolId;
  workbench: ReactNode;
}
export function ToolDetailPage(props: ToolDetailPageProps): ReactNode;
~~~

- [ ] **Step 1: Write failing representative shell tests**

In `tool-detail-shells.spec.ts`, assert `/image/compress` contains navigation labelled `현재 위치`, a heading from catalog identity, region `처리 방식` containing `이 기기에서 처리`, region `파일 작업 영역`, favorite control, and region `다음 작업` with exactly these links in order: resize, convert, watermark.

Assert `/pdf/organize` uses `편집 작업 공간`, not `파일 작업 영역`; its next links are merge, split, PDF watermark; it retains page reordering/rotation/deletion/reset and an explicit mobile sticky save action. Both routes omit the old fixed `사용 방법`/three-step block and do not show every same-format tool.

~~~ts
await expect(page.getByRole("region", { name: "파일 작업 영역" })).toBeVisible();
const links = page.getByRole("region", { name: "다음 작업" }).getByRole("link");
await expect(links).toHaveCount(3);
await expect(links.nth(0)).toHaveAttribute("href", "/image/resize");
await expect(links.nth(1)).toHaveAttribute("href", "/image/convert");
await expect(links.nth(2)).toHaveAttribute("href", "/image/watermark");
~~~

In `tool-route-import-boundary.test.ts`, parse route imports with installed TypeScript and require `/image/compress` to import `image-workbench` exactly once and `/pdf/organize` to import `pdf-workbench` exactly once. Count only the five workbench module specifiers, reject any second workbench, and require the import to be in the page module rather than a central registry.

- [ ] **Step 2: Run representative tests and verify RED**

Run:

~~~bash
pnpm --filter @hereisit/web build
pnpm test tests/tool-route-import-boundary.test.ts --run
pnpm exec playwright test tests/e2e/tool-detail-shells.spec.ts --project=chromium
pnpm exec playwright test tests/e2e/mobile.spec.ts --project=mobile-chromium
~~~

Expected: FAIL because both routes still use legacy page templates.

- [ ] **Step 3: Implement the shared shell without a workbench registry**

~~~tsx
import type { AvailableToolId } from "@hereisit/tool-registry/catalog";
import { getAvailableToolById, getRelatedAvailableTools } from "@hereisit/tool-registry/catalog";
import type { ReactNode } from "react";
import Link from "next/link";
import { getToolImplementation } from "../lib/tool-implementations";
import { FavoriteToolButton } from "./favorite-tool-button";
import { SiteFooter } from "./site-footer";
import { SiteHeader } from "./site-header";
import { ToolCard } from "./tool-card";
import { ToolVisitTracker } from "./tool-visit-tracker";
import styles from "./tool-detail-page.module.css";

export interface ToolDetailPageProps {
  toolId: AvailableToolId;
  workbench: ReactNode;
}

export function ToolDetailPage({ toolId, workbench }: ToolDetailPageProps): ReactNode {
  const tool = getAvailableToolById(toolId);
  const implementation = getToolImplementation(toolId);
  const related = getRelatedAvailableTools(toolId);
  if (tool.execution !== "browser") {
    throw new Error(`Server execution disclosure is not implemented: ${toolId}`);
  }
  if (tool.experience === "quick") {
    throw new Error(`Quick detail shell is not implemented: ${toolId}`);
  }
  const workAreaLabel = tool.experience === "workspace" ? "편집 작업 공간" : "파일 작업 영역";
  const primaryDomain = tool.domains[0];
  return (
    <>
      <ToolVisitTracker toolId={toolId} />
      <SiteHeader activePath={tool.route} />
      <main className={styles.page}>
        <nav aria-label="현재 위치" className={styles.breadcrumbs}>
          <Link href="/">홈</Link>
          <Link href={`/tools?domain=${primaryDomain}`}>모든 도구</Link>
          <span aria-current="page">{tool.name}</span>
        </nav>
        <header className={styles.hero}>
          <p className={styles.eyebrow}>{implementation.eyebrow}</p>
          <div className={styles.titleRow}>
            <h1>{tool.name}</h1>
            <FavoriteToolButton toolId={toolId} />
          </div>
          <p>{tool.shortDescription}</p>
          <p>{implementation.defaultSummary}</p>
          <section aria-label="처리 방식" className={styles.execution}>
            <strong>이 기기에서 처리</strong>
            <span>파일은 업로드되지 않으며 저장은 직접 선택해요.</span>
          </section>
          {implementation.notices.map((notice) => (
            <p className={notice.tone === "warning" ? styles.warning : styles.support} key={notice.text}>
              {notice.text}
            </p>
          ))}
        </header>
        <section aria-label={workAreaLabel} className={tool.experience === "workspace" ? styles.workspace : styles.file}>
          {workbench}
        </section>
        <section aria-label="다음 작업" className={styles.related}>
          <h2>다음 작업</h2>
          <div className={styles.relatedGrid}>
            {related.map((item) => <ToolCard context="related" key={item.id} tool={item} />)}
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
~~~

The route—not this component—constructs `workbench`. This keeps every other workbench/Worker outside the route closure. The current implementation has only browser tools; the explicit throw prevents accidental generic copy for a future server tool.

- [ ] **Step 4: Migrate the two representative routes directly**

Use the same shape in both route modules, with their existing metadata constants unchanged:

~~~tsx
const toolId = "image.compress" satisfies AvailableToolId;
const implementation = getToolImplementation(toolId);
export const metadata = createToolMetadata(getAvailableToolById(toolId));

export default function Page() {
  return (
    <ToolDetailPage
      toolId={toolId}
      workbench={<ImageWorkbench intent={implementation.intent} toolId={toolId} />}
    />
  );
}
~~~

For organize, use `toolId = "pdf.organize"`, `const implementation = getToolImplementation(toolId)`, and `<PdfWorkbench intent={implementation.intent} toolId={toolId} />`. Do not import any other workbench into either page. Processor intent remains authored only in `toolImplementationConfig`.

- [ ] **Step 5: Style file/workspace semantics and verify GREEN**

CSS keeps readable line lengths, responsive title/favorite alignment, notice tone plus text/icon (not color alone), three-column related cards falling to two/one, visible focus, 44px controls, reduced motion, and no horizontal scroll. Do not override the workbench's own workspace/sticky action layout.

Run:

~~~bash
pnpm --filter @hereisit/web build
pnpm exec playwright test tests/e2e/tool-detail-shells.spec.ts --project=chromium
pnpm exec playwright test tests/e2e/mobile.spec.ts --project=mobile-chromium
pnpm verify:export
~~~

Expected: PASS and representative route closures retain their original exact Worker markers.

- [ ] **Step 6: Commit the representative shell**

~~~bash
git add apps/web/src/components/tool-detail-page.tsx apps/web/src/components/tool-detail-page.module.css apps/web/src/app/image/compress/page.tsx apps/web/src/app/pdf/organize/page.tsx tests/tool-route-import-boundary.test.ts tests/e2e/tool-detail-shells.spec.ts tests/e2e/mobile.spec.ts
git commit -m "feat: add catalog-driven tool detail shells"
~~~

### Task 2: Migrate the remaining image routes

**Files:**
- Modify: `apps/web/src/app/image/resize/page.tsx`
- Modify: `apps/web/src/app/image/convert/page.tsx`
- Modify: `apps/web/src/app/image/watermark/page.tsx`
- Delete: `apps/web/src/components/image-tool-page.tsx`
- Modify: `tests/e2e/tool-detail-shells.spec.ts`
- Modify: `tests/e2e/tool-pages.spec.ts`
- Modify: `tests/e2e/image-workbench.spec.ts`
- Modify: `tests/e2e/image-watermark.spec.ts`
- Modify: `tests/tool-route-import-boundary.test.ts`

**Interfaces:**
- Consumes: `ToolDetailPage` and existing keyed workbench props.
- Produces: four route-owned image compositions with no legacy image template.

- [ ] **Step 1: Add failing exact-relation and bundle tests for three routes**

For each route assert `파일 작업 영역`, local execution disclosure, absence of fixed steps, and exact ordered catalog next actions:

- resize → compress, convert, watermark;
- convert → compress, resize, image-to-PDF;
- image watermark → compress, resize, PDF watermark.

Retain the existing image pipeline/watermark Worker isolation, HEIC support note, manual settings, output, saving, privacy, and cancellation assertions.

Extend the source import map so resize/convert each require only `image-workbench` and image watermark requires only `image-watermark-workbench`.

- [ ] **Step 2: Run image tests and verify RED**

Run: `pnpm --filter @hereisit/web build && pnpm exec playwright test tests/e2e/tool-detail-shells.spec.ts tests/e2e/tool-pages.spec.ts tests/e2e/image-workbench.spec.ts tests/e2e/image-watermark.spec.ts --project=chromium`

Expected: FAIL for the three routes still using `ImageToolPage`.

- [ ] **Step 3: Replace each legacy wrapper with direct composition**

Use this complete mapping:

~~~tsx
// resize/page.tsx
const toolId = "image.resize" satisfies AvailableToolId;
const implementation = getToolImplementation(toolId);
<ToolDetailPage toolId={toolId} workbench={
  <ImageWorkbench intent={implementation.intent} toolId={toolId} />
} />

// convert/page.tsx
const toolId = "image.convert" satisfies AvailableToolId;
const implementation = getToolImplementation(toolId);
<ToolDetailPage toolId={toolId} workbench={
  <ImageWorkbench intent={implementation.intent} toolId={toolId} />
} />

// watermark/page.tsx
const toolId = "image.watermark" satisfies AvailableToolId;
<ToolDetailPage toolId={toolId} workbench={
  <ImageWatermarkWorkbench toolId={toolId} />
} />
~~~

Each commented fragment is a separate route module. Pass the catalog entry to `createToolMetadata`, use the keyed implementation's literal intent, and do not import a component/processor used by another route. After all three compile, delete `image-tool-page.tsx` and remove its imports.

- [ ] **Step 4: Verify GREEN, export isolation, and commit**

Run:

~~~bash
pnpm --filter @hereisit/web build
pnpm test tests/tool-route-import-boundary.test.ts --run
pnpm exec playwright test tests/e2e/tool-detail-shells.spec.ts tests/e2e/tool-pages.spec.ts tests/e2e/image-workbench.spec.ts tests/e2e/image-watermark.spec.ts --project=chromium
pnpm verify:export
~~~

Expected: PASS; only the three pipeline routes contain the image Worker and only watermark contains its dedicated Worker.

~~~bash
git add apps/web/src/app/image apps/web/src/components/image-tool-page.tsx tests/tool-route-import-boundary.test.ts tests/e2e/tool-detail-shells.spec.ts tests/e2e/tool-pages.spec.ts tests/e2e/image-workbench.spec.ts tests/e2e/image-watermark.spec.ts
git commit -m "refactor: migrate image routes to detail shells"
~~~

### Task 3: Migrate the remaining PDF routes

**Files:**
- Modify: `apps/web/src/app/pdf/merge/page.tsx`
- Modify: `apps/web/src/app/pdf/split/page.tsx`
- Modify: `apps/web/src/app/pdf/watermark/page.tsx`
- Modify: `apps/web/src/app/pdf/image-to-pdf/page.tsx`
- Modify: `apps/web/src/app/pdf/to-image/page.tsx`
- Modify: `apps/web/src/app/pdf/compress/page.tsx`
- Delete: `apps/web/src/components/pdf-tool-page.tsx`
- Delete: `apps/web/src/components/pdf-editing-tool-page.tsx`
- Modify: `tests/e2e/tool-detail-shells.spec.ts`
- Modify: `tests/e2e/tool-pages.spec.ts`
- Modify: `tests/e2e/pdf-tools.spec.ts`
- Modify: `tests/e2e/pdf-to-images.spec.ts`
- Modify: `tests/e2e/pdf-compression.spec.ts`
- Modify: `tests/tool-route-import-boundary.test.ts`

**Interfaces:**
- Consumes: the shared shell and existing `PdfWorkbench`, `PdfToImageWorkbench`, and `PdfCompressWorkbench`.
- Produces: seven direct PDF route compositions and no legacy PDF wrapper.

- [ ] **Step 1: Add failing PDF shell assertions**

Assert all six remaining routes use `파일 작업 영역`, exact catalog relations, notices, and local execution disclosure. In particular, replace the old `/pdf/merge` expectation that automatically showed compression/to-image with exactly split, organize, image-to-PDF. For scanned compression, before processing require exactly two copies of the destructive warning: one in the shared shell and one beside the workbench controls. After a result exists, additionally require the result-region warning while keeping those two; do not weaken the existing region-scoped assertion or replace it with an ambiguous total count.

- [ ] **Step 2: Run PDF tests and verify RED**

Run: `pnpm --filter @hereisit/web build && pnpm exec playwright test tests/e2e/tool-detail-shells.spec.ts tests/e2e/tool-pages.spec.ts tests/e2e/pdf-tools.spec.ts tests/e2e/pdf-to-images.spec.ts tests/e2e/pdf-compression.spec.ts --project=chromium`

Expected: FAIL while routes still use `PdfToolPage`/`PdfEditingToolPage`.

- [ ] **Step 3: Directly compose every editing workbench route**

Use these route-owned nodes:

| ID | Route-owned workbench node |
| --- | --- |
| `pdf.merge` | `<PdfWorkbench intent={implementation.intent} toolId={toolId} />` |
| `pdf.split` | `<PdfWorkbench intent={implementation.intent} toolId={toolId} />` |
| `pdf.watermark` | `<PdfWorkbench intent={implementation.intent} toolId={toolId} />` |
| `pdf.image-to-pdf` | `<PdfWorkbench intent={implementation.intent} toolId={toolId} />` |
| `pdf.to-image` | `<PdfToImageWorkbench toolId={toolId} />` |
| `pdf.compress-scanned` | `<PdfCompressWorkbench toolId={toolId} />` |

Each route declares `const toolId` from its table ID with `satisfies AvailableToolId`, builds catalog metadata, imports exactly the listed workbench, and injects it into `ToolDetailPage`. Editing routes also declare `const implementation = getToolImplementation(toolId)` and pass its literal-preserving `intent`; no route re-authors the intent string. Extend `tool-route-import-boundary.test.ts`: merge/split/organize/PDF-watermark/image-to-PDF require only `pdf-workbench`, to-image only `pdf-to-image-workbench`, and compress only `pdf-compress-workbench`. Do not create a switch, dynamic import map, registry callback, or barrel that imports all workbenches. Once all seven PDF routes compile, delete both legacy PDF templates.

- [ ] **Step 4: Verify GREEN across desktop/mobile processors**

Run:

~~~bash
pnpm --filter @hereisit/web build
pnpm test tests/tool-route-import-boundary.test.ts --run
pnpm exec playwright test tests/e2e/tool-detail-shells.spec.ts tests/e2e/tool-pages.spec.ts tests/e2e/pdf-tools.spec.ts tests/e2e/pdf-to-images.spec.ts tests/e2e/pdf-compression.spec.ts --project=chromium
pnpm exec playwright test tests/e2e/mobile.spec.ts --project=mobile-chromium
pnpm verify:export
~~~

Expected: PASS with PDF editing, to-images, and scanned-compression marker profiles still isolated.

- [ ] **Step 5: Commit PDF migration**

~~~bash
git add apps/web/src/app/pdf apps/web/src/components/pdf-tool-page.tsx apps/web/src/components/pdf-editing-tool-page.tsx tests/tool-route-import-boundary.test.ts tests/e2e/tool-detail-shells.spec.ts tests/e2e/tool-pages.spec.ts tests/e2e/pdf-tools.spec.ts tests/e2e/pdf-to-images.spec.ts tests/e2e/pdf-compression.spec.ts tests/e2e/mobile.spec.ts
git commit -m "refactor: migrate PDF routes to detail shells"
~~~

### Task 4: Remove temporary adapters and obsolete detail CSS

**Files:**
- Create: `apps/web/src/lib/tool-implementations.test.ts`
- Modify: `apps/web/src/lib/tool-implementations.ts`
- Modify: `apps/web/src/components/pdf-compress-workbench.tsx`
- Modify: `apps/web/src/app/globals.css`
- Modify: `scripts/verify-static-export.mjs`
- Delete: `apps/web/src/lib/site.ts`
- Delete: `apps/web/src/lib/site.test.ts`

**Interfaces:**
- Consumes: all routes now using catalog and final implementation configuration directly.
- Produces: one final implementation data owner with no legacy page/list/config facade.

- [ ] **Step 1: Move final ownership tests before deleting adapters**

Create `tool-implementations.test.ts` with the key-set, catalog launcher count agreement, positive byte limits, constrained-total ordering, supported bundle-profile, browser execution, and notice-copy tests formerly held in `site.test.ts`:

~~~ts
expect(Object.keys(toolImplementationConfig).sort()).toEqual(
  availableToolEntries.map(({ id }) => id).sort(),
);
for (const tool of availableToolEntries) {
  const limits = getToolImplementation(tool.id).sourceFileLimits;
  expect([limits.minFiles, limits.maxFiles, limits.maxFileBytes, limits.maxTotalBytes]
    .every((value) => Number.isInteger(value) && value > 0)).toBe(true);
  expect(tool.launcherInput).toMatchObject({
    minFiles: limits.minFiles,
    maxFiles: limits.maxFiles,
  });
}
~~~

- [ ] **Step 2: Run the new test and verify it is GREEN before deletion**

Run: `pnpm test apps/web/src/lib/tool-implementations.test.ts apps/web/src/lib/site.test.ts --run`

Expected: PASS for both old and new ownership tests; this proves coverage was moved before deleting the old file.

- [ ] **Step 3: Remove legacy-only fields and exports**

Delete `legacyNavLabel`, `legacySteps`, and `ToolStep` from `ToolImplementationConfig` and every record. Retain `family`, `bundleProfile`, typed intent/class, `sourceFileLimits`, `eyebrow`, `defaultSummary`, and `notices` because the verifier, workbenches, and shared shell use them.

Change `pdf-compress-workbench.tsx` to read its exact warning from the keyed notices:

~~~ts
const PDF_COMPRESS_SCANNED_WARNING = getToolImplementation("pdf.compress-scanned")
  .notices.find(({ tone }) => tone === "warning")?.text;
if (PDF_COMPRESS_SCANNED_WARNING === undefined) {
  throw new Error("Missing scanned PDF warning");
}
~~~

Delete `site.ts` and `site.test.ts`. The following names must have zero remaining consumers in `apps/web` and `scripts`: `imageTools`, `pdfTools`, `imageToolList`, `pdfToolList`, `relatedImageTools`, `relatedPdfTools`, `ImageToolConfig`, `PdfToolConfig`, `ToolStep`, `categoryNavigation`, and `toolList`.

- [ ] **Step 4: Remove only proven-dead global classes**

Run before editing:

~~~bash
rg -n 'tool-steps|related-tools-section|related-tool-card|tool-hero|tool-summary|tool-note|tool-warning' apps/web/src
~~~

Delete a class from `globals.css` only when this search shows no TSX consumer after migrations. Preserve generic home classes such as `feature-grid` and `principles-section` if the new home still uses them. Shell-specific styling stays in `tool-detail-page.module.css`.

- [ ] **Step 5: Prove compatibility names and processor leakage are gone**

Run:

~~~bash
rg -n '\b(imageTools|pdfTools|imageToolList|pdfToolList|relatedImageTools|relatedPdfTools|ImageToolConfig|PdfToolConfig|ToolStep|categoryNavigation|toolList)\b' apps/web scripts
pnpm test apps/web/src/lib/tool-implementations.test.ts --run
pnpm verify
~~~

Expected: `rg` exits 1 with no matches; tests and verification exit 0. Update `verify-static-export.mjs` only for renamed final config fields, never to relax marker checks.

- [ ] **Step 6: Commit cleanup**

~~~bash
git add apps/web/src/lib/tool-implementations.ts apps/web/src/lib/tool-implementations.test.ts apps/web/src/lib/site.ts apps/web/src/lib/site.test.ts apps/web/src/components/pdf-compress-workbench.tsx apps/web/src/app/globals.css scripts/verify-static-export.mjs
git commit -m "refactor: remove legacy tool page registries"
~~~

### Task 5: Add release smoke, update docs, and verify deployment

**Files:**
- Create: `scripts/smoke-navigation.mjs`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/deployment.md`
- Modify: `docs/testing/discovery-accessibility-checklist.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: the completed static export, navigation routes, shared detail shell, existing processor smokes, and current Git deployment.
- Produces: repeatable local/preview/production evidence for the scalable navigation release.

- [ ] **Step 1: Write the navigation smoke with a deliberate failing assertion**

Follow existing smoke script conventions: default to `https://hereisit.pages.dev`, accept one HTTP(S) origin argument, launch headless Chromium, reject redirects/cross-origin/write-method/request-body/failed-request/page-error activity, and validate security headers. First add this temporary assertion after loading home:

~~~js
assert.equal(
  await page.getByText("HEREISIT_NAVIGATION_SMOKE_RED_SENTINEL", { exact: true }).count(),
  1,
  "RED sentinel proves the navigation smoke executed",
);
~~~

Start `pnpm --filter @hereisit/web preview:test`, then in a second command session run:

`node scripts/smoke-navigation.mjs http://127.0.0.1:4173`

Expected: nonzero exit containing `RED sentinel proves the navigation smoke executed`. Stop preview, remove only this sentinel assertion, and proceed to the real checks in Step 2.

- [ ] **Step 2: Implement the complete read-only smoke**

For `/`, `/tools`, `/my-tools`, `/workflows`, `/image/compress`, and `/pdf/organize`, request with `maxRedirects: 0` and require HTTP 200. In browser navigation assert:

- the approved header labels and search;
- home file launcher, eight tabs, attached selected panel, and no mounted workbench;
- `/tools` available catalog plus `/tools?planned=1` route-less `준비 중` card behavior;
- `noindex,follow` on `/my-tools` and `/workflows`;
- file/workspace accessible region labels and `이 기기에서 처리`;
- exactly three next-action links on each representative detail page;
- absence of the old fixed three-step block;
- no external request, write method, request body, redirect, failed request, console page error, or automatic download.

Print only route/status/assertion labels. Do not print search contents, filenames, storage, or browser state.

- [ ] **Step 3: Document final architecture and operator commands**

Update README's feature/development sections with catalog search, local file recommendation, `/tools`, local ID-only preferences, file/workspace shells, and this command:

~~~bash
node scripts/smoke-navigation.mjs http://127.0.0.1:3000
~~~

Update `docs/architecture.md` with catalog vs implementation ownership, discovery import boundary, prefix detector limits, pending handoff lifetime, preference schema, route-owned workbench composition, and gzip gates. Update `docs/deployment.md` with the navigation smoke in local/preview/production blocks and manual accessibility result recording. Extend `docs/testing/discovery-accessibility-checklist.md` with VoiceOver/Safari and NVDA/Firefox-or-Chrome checks for one `file` and one `workspace` page: breadcrumb, execution disclosure, notices, work area label, explicit start/save, exactly three next actions, organize controls, and sticky export. Preserve the deployment guide's explicit prohibition on Direct Upload and `wrangler pages deploy`.

Add a `smoke:navigation` package script targeting the script's default production origin; do not add a deploy script.

- [ ] **Step 4: Run the complete local release matrix**

Run fresh:

~~~bash
pnpm verify
pnpm exec playwright install --with-deps chromium firefox webkit
PLAYWRIGHT_WEBKIT=1 pnpm verify:all
pnpm --filter @hereisit/web preview:test
~~~

With preview running on port 4173, run in a second command session:

~~~bash
node scripts/smoke-navigation.mjs http://127.0.0.1:4173
node scripts/smoke-image-watermark.mjs http://127.0.0.1:4173
node scripts/smoke-pdf-compress.mjs http://127.0.0.1:4173
node scripts/smoke-pdf-to-images.mjs http://127.0.0.1:4173
~~~

Expected: all verification and four smokes exit 0. Stop the preview process cleanly after the smokes.

- [ ] **Step 5: Commit release verification**

~~~bash
git add scripts/smoke-navigation.mjs README.md docs/architecture.md docs/deployment.md docs/testing/discovery-accessibility-checklist.md package.json
git commit -m "test: verify scalable navigation release"
~~~

- [ ] **Step 6: Publish the feature branch and validate the preview**

Run `superpowers:finishing-a-development-branch`, then push the feature branch and open a ready pull request. Wait for GitHub CI's Chromium/Firefox/WebKit/mobile matrix and the Cloudflare Pages preview check for the exact head SHA. Run all four smokes against the HTTPS preview URL; record the URL, SHA, commands, exit codes, and available manual accessibility results in the PR without file-derived data.

Expected: CI, Cloudflare preview, navigation smoke, and all three processor smokes succeed for the same SHA. Do not merge on partial or stale evidence.

- [ ] **Step 7: Merge through Git and verify production**

After review approval, squash-merge the PR into `main`; do not upload `apps/web/out`. Wait for GitHub CI and Cloudflare Pages production deployment to succeed for the exact merge SHA, then run:

~~~bash
node scripts/smoke-navigation.mjs https://hereisit.pages.dev
node scripts/smoke-image-watermark.mjs https://hereisit.pages.dev
node scripts/smoke-pdf-compress.mjs https://hereisit.pages.dev
node scripts/smoke-pdf-to-images.mjs https://hereisit.pages.dev
~~~

Expected: all four commands exit 0 against the canonical HTTPS origin. If production verification fails, stop, preserve the failing evidence, and use the existing Git workflow for a reviewed fix/revert—never repair production with direct Wrangler upload.

## Completion Checkpoint

The redesign is complete only when all 11 canonical processors use the catalog shell, no legacy registry/template remains, exact related actions render, discovery budgets and full browser suites pass, the Cloudflare preview for the release SHA passes all smokes, the reviewed Git merge deploys, and the same smokes pass on `https://hereisit.pages.dev`.

# Smart Local PDF Compression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve general PDF structure while automatically using the existing strong raster compressor only for confidently image-only scans.

**Architecture:** The worker tries an object-stream rewrite before opening PDF.js. If the candidate misses the 1% target, PDF.js supplies conservative page signals during the existing planning pass; only an all-image-only document may enter the raster pipeline.

**Tech Stack:** TypeScript, Zod, `@cantoo/pdf-lib`, PDF.js 6.2.108, Vitest, React 19, Next.js 16

## Global Constraints

- Files stay in the browser and are never logged or uploaded.
- Input remains capped at 50MB and 100 pages.
- Results must be at least 1% smaller than the source.
- Uncertain classification preserves structure and never authorizes rasterization.
- Add no dependency.
- Keep the current direct-download, minimal-screen UI.

---

### Task 1: Conservative page classification

**Files:**
- Create: `packages/pdf-tool/src/compression-profile.ts`
- Create: `packages/pdf-tool/src/compression-profile.test.ts`
- Modify: `packages/pdf-tool/src/index.ts`
- Modify: `packages/browser-runtime/src/pdf-raster-runtime.ts`

**Interfaces:**
- Produces: `classifyPdfCompressionDocument(pages): "image-only" | "structured"`
- Produces: `inspectPdfRasterPage(page): Promise<PdfCompressionPageSignals>`

- [ ] **Step 1: Write failing pure tests** for image-only pages, text, annotations, vector paths,
  forms, shading, and mixed documents.
- [ ] **Step 2: Run** `pnpm --filter @hereisit/pdf-tool test -- compression-profile.test.ts` and
  confirm the missing module failure.
- [ ] **Step 3: Implement the minimal classifier** where every page must have `imagePaints >= 1` and
  all destructive-risk counters equal zero.
- [ ] **Step 4: Extend the PDF.js page adapter** to count non-whitespace text, annotations, image paint
  operators, and the disqualifying operator set without exposing raw page data.
- [ ] **Step 5: Run** `pnpm --filter @hereisit/pdf-tool test -- compression-profile.test.ts` and
  `pnpm --filter @hereisit/browser-runtime test -- pdf-raster-runtime.test.ts` and confirm both pass.
- [ ] **Step 6: Commit** `feat: classify safe scanned pdfs`.

### Task 2: Structure-first compression contract and pipeline

**Files:**
- Modify: `packages/tool-contracts/src/index.ts`
- Modify: `packages/tool-contracts/src/index.test.ts`
- Modify: `packages/browser-runtime/src/pdf-compress-scanned-pipeline.ts`
- Modify: `packages/browser-runtime/src/pdf-compress-scanned-pipeline.test.ts`
- Modify: `packages/browser-runtime/src/run-pdf-compress-scanned-job.ts`
- Modify: `packages/browser-runtime/src/run-pdf-compress-scanned-job.test.ts`

**Interfaces:**
- Produces: `PdfCompressMode = "structure-preserving" | "rasterized"`
- Extends: `PdfCompressScannedResult` with required `mode`

- [ ] **Step 1: Write failing contract and pipeline tests** proving exact mode/warning validation,
  early structural success, structured no-reduction, and image-only raster fallback.
- [ ] **Step 2: Run** the two focused package test commands and confirm failures identify the missing
  discriminator and strategy branch.
- [ ] **Step 3: Implement the structural candidate** with `PDFDocument.load`, object-stream save,
  exact envelope/page-count checks, and the existing target calculation.
- [ ] **Step 4: Gate the existing raster branch** with the Task 1 document profile; return the existing
  no-reduction error when structure must be preserved.
- [ ] **Step 5: Make the public decoder mode-aware** and reject any mode, warning, preset, page-count,
  timing, envelope, or byte-length mismatch.
- [ ] **Step 6: Run** `pnpm --filter @hereisit/tool-contracts test` and
  `pnpm --filter @hereisit/browser-runtime test -- pdf-compress-scanned` and confirm they pass.
- [ ] **Step 7: Commit** `feat: preserve structure during pdf compression`.

### Task 3: Honest minimal UI and release verification

**Files:**
- Modify: `apps/web/src/components/pdf-compress-workbench.tsx`
- Modify: `apps/web/src/lib/tool-implementations.ts`
- Modify: `tests/e2e/pdf-compression.spec.ts`

**Interfaces:**
- Consumes: `PdfCompressScannedResult.mode`
- Produces: mode-specific Korean result copy and unchanged direct download behavior

- [ ] **Step 1: Update the browser test** to expect structure-preserving and rasterized result notes.
- [ ] **Step 2: Replace scan-only setup copy** with one concise automatic-processing explanation and
  derive the result note from `result.mode`.
- [ ] **Step 3: Run** `pnpm --filter @hereisit/web test` and the focused PDF compression browser test.
- [ ] **Step 4: Run** `pnpm lint:fix`, focused package tests, and `pnpm verify`; record the known local
  Docker `ENOSPC` ceiling if the unrelated image-engine container stage is reached.
- [ ] **Step 5: Commit** `feat: explain smart pdf compression`, push the branch, open the pull request,
  wait for required CI, merge, and verify the production route returns HTTP 200.


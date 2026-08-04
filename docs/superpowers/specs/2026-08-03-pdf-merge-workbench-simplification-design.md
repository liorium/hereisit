# PDF Merge Workbench Simplification Design

**Status:** Approved on 2026-08-03  
**Approved direction:** Replace the PDF merge three-column workbench with a focused setup,
processing, and result flow

## Summary

Simplify `/pdf/merge` around one task at a time:

1. select and order PDF files;
2. merge them with honest local progress;
3. review the page count and file-size result, then download.

The merge operation, browser Worker, versioned contract, file limits, and direct-download behavior
remain unchanged. This change adds lightweight input inspection for page counts and changes the merge
presentation. It does not redesign the other PDF tools or add a server path.

## Context and problem

The current merge workbench presents file ordering, a non-actionable settings column, an empty result
preview, progress, status, and actions at the same time. The layout makes a simple operation feel more
complex than it is, especially on mobile. Before a run, users need only confirm the selected PDFs and
their order. After a run, they need only confirm the result and download it.

The file list currently shows names and byte sizes but not page counts. Page count is useful for
confirming that the right documents and order were selected, and the existing PDF inspection Worker can
obtain it without uploading the files.

## Goals

- Make file selection, ordering, merging, and downloading unmistakable on desktop and mobile.
- Show only information needed for the current stage.
- Show each input's filename, byte size, and page count before merging.
- Keep ordering accessible through explicit up and down controls; do not rely on drag-and-drop.
- Show truthful processing phases and measured progress from the existing Worker.
- Make the completed page count, input size, output size, and download action the result focus.
- Keep every PDF on the device and preserve current cancellation, validation, warnings, and cleanup.
- Add no dependency and change no PDF processing contract.

## Non-goals

- Changing PDF merge output quality, compatibility, or serialization.
- Adding compression, page previews, drag sorting, password removal, cloud storage, or sharing.
- Redesigning split, organize, watermark, image-to-PDF, or PDF-to-image in this change.
- Extracting a new shared workbench abstraction before the merge flow has been validated.
- Adding a server-processing fallback.

## Approach decision

### Selected: merge-specific stage views in the existing component

For `intent === "merge"`, render one of three mutually exclusive views from the existing state:

- **Setup:** selection target, ordered file list, inspection state, local-processing notice, and run
  action.
- **Processing:** current phase, progress, and cancel action.
- **Result:** result summary, warnings when present, download, and restart action.

The existing `PdfWorkbench` state and processing functions remain authoritative. The other intents keep
their current rendering. This is the smallest change that isolates the approved product improvement
without forcing unrelated PDF redesigns.

### Rejected: redesign every PDF tool together

This would make the visual system consistent immediately, but it would mix five workflows with
different input and result requirements and make regression review unnecessarily broad.

### Rejected: keep the three columns and simplify their contents

This is a smaller CSS change, but setup and result would still compete for attention and the mobile
experience would remain dense.

## User experience contract

### Empty setup

The work area shows one large selection target with:

- `합칠 PDF 선택`;
- `PDF · 파일당 50MB · 최대 20개`;
- `파일은 업로드하지 않고 이 기기에서 처리해요.`

The native file input supports multiple selection and the existing drop target remains available.

### Selected setup

After valid files are selected, the work area shows:

- `N개 PDF` and combined input size;
- one ordered row per file with position, filename, byte size, and page count;
- up, down, and remove buttons with descriptive accessible names;
- `PDF 추가`, `전체 삭제`, and one primary `PDF 합치기` action.

Page counts are inspected sequentially, one file at a time, to bound decoded document memory. A pending
row says `페이지 확인 중`; a completed row says `N페이지`. The merge action remains disabled until at
least two valid files are selected and every selected file has a valid page count. An inspection error
stays on the affected row and explains that the file must be removed or replaced.

Adding, removing, or moving a file invalidates a prior result through the existing cleanup path.
Inspection results are keyed by the work-item ID, so duplicate filenames do not collide. Removed files
must not publish stale inspection results.

### Processing

Starting merge replaces setup with:

- `PDF 합치는 중`;
- the existing truthful phase label;
- the measured progress indicator;
- one secondary `중단` action.

No simulated percentage is shown. Cancellation returns to setup with the valid selection and completed
page-count inspections retained.

### Result

A successful result replaces processing with:

- `PDF 합치기 완료`;
- `N개 PDF · M페이지`;
- combined input size and result size, formatted as `12.4MB → 11.9MB`;
- one primary `결과 PDF 다운로드 ↓` action;
- one low-emphasis `다른 PDF 합치기` action.

The byte comparison is informational: PDF merging is not compression, so the UI must not claim a
saving percentage or describe a larger result as a failure. The result does not repeat the input list,
duration, generated filename, or setup controls.

If the result invalidates an existing digital signature, the current warning remains visible above the
download action. A download invocation failure leaves the result visible and places the existing retry
message next to the action.

### Failure and unsupported browsers

Invalid selections continue to use the current type, byte-size, combined-size, and count limits. The UI
shows one concise explanation near the selection target. If no browser PDF runtime is available, the
selection action stays disabled and names the supported current browsers.

A processing failure returns to setup with the selection intact and a direct error explanation. It does
not open a modal or clear the selected files.

## Data and state flow

The visible merge stage is derived from existing state:

~~~text
result exists                         -> result
processing                            -> processing
otherwise                             -> setup
~~~

Input inspection is a cancellable sequential queue over selected work-item IDs. Each fulfilled receipt
stores only the page count. The Worker releases each parsed document before the next inspection begins.
Selection changes cancel or ignore stale receipts with the existing run-generation pattern.

The merge still runs through `runPdfJob(files, { version: 1, operation: "merge" })`. The result page
count comes from `PdfPipelineResult.outputPageCount`, the input byte count from the selected files, and
the output byte count from `PdfPipelineResult.byteLength`. The object URL lifecycle and direct download
remain unchanged.

## Visual and responsive rules

- Keep the existing black, ivory, yellow, and neutral HereIsIt visual language; introduce no blue-led
  redesign.
- Use one centered column instead of the current three-column workspace.
- Use whitespace and type hierarchy instead of decorative cards and badges.
- Use tabular numerals for byte and page counts.
- Keep every interactive target at least 44 CSS pixels on touch screens.
- Keep the same content order on desktop and mobile.
- Allow filenames to truncate visually while preserving the full name in accessible text or a title.
- Do not use a sticky action unless browser testing demonstrates that the normal-flow action is hard to
  reach.

## Verification

- Unit-test the small merge-stage and inspection-readiness derivations if they are extracted as pure
  helpers; do not create helpers solely for testing.
- Extend browser tests to cover two-file selection, sequential page-count inspection, ordering, removal,
  merge progress, result page count, size comparison, direct download, restart, cancellation, and an
  inspection failure.
- Assert MIME signatures, output page count, and warnings rather than PDF byte equality.
- Verify keyboard focus, live status announcements, disabled states, and 44-pixel mobile controls.
- Run the focused PDF tests, production build, and the relevant browser flow before full verification.

## Acceptance criteria

- A user can select, inspect, reorder, merge, and download two PDFs without seeing unrelated settings.
- Every selected file has a clear page-count state before the merge action enables.
- Only the current stage is visible.
- The result clearly shows document count, page count, input size, output size, and one download action.
- Files never leave the browser, and stale inspections or object URLs are cancelled or released.
- Existing non-merge PDF routes retain their current behavior.

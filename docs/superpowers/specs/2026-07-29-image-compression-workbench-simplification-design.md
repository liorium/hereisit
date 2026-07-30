# Image Compression Workbench Simplification Design

**Status:** Approved on 2026-07-29
**Approved direction:** Replace the three-panel workbench with a focused setup, processing, and result flow

## Summary

Simplify `/image/compress` around one task at a time:

1. select images and start compression;
2. see honest processing progress;
3. compare the original and result sizes, then download.

The setup screen will show a recommended default and hide optional compression presets behind one
disclosure. Starting compression will replace the setup screen with progress. Completion will replace
progress with a result-only screen. A single result will emphasize its exact byte reduction and one
download action. A batch result will emphasize its total byte reduction and one ZIP download action,
with individual results hidden behind an optional disclosure.

The existing browser and server processing behavior, versioned contracts, limits, deletion lifecycle,
and direct-download implementation remain unchanged. This project changes presentation and interaction
order, not codec behavior.

## Context and problem

The current image-compression workbench shows all of the following at once:

- a processing-policy disclosure and, for server execution, a long deletion-policy paragraph;
- three numbered panels for file selection, presets, and results;
- a detailed file list with dimensions and per-item messages;
- a separate live batch message;
- result rows that repeat generated filenames and status messages;
- a sticky run or cancellation action.

This exposes implementation state instead of guiding the user through the current task. Before
compression, the primary file-selection and run actions compete with settings and policy copy. After
compression, the original controls remain visible even though the user's only immediate needs are to
understand the reduction and download the result.

The result also fails to make the most important product evidence prominent: the exact original size,
the exact output size, and the percentage saved.

## Goals

- Make the primary action unmistakable on desktop and mobile.
- Show only information needed for the current stage.
- Make exact input-to-output size reduction the visual focus of every successful result.
- Keep one dominant download action for a single result and one dominant ZIP action for a batch.
- Keep advanced compression choices available without forcing a first-time decision.
- Preserve explicit pre-selection disclosure whenever a file may leave the device.
- Preserve honest local fallback, failure, partial-success, cancellation, and original-retained states.
- Keep keyboard navigation, live progress announcements, visible focus, and minimum touch targets.
- Add no dependency and change no processing contract, codec, server route, or deployment setting.

## Non-goals

- Changing JPEG, PNG, or WebP compression behavior.
- Enabling or changing the server-processing rollout.
- Redesigning every image and PDF workbench in the same change.
- Adding automatic download, sharing, a save-location picker, or a result modal.
- Adding new presets, format conversion, image previews, before-and-after visual comparison, or quality
  metrics.
- Replacing the existing direct-download and remote-result deletion lifecycle.
- Creating a new design system or migrating the existing styling stack.

If the simplified compression flow validates well, its state-based presentation can become the
reference for other HereIsIt tools in separately verified changes.

## Approach decision

### Selected: replace the workbench contents by stage

Render one of three mutually exclusive views from the existing processing state:

- **Setup:** file selection, compact selection summary, collapsed settings, processing-location
  disclosure, and the run action.
- **Processing:** current phase, batch progress, and cancellation.
- **Result:** exact size comparison, saving percentage or original-retained explanation, and download.

The existing component state remains authoritative. The visible stage is derived from that state; no
new state-machine dependency or parallel source of truth is introduced.

### Rejected: collapse completed setup above the result

Keeping a one-line setup summary makes the prior choices easy to inspect, but it adds information after
the user has finished making those choices. It weakens the result hierarchy on small screens.

### Rejected: retain the current three panels and enlarge results

This is the smallest visual change, but it preserves the core problem: three stages remain visible when
only one stage is actionable.

### Rejected: process immediately after file selection

Automatic execution removes a click but also removes the user's chance to review the selected count,
change the preset, cancel an accidental selection, or read the required server-processing disclosure.

## User experience contract

### Shared page chrome

The existing global header, breadcrumb, tool title, and related-tools section remain. The workbench will
not repeat a second title, numbered step headings, or product-description copy.

### Setup view

The setup view contains, in order:

1. one large file drop and selection target labelled `이미지 선택`;
2. a compact selection summary after valid files are chosen;
3. one processing-location line;
4. one collapsed settings control;
5. one full-width `용량 줄이기` action.

Before selection, the file target includes only the supported formats and limits needed to make a valid
choice: `JPG, PNG, WebP · 파일당 30MB · 최대 20개`.

After selection:

- one file shows its filename and formatted input size;
- multiple files show their count and combined input size;
- detailed dimensions and per-file ready messages are not shown;
- invalid selections produce one concise inline explanation without adding a separate status panel.

The settings control is collapsed by default and reads `압축 설정 · 추천`. Expanding it exposes the
existing three choices:

- `추천`;
- `최소 용량`;
- `무손실`.

Changing a preset invalidates prior completed results exactly as it does today.

The processing-location line remains visible before the run action:

- checking: `처리 방식을 확인하고 있어요.`;
- local: `파일은 업로드하지 않고 이 기기에서 처리해요.`;
- server: `파일은 HereIsIt 처리 서버로 전송되며 작업 후 자동 삭제를 시도해요.`;
- fallback: a concise reason followed by `이 기기에서 처리해요.`.

The server line includes a low-emphasis `자세히` link to the privacy policy. The long retention
paragraph is removed from the workbench.

The run action is disabled until there is at least one valid file and the execution policy is known.
Its label is `용량 줄이기`; the selected count is already visible above it and is not repeated in the
button.

### Processing view

Starting a run removes the setup controls from view. The processing view contains:

- `이미지 압축 중`;
- current count such as `2/3`;
- the existing truthful phase label;
- one progress indicator;
- one secondary `중단` action.

Progress remains indeterminate when the runtime cannot provide a reliable fraction. No simulated
percentage is shown. Cancellation returns to setup with the valid selection retained.

### Single-result view

A successful single result contains:

- `압축 완료`;
- the formatted input and output sizes in one dominant line, for example
  `426.9KB → 167.5KB`;
- the calculated saving, for example `60.8% 줄였어요`;
- one full-width `결과 다운로드 ↓` action.

The result panel does not repeat the generated filename, preset, dimensions, processing location, phase
messages, or prior setup controls.

A low-emphasis `다른 이미지 압축` action sits outside the primary result panel. It disposes any
unconsumed remote handles under the existing lifecycle, clears the current selection, and returns to
setup.

### Multiple-result view

When two or more results complete, the initial batch result contains:

- `N개 이미지 압축 완료`;
- combined input and output sizes;
- combined saving percentage;
- one full-width `결과 N개 ZIP 다운로드 ↓` action;
- one low-emphasis `파일별 결과 보기` disclosure.

Expanding individual results shows one compact row per selected file with:

- original filename;
- input and output sizes, or an original-retained or failure explanation;
- the existing individual download action when available.

The disclosure is collapsed by default. The primary batch result does not repeat the individual list.
If the existing archive byte budget prevents ZIP creation, the ZIP action is replaced with the honest
message `용량이 커서 개별 다운로드만 지원해요.` and the individual list opens automatically.

### Original retained

When compression cannot produce the required minimum saving, the result view shows:

- equal input and output sizes;
- `이미 충분히 작아 원본을 유지했어요`;
- `원본 다운로드 ↓`.

It must not present this outcome as successful compression or claim that bytes were removed.

### Partial success and failure

If at least one item completes, the workbench enters the result view. The batch summary counts only
downloadable results. `파일별 결과 보기` reveals failures and their existing corrective messages.

If no item completes, the focus panel shows one direct error explanation and the actions needed to
recover:

- `다시 시도`;
- `다른 이미지 선택` when changing the input is relevant.

A server-policy or transport failure that safely falls back to local processing remains a processing
location change, not a fatal modal or toast.

Download invocation failure leaves the result visible and shows
`다운로드를 시작하지 못했어요. 다시 시도해 주세요.` directly below the download action.

## Data and state flow

The UI derives its visible stage from existing state:

~~~text
no active run and no completed result
  -> setup

processing or archiving
  -> processing

one or more completed downloadable or original-retained items
  -> result
~~~

Item validation, local execution, server execution, event handling, remote handle ownership, archive
construction, download acknowledgement, cancellation, and cleanup continue through their existing
functions. The redesign changes which state is rendered, not how work is performed.

The setup-to-processing transition occurs only from the explicit run action. Processing-to-result occurs
after settlement. A settings change, new selection, or explicit restart invalidates the old result using
the existing cleanup path before returning to setup.

Remote results remain downloadable only while their handles are valid. Successful download handoff
retains the existing acknowledgement and deletion behavior. The UI may say `다운로드를 시작했어요.`
but must not claim that the browser saved the file.

## Visual and responsive rules

- Use one centered work area with a constrained reading width rather than three equal cards.
- Use whitespace and typography for hierarchy; do not introduce decorative badges, gradients, or new
  card stacks.
- Render byte values with tabular numerals.
- Keep the primary action at least 44 CSS pixels tall.
- Use the same content order on desktop and mobile.
- On mobile, keep the primary action in normal document flow unless testing proves a sticky action is
  required; avoid covering result content with a fixed footer.
- Preserve visible keyboard focus and reduced-motion preferences.
- Keep the saving percentage secondary to the exact input-to-output sizes.

## Implementation boundary

The focused change is limited primarily to:

- `apps/web/src/components/image-compress-workbench.tsx`;
- `apps/web/src/components/image-compress-workbench.module.css`;
- image-compression unit and browser tests whose assertions describe the visible workbench states.

Reuse the current component, state, helpers, semantic controls, and CSS module. Add no component library,
state-machine package, icon package, or animation dependency. Extract a small pure helper only if stage
or aggregate-size calculation would otherwise be duplicated.

## Verification

### Pure and component checks

- Aggregate input and output sizes and saving percentages are correct.
- Zero reduction cannot display a positive saving.
- A selected single file and a selected batch produce the correct compact setup summary.
- The derived stage cannot show setup and result controls simultaneously.
- Original-retained and partial-failure summaries use honest copy.

### Browser checks

- Setup exposes file selection before optional presets in keyboard order.
- Required server or local processing disclosure is visible before the explicit run action.
- Starting compression removes setup controls and exposes progress and cancellation.
- A successful single JPEG shows exact input and output sizes and one dominant result download action.
- A non-reducible PNG shows equal sizes, original-retained copy, and original download.
- A successful batch initially shows aggregate sizes and ZIP download without expanded result rows.
- Expanding file details exposes individual results and individual downloads.
- Partial failure leaves successful results downloadable and reveals failure reasons in details.
- Download failure keeps the result available for retry.
- Restart disposes remote results and returns to a clean setup state.
- No file content, filename, thumbnail, or remote result URL is logged.

### Responsive and accessibility checks

Run the focused flow at desktop, 390 CSS pixels, and 320 CSS pixels:

- no horizontal overflow;
- no result content hidden behind actions;
- primary actions meet the minimum touch target;
- focus remains visible;
- progress and result messages are announced through the existing live region;
- expanded settings and individual-result disclosures expose correct accessible names and states.

## Acceptance criteria

- Before processing, the workbench shows one clear selection-to-run path.
- During processing, setup and result controls are absent.
- After processing, setup and progress controls are absent.
- A single successful result visibly answers: how large was it, how large is it now, how much was saved,
  and where to download it.
- A batch result answers the same questions for the batch and initially presents one ZIP action.
- Required processing-location disclosure remains visible before a file may be transmitted.
- Existing compression bytes, output formats, limits, cleanup, and download behavior do not regress.

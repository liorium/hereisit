# Direct-Download Result Delivery Design

**Status:** Draft for written review on 2026-07-15
**Approved direction:** Direct download as the primary action, with explicit sharing as a secondary action

## Summary

Change every HereIsIt image and PDF result surface so a download-labelled action always requests a
browser download. Sharing remains available only through a separate `공유` action when the current
browser can share that generated file.

The change does not automatically download a result when processing finishes. A result stays in the
current tab until the user explicitly chooses either download or share. The browser and operating
system still control the final download indicator, save-location prompt, file preview, and download
folder.

## Problem

Current single-result actions use a hidden share-first policy:

1. Build a local `File` from the generated result.
2. If `navigator.canShare({ files })` returns true, call `navigator.share()`.
3. Only use an `<a download>` fallback when sharing is unsupported or fails without cancellation.

The same button can therefore open an operating-system share sheet on one device and download on
another. This behavior appears in five workbenches, has no PC/mobile distinction, and conflicts with
labels such as `받기` and the ordinary expectation that a downward-arrow action downloads a file.
Closing the share sheet also ends the action without downloading or explaining what happened.

The current policy is duplicated across:

- General image conversion, compression, and resizing.
- Image watermarking.
- General PDF merge, split, organize, watermark, and image-to-PDF operations.
- Scanned-PDF compression.
- PDF-to-image conversion.

Multiple-image ZIP creation already downloads directly, while some PDF ZIP results pass through the
share-first path. Result behavior is consequently inconsistent by tool, output count, browser, and MIME.

## Goals

- Make the primary result action predictable: a download label always requests a download.
- Retain convenient native sharing through a separate, explicit action.
- Apply one behavior and vocabulary to every current image and PDF tool.
- Preserve explicit-only delivery: processing completion never downloads or shares automatically.
- Keep result bytes, filenames, and object URLs local unless the user explicitly chooses a share target.
- Keep direct-download initiation synchronous with the user's click whenever the artifact already
  exists. An on-demand ZIP starts building from that click and downloads as soon as that requested
  build finishes.
- Prevent pending share completion from mutating a reset, replaced, or invalidated result.
- Use honest status messages that distinguish a request from confirmed filesystem completion.
- Preserve bounded memory and existing object-URL ownership rules.
- Add no dependency.

## Non-goals

- Silently bypassing browser download indicators, save-location preferences, iOS Files UI, or in-app
  browser previews.
- Automatically downloading immediately after a conversion finishes.
- Choosing a filesystem folder through the File System Access API.
- Remembering a user-level download/share preference.
- Sharing an on-demand multi-image archive before it has been built.
- Changing file-processing contracts, output bytes, names, formats, ZIP structure, or privacy boundaries.
- Uploading generated files to provide a server-hosted download URL.

## Approach decision

Use two explicit actions:

1. A dominant download action that always invokes the existing same-origin Blob URL and `download`
   attribute path.
2. A secondary `공유` action that is rendered only when the exact generated file passes
   `navigator.canShare({ files: [file] })`.

This is preferred over two alternatives:

- **Download only:** simple, but needlessly removes useful mobile and desktop sharing.
- **One action that opens a download/share menu:** retains an extra decision step and recreates the
  user's complaint in HereIsIt-owned UI.

`showSaveFilePicker()` is not used. It deliberately opens a picker, has narrower platform support, and
does not match the requested immediate-download behavior.

## User experience contract

### Primary actions

| Result surface | Primary label |
| --- | --- |
| General image single result | `결과 다운로드 ↓` |
| Individual image result | `이 이미지 다운로드 ↓` |
| Image-watermark single result | `결과 다운로드 ↓` |
| Selected watermark result | `선택 파일 다운로드 ↓` |
| General PDF result | `PDF 다운로드 ↓` |
| Scanned-PDF compression | `PDF 다운로드 ↓` |
| PDF-to-image single page | `이미지 다운로드 ↓` |
| Any already-produced ZIP result | `ZIP 다운로드 ↓` |
| On-demand image batch archive | `결과 N개 ZIP 다운로드 ↓` |

Every primary action calls direct download even when file sharing is supported. It never calls
`navigator.share()` and never opens HereIsIt-owned confirmation UI.

After the request is issued, the status becomes `다운로드를 시작했어요.` HereIsIt must not say that a
file was saved because the browser does not expose reliable filesystem-completion confirmation.

### Share action

The secondary action is labelled `공유`. It appears only when:

- `navigator.share` and `navigator.canShare` are functions; and
- the exact Blob, filename, and Blob MIME can be wrapped in a `File`; and
- `navigator.canShare({ files: [file] })` returns true without throwing.

Selecting `공유` is the only path that calls `navigator.share()` and opens the native share UI.

- Success: `공유 메뉴로 보냈어요.`
- User cancellation: retain the prior result-ready status; do not download and do not show an error.
- Unsupported after an earlier capability check: hide the action on the next stable render and retain
  the result.
- Other failure: `공유하지 못했어요. 다운로드를 이용해 주세요.` Never turn a failed or cancelled
  share into a surprise download.

Sharing remains local until the user chooses a native share target. Once chosen, the operating system
may pass the generated file to that application; HereIsIt itself does not upload it.

### Multiple results

- An individual completed image keeps its own direct-download and optional share actions.
- Image batch ZIP creation remains an explicit, direct-download action. Version 1 does not add sharing
  for an archive that must first be assembled on demand. Its status moves from `ZIP 파일을 만들고
  있어요.` to `ZIP 다운로드를 시작했어요.`; an archive error retains the existing corrective
  message and leaves individual results available.
- A PDF pipeline that already produced one ZIP artifact downloads that ZIP directly. It may expose a
  separate share action only when the exact ZIP passes `canShare` without requiring additional archive
  work.

### Responsive and accessible layout

- Download remains the visually dominant action on every viewport.
- Share uses the existing secondary-button treatment.
- Both actions have at least a 44 by 44 CSS-pixel target.
- At compact widths the action group may wrap or stack, with download first in DOM and visual order.
- Neither action overlaps sticky controls, result copy, or preview content at 320 and 390 CSS pixels.
- A capability-unavailable share action is omitted rather than shown disabled. A share action that was
  already shown may be temporarily disabled while another share request is pending.
- Within each delivery group, focus order is download and then share. Existing reset, retry, and process
  controls keep their current relative order outside that group.
- Image and image-watermark result previews contain the contextual download/share pair. Their sticky
  action bars retain only the direct single-result download or batch-ZIP action and do not duplicate
  `공유`. PDF workbenches, which have no contextual per-result delivery group, place both actions in
  their result action bar.

## Architecture

Add one small browser-only delivery module, `apps/web/src/lib/result-delivery.ts`, instead of maintaining
five copies of share-first policy.

Its public surface is conceptually:

```ts
type LocalResultArtifact = {
  blob: Blob;
  filename: string;
  url: string;
};

type ShareResult = "shared" | "cancelled" | "unsupported" | "failed";

function downloadArtifact(artifact: LocalResultArtifact): void;
function canShareArtifact(artifact: LocalResultArtifact): boolean;
function shareArtifact(artifact: LocalResultArtifact): Promise<ShareResult>;
```

The Blob is the authoritative payload for object-URL creation, MIME, download, and sharing. Callers must
not independently provide bytes or MIME that could diverge from the URL. The observable contract is:

- `downloadArtifact` synchronously activates an ephemeral `<a download>` and never awaits work.
- `canShareArtifact` is exception-safe and has no network effect.
- `shareArtifact` never downloads and converts platform exceptions into the four bounded outcomes.
- Neither helper logs filenames, bytes, URLs, share targets, or exception payloads.

Share-file construction is lazy. A workbench evaluates only its current/visible share target rather
than constructing `File` objects for an entire result collection, and retains at most one prepared
share `File` at a time. Replacing that target releases the prior `File` reference. This bounds wrapper
memory independently of the batch size while the existing result-count and Blob limits remain in force.

Archive creation and byte formatting remain in `files.ts`. Existing `downloadUrl()` can move behind the
new module or remain as its private primitive, but workbenches must not choose between share and download
inside a single handler.

Each workbench continues to own result validity because it knows its generation, run ID, object URL,
and reset lifecycle. A share handler snapshots the current artifact and operation ID, then checks that
snapshot before displaying any completion message. Downloads are synchronous and use only the current
artifact.

## State and data flow

```text
Worker result
  -> validate result bytes and name
  -> create owned Blob URL
  -> expose result-ready UI
       -> Download click
            -> synchronous <a download> activation
            -> "다운로드를 시작했어요."
       -> Share click, only if shareable
            -> navigator.share({ files: [local File] })
            -> bounded outcome
            -> update message only if result snapshot is still current
  -> reset/replacement/settings change
       -> invalidate delivery operation
       -> revoke owned result URL according to existing lifecycle
```

No automatic action follows `Worker result`. No server request, analytics payload, or persistent storage
is added.

An on-demand image ZIP follows a separate, explicitly requested branch:

```text
ZIP download click
  -> "ZIP 파일을 만들고 있어요."
  -> build one bounded archive Blob
  -> synchronous <a download> activation for that completed Blob
  -> "ZIP 다운로드를 시작했어요."
  -> release the temporary URL and archive references under the existing lifecycle
```

## Error and concurrency behavior

- Repeated download clicks are explicit repeated requests and may create browser-renamed duplicates.
- A workbench allows only one pending native share request. While it is pending, all of that
  workbench's visible share actions are disabled and marked busy; every download action remains
  available.
- Any additional share request in the same workbench is ignored until the pending request settles.
- Reset, source replacement, result removal, setting changes, rerun, and unmount invalidate the pending
  share's UI effects.
- A late share resolution or rejection never triggers download, restores a revoked URL, or overwrites the
  newer status.
- Direct-download invocation errors keep the result and show `다운로드를 시작하지 못했어요. 다시
  시도해 주세요.`
- Existing archive failures retain their archive-specific correction and never fall back to individual
  multi-downloads.

Share outcomes map deterministically:

- Missing `share`/`canShare`, `canShare` returning false, a capability-check exception, an API that
  disappears before invocation, or a `TypeError` from rejected share data maps to `unsupported`.
- `AbortError` maps to `cancelled`.
- `InvalidStateError` and `NotAllowedError` map to `failed`; these normally indicate a conflicting
  native share request, lost user activation, or policy restriction rather than user cancellation.
- Every other rejection maps to `failed`.

Only `unsupported` removes the share action after the pending operation settles. `cancelled` restores
the previous ready message, and `failed` keeps the action available for an explicit retry.

## Browser boundary

The HTML `download` attribute expresses download intent and recommends a filename. The browser still
decides the final storage location and may show a download indicator, filename/location prompt, security
warning, file preview, or unsupported-download UI. HereIsIt must not promise a silent filesystem write.

On iOS, Android, desktop Safari, Chromium browsers, and in-app browsers, the visible browser chrome can
differ even when HereIsIt invokes the same direct-download path. The acceptance criterion is that
HereIsIt does not call Web Share from a download action; it is not that every browser renders identical
native UI.

## Testing strategy

### Delivery-policy regression tests

For every workbench family, install working `navigator.share` and `navigator.canShare` stubs before page
load. With sharing available:

- Clicking download emits exactly one browser download.
- The suggested filename and MIME signature remain correct.
- `navigator.share` is called zero times.
- Clicking the separate share action calls `navigator.share` exactly once.
- Sharing emits no browser download.

Cover these artifact classes:

- Single image pipeline result.
- Single image-watermark result and a selected item in a multi-result batch.
- General PDF result.
- Scanned-PDF compressed result.
- PDF-to-image direct image and already-produced ZIP result.
- On-demand image ZIP direct download.

### Capability and failure tests

- Share API absent: share action is omitted; download still works.
- `canShare` false or throws: share action is omitted; download still works.
- Share cancellation: no download and no error message.
- Share failure: no download and the corrective message is shown.
- One pending share disables every share action in that workbench, ignores a second share request, and
  leaves every direct-download action usable.
- `AbortError`, `TypeError`, `InvalidStateError`, `NotAllowedError`, and an unknown rejection map to the
  specified bounded outcomes.
- Pending share followed by reset, replacement, setting change, rerun, item removal, or unmount: no stale
  message or fallback download.
- Download helper failure: result remains available for retry.
- A large image batch creates no share `File` for off-screen/non-selected items and retains no more than
  one prepared share `File` per workbench.

### Responsive tests

At 320, 390, 600, 601, 800, 801, and 1280 CSS pixels:

- Download precedes share.
- Visible targets are at least 44 by 44 CSS pixels.
- Actions do not overlap and cause no document overflow.
- Sticky mobile action bars remain reachable.

Existing output-byte, privacy-observer, object-URL revocation, cancellation, and release-smoke assertions
remain in force. Release smokes should stop disabling Web Share merely to obtain a download; a download
action must download even when sharing is available.

## Standards references

- [Web Share API](https://www.w3.org/TR/web-share/) — sharing is an explicit user-triggered operation
  whose native target picker is controlled by the user agent and operating system.
- [HTML: downloading resources](https://html.spec.whatwg.org/multipage/links.html#downloading-resources)
  — the `download` attribute expresses download intent and can suggest a filename, while the browser
  remains responsible for the actual download behavior.

## Rollout and compatibility

- No processing-contract or registry version changes are required.
- No dependency, database, environment variable, or Cloudflare configuration is added.
- All five workbench implementations and their visible copy change in one release so behavior does not
  differ by tool.
- Existing result object URLs and generated `File` objects stay tab-owned and are revoked or collected
  under the current lifecycle.
- Deployment follows the existing GitHub-to-Cloudflare Pages integration and production smoke sequence.

## Acceptance criteria

- Every download-labelled result action directly requests a download on PC and mobile code paths.
- No download-labelled action calls `navigator.share()` when sharing is available.
- A separate share action appears only for a shareable exact artifact.
- Share cancellation or failure never starts a download.
- Every current image and PDF tool uses the common delivery policy.
- Labels distinguish image, PDF, and ZIP downloads without `저장·공유` wording.
- Status messages say that a download started rather than claiming filesystem completion.
- Mobile action geometry, keyboard order, privacy, output, and object-URL lifecycle tests pass.
- `pnpm verify:all`, immutable-preview smokes, and production smokes pass before completion.

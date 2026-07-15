# Download-Only Result Delivery Design

**Status:** Revised for written review on 2026-07-15
**Approved direction:** Remove result sharing and make every result action download-only

## Summary

Change every HereIsIt image and PDF result surface so an explicit result action only requests a
browser download. Remove Web Share capability checks, native share invocation, share-specific state,
share-specific messages, and `저장·공유` wording from all current workbenches.

Processing completion does not download automatically. The result stays in the current tab until the
user presses a download-labelled action. The browser and operating system still control the final
download indicator, save-location prompt, file preview, and download folder.

## Problem

Current single-result actions use a hidden share-first policy:

1. Build a local `File` from the generated result.
2. If `navigator.canShare({ files })` returns true, call `navigator.share()`.
3. Only use an `<a download>` fallback when sharing is unsupported or fails without cancellation.

The same button can therefore open an operating-system share sheet on one device and download on
another. This behavior appears in five workbenches, has no PC/mobile distinction, and conflicts with
labels such as `받기` and the ordinary expectation that a downward-arrow action downloads a file.

The duplicated policy exists in:

- General image conversion, compression, and resizing.
- Image watermarking.
- General PDF merge, split, organize, watermark, and image-to-PDF operations.
- Scanned-PDF compression.
- PDF-to-image conversion.

Multiple-image ZIP creation already downloads directly, while some already-produced PDF ZIP results
pass through the share-first path. Result behavior is consequently inconsistent by tool, output count,
browser, and MIME.

## Goals

- Make every result action predictable: a download label always requests a download.
- Remove result sharing from every current PC and mobile code path.
- Apply one behavior and vocabulary to every current image and PDF tool.
- Preserve explicit-only delivery: processing completion never downloads automatically.
- Keep result bytes, filenames, and object URLs local to the browser tab.
- Keep direct-download initiation synchronous with the click whenever the artifact already exists.
- Preserve existing run, generation, object-URL, reset, and bounded-memory protections.
- Use honest status messages that distinguish a request from confirmed filesystem completion.
- Add no dependency, server route, storage, environment variable, or processing-contract change.

## Non-goals

- Retaining a hidden, mobile-only, or optional result-share action.
- Silently bypassing browser download indicators, save-location preferences, iOS Files UI, or in-app
  browser previews.
- Automatically downloading immediately after conversion finishes.
- Choosing a filesystem folder through the File System Access API.
- Changing output bytes, names, formats, ZIP structure, limits, or privacy boundaries.
- Uploading generated files to provide a server-hosted download URL.
- Adding accounts, subscriptions, payments, advertising, API products, e-signatures, or new tool
  families in this change.

HereIsIt's broader differentiation and revenue roadmap will be designed as a separate product project
after this delivery correction is implemented, verified, and deployed.

## Approach decision

Use the existing same-origin Blob URL and HTML `download` attribute for every result action, and delete
the result-sharing branches completely.

This is preferred over two alternatives:

- **Hide sharing but retain dormant Web Share code:** reduces visible symptoms but leaves dead policy,
  state, and race handling that can regress later.
- **Keep sharing only on selected devices:** preserves device-dependent behavior and contradicts the
  requirement that HereIsIt only downloads results.

No replacement confirmation menu or save picker is added. One click has one HereIsIt-owned meaning:
request the labelled download.

## User experience contract

### Result actions

| Result surface | Label |
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

Every result action invokes direct download. It never calls `navigator.share()`, checks
`navigator.canShare()`, constructs a result-delivery `File`, or opens HereIsIt-owned confirmation UI.

After an ordinary image or PDF request is issued, the status becomes `다운로드를 시작했어요.` An
archive uses `ZIP 다운로드를 시작했어요.` HereIsIt must not say that a file was saved because the
browser does not expose reliable filesystem-completion confirmation.

### Multiple results

- An individual completed image keeps its contextual direct-download action.
- A single completed image also keeps the existing sticky direct-download action for mobile reachability.
- Image batch ZIP creation remains an explicit action. Its status moves from `ZIP 파일을 만들고
  있어요.` to `ZIP 다운로드를 시작했어요.` after archive construction and download activation.
- A PDF pipeline that already produced one ZIP artifact downloads that ZIP directly without rebuilding
  it.
- Archive failure retains the existing corrective message and leaves individual results available.

### Responsive and accessible layout

- The download action remains visually dominant on every viewport.
- Every visible result action has at least a 44 by 44 CSS-pixel target.
- Existing contextual image downloads and sticky single/batch downloads remain in their current roles;
  no additional action row is introduced.
- Buttons do not overlap sticky controls, result copy, or preview content at 320 and 390 CSS pixels.
- Existing reset, retry, process, and download focus order is preserved.
- No blank space or empty wrapper remains where a share action or share status used to be.

## Architecture

Reuse `downloadUrl(url, filename)` from `apps/web/src/lib/files.ts`. A new result-delivery module is not
needed once Web Share policy is removed.

Each of the five workbenches will:

- Rename share-oriented handlers such as `saveResult` and `saveItem` to download-oriented names.
- Validate that the current result and owned object URL still exist.
- Call `downloadUrl()` directly from the user's click for an already-produced artifact.
- Set the honest download-started message only after the helper returns.
- Retain the result and show `다운로드를 시작하지 못했어요. 다시 시도해 주세요.` if invocation
  throws.
- Keep asynchronous work only where the user's click must first create an on-demand ZIP.

Delete delivery-only use of:

- `navigator.share` and `navigator.canShare`.
- `ShareData` and generated result-sharing `File` objects.
- The shared `files.ts` `isAbortError` helper and its unit tests when all result-delivery callers have
  been removed. Private processing-runtime abort helpers remain untouched.
- Share-only result Blob references, saving state/refs, save operation IDs, pending-share flags, and
  late-share message guards that have no remaining download or processing responsibility.
- Share success, cancellation, fallback, and corrective copy.

Do not remove run IDs, generations, cancellation tokens, archive flags, result validity checks, or
object-URL cleanup merely because they previously also guarded a share path.

## State and data flow

An already-produced result follows this flow:

```text
Worker result
  -> validate result bytes and suggested name
  -> create owned Blob URL
  -> expose result-ready UI
       -> Download click
            -> synchronous <a download> activation
            -> "다운로드를 시작했어요."
  -> reset/replacement/settings change
       -> invalidate the result
       -> revoke the owned result URL under the existing lifecycle
```

An on-demand image ZIP follows this explicitly requested branch:

```text
ZIP download click
  -> "ZIP 파일을 만들고 있어요."
  -> build one bounded archive Blob
  -> create a temporary object URL
  -> synchronous <a download> activation
  -> "ZIP 다운로드를 시작했어요."
  -> revoke the temporary URL and release archive references
```

No automatic action follows `Worker result`. No server request, analytics payload, or persistent storage
is added.

## Error and concurrency behavior

- Repeated download clicks are explicit repeated requests and may create browser-renamed duplicates.
- A direct-download invocation error keeps the result available for retry.
- Reset, source replacement, result removal, setting changes, rerun, and unmount retain their existing
  invalidation and URL-revocation behavior.
- An on-demand ZIP disables only the conflicting archive/process actions while it is being built.
- A second ZIP request is ignored while archive construction is pending.
- A late archive completion after reset or replacement never downloads a stale artifact.
- Existing archive failures never fall back to multiple individual downloads.

There is no share promise, share lock, share cancellation outcome, or share-to-download fallback after
this change.

## Browser boundary

The HTML `download` attribute expresses download intent and recommends a filename. The browser still
decides the final storage location and may show a download indicator, filename/location prompt, security
warning, file preview, or unsupported-download UI. HereIsIt cannot promise a silent filesystem write.

On iOS, Android, desktop Safari, Chromium browsers, and in-app browsers, browser chrome can differ even
when HereIsIt invokes the same direct-download path. The acceptance criterion is that HereIsIt only
requests download; it is not that every browser renders identical native UI.

## Testing strategy

### Download-policy regression tests

For every workbench family, install working `navigator.share` and `navigator.canShare` spies before page
load. Their presence must not affect result delivery:

- Clicking a result action emits exactly one browser download.
- `navigator.share` and `navigator.canShare` are called zero times.
- No `공유`, `저장·공유`, or `공유 메뉴` result-delivery copy is rendered.
- The suggested filename and MIME signature remain correct.

Cover these artifact classes:

- Single image pipeline result and selected item in a multi-result batch.
- Single image-watermark result and selected item in a multi-result batch.
- General PDF and already-produced PDF ZIP results.
- Scanned-PDF compressed result.
- PDF-to-image direct image and already-produced ZIP result.
- On-demand image and image-watermark ZIP downloads.

### Failure and lifecycle tests

- No automatic download occurs when processing completes.
- Download-helper failure retains the result and shows the retryable message.
- Reset, replacement, setting change, rerun, item removal, or unmount preserves object-URL ownership and
  never emits a stale download.
- A pending on-demand ZIP followed by invalidation does not download.
- The general image batch ZIP receives the same generation/invalidation protection already used by the
  image-watermark archive path.
- Existing byte, dimension, page-count, ZIP-entry, naming, and privacy assertions remain in force.

### Responsive tests

At 320, 390, 600, 601, 800, 801, and 1280 CSS pixels:

- Every visible download target is at least 44 by 44 CSS pixels.
- Actions do not overlap or cause document overflow.
- Sticky mobile actions remain reachable.
- Removing share behavior creates no empty or misaligned action container.

Release smokes must stop disabling Web Share merely to obtain a download. A result action must download
even if the browser exposes working Web Share APIs.

## Standards reference

- [HTML: downloading resources](https://html.spec.whatwg.org/multipage/links.html#downloading-resources)
  — the `download` attribute expresses download intent and can suggest a filename, while the browser
  remains responsible for actual download behavior.

## Rollout and compatibility

- No processing-contract or registry version changes are required.
- No dependency, database, account, environment variable, or Cloudflare configuration is added.
- All five workbenches and their visible copy change in one release so behavior does not differ by tool.
- Existing generated object URLs remain tab-owned and are revoked under the current lifecycle.
- Deployment follows the existing GitHub-to-Cloudflare Pages integration and production smoke sequence.

## Acceptance criteria

- Every download-labelled result action requests a direct download on PC and mobile code paths.
- Result-delivery code contains no Web Share capability check or invocation.
- No result-delivery share button or share-oriented copy remains.
- Every current image and PDF tool uses the same download-only policy.
- Labels distinguish image, PDF, and ZIP downloads without `저장·공유` wording.
- Status messages say that a download started rather than claiming filesystem completion.
- Processing completion never downloads automatically.
- Mobile geometry, privacy, output, naming, and object-URL lifecycle tests pass.
- `pnpm verify:all`, immutable-preview smokes, and production smokes pass before completion.

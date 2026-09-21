# Discovery accessibility release checklist

Playwright is the automated accessibility and interaction gate for discovery. This document records
separate manual assistive-technology checks; an unavailable browser, operating system, or screen reader
must be recorded as `not run`, never inferred from Playwright or reported as a pass.

## Result record

Use `pass`, `fail`, or `not run`. Add an issue or notes for every failure and the reason for every
`not run` result.

| Screen reader | Browser | Scope or route | Date (UTC) | Tester | Result | Issue or notes |
| --- | --- | --- | --- | --- | --- | --- |
| VoiceOver | Safari | Discovery navigation | 2026-07-14 | Automated environment | not run | Manual Apple platform unavailable. |
| VoiceOver | Safari | File shell `/image/compress` | 2026-07-14 | Automated environment | not run | Manual Apple platform unavailable. |
| NVDA | Firefox or Chrome | Discovery navigation | 2026-07-14 | Automated environment | not run | Manual Windows platform unavailable. |
| NVDA | Firefox or Chrome | File shell `/image/compress` | 2026-07-14 | Automated environment | not run | Manual Windows platform unavailable. |

## Manual route and control checks

Run each row with both screen-reader/browser combinations above. Record failures in the result table.

- Header: landmarks and names are announced; desktop disclosures and the mobile menu open by keyboard,
  keep focus in the intended surface, close with Escape, and return focus to the exact trigger.
- Search: the input, result count, active suggestion, and empty state are announced without announcing
  every keystroke; Arrow keys, Enter, Escape, and Tab behave predictably.
- Domain tabs: the tablist, selected tab, and associated panel are announced; Left/Right, Home, and End
  move and select in DOM order while Up/Down retain native page scrolling.
- File launcher: the privacy statement, selection control, bounded detection progress, recommendation
  groups, and reselect message are announced; choosing a tool does not imply that processing has begun.
- Representative `file` shell (`/image/compress`): the breadcrumb, heading, server upload/deletion
  disclosure, `고성능 서버 압축` and `내 기기에서 처리` options, support/warning notices,
  `파일 작업 영역` region, selected-file state, validation result,
  explicit start action, progress, and explicit download action are announced in a useful order. `다음 작업`
  announces exactly three actions in catalog order: resize, convert, and image watermark.
- Representative `quick` shell (`/data/json`): the breadcrumb, heading, local-execution disclosure,
  input, syntax feedback, formatting actions, and explicit copy/download actions are announced.
  `다음 작업` announces image conversion, HTML-to-image, and image editing in catalog order.
- On a narrow mobile viewport, image result downloads remain visible, keyboard- and touch-reachable,
  and do not obscure focused controls.

Also confirm at 200% browser zoom and with enlarged mobile text that controls remain visible, labels are
not clipped, focus indicators are visible, and the document has no horizontal overflow. With reduced
motion enabled, menu, panel, and card transitions must not introduce non-essential movement.

## Automated gate

Before release, use the GitHub Actions `browser` job for the repository's discovery Playwright matrix.
Automated passing results do not replace or alter the manual result records above.

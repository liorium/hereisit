# Discovery Task 7 implementation report

## Scope and decisions

- Work stayed on `feat/scalable-tool-navigation` in the isolated
  `.worktrees/scalable-tool-navigation` worktree; no push, merge, or deployment was performed.
- The privacy observer remains shared by PDF compression and discovery. Its observation interface is a
  superset of the plan so existing `assertClean`, sentinel inspection, and cleanup checks remain available.
- Bundle accounting reads the completed Next production build and exported HTML. A framework chunk is a
  JavaScript chunk present in every built App Router page closure; chunks shared by at least two discovery
  routes form the discovery-shared layer; each remaining discovery chunk is charged to its single route.
  Every chunk is gzip-compressed independently at level 9 before its transferred cost is summed.
- The checked-in baseline contains only measured production-build values. A measured zero-byte owned layer
  is retained as zero rather than fabricated.
- Manual VoiceOver and NVDA checks are recorded as `not run` because those platforms are unavailable in the
  automated environment. Playwright remains the automated gate and is not represented as a manual pass.

## Files

- `tests/e2e/support/privacy-observer.ts` — category-only reusable observer with bounded sentinel,
  history, console, storage, object-URL, request, and teardown checks.
- `tests/e2e/discovery.spec.ts`, `tests/e2e/discovery-mobile.spec.ts`, and
  `tests/e2e/pdf-compression.spec.ts` — privacy, handoff, accessibility, and observer regression cases.
- `scripts/verify-discovery-imports.mjs`, its two immutable fixtures, and
  `tests/discovery-import-verifier.test.ts` — fail-closed TypeScript-AST source boundary.
- `scripts/verify-discovery-bundles.mjs`, `scripts/discovery-bundle-baseline.json`, and
  `tests/discovery-bundle-verifier.test.ts` — production closure accounting, limits, and verifier
  self-tests. The additional pure verifier test is retained because it exercises the budget algorithm,
  malformed baselines, processor-marker rejection, and CLI failure behavior without mutating product code.
- `scripts/verify-static-export.mjs` and `package.json` — aligned processor marker sweep and release-gate
  wiring.
- `docs/testing/discovery-accessibility-checklist.md` — dated manual-check matrix with unavailable
  platforms explicitly marked `not run`.
- `tests/e2e/pdf-tools.spec.ts` and `tests/e2e/tool-pages.spec.ts` — full-suite compatibility updates for
  the approved header design and catalog hydration readiness.
- `.superpowers/sdd/discovery-task-7-report.md` — implementation, RED/GREEN, verification, and environment
  evidence.

## RED / GREEN evidence

### Bundle accounting and limits

- RED: `pnpm test tests/discovery-bundle-verifier.test.ts --run` exited 1 because
  `scripts/verify-discovery-bundles.mjs` did not exist.
- GREEN: the same command passed 2/2 initial classification and limit tests.
- RED: the forbidden-marker regression then exited 1 with
  `TypeError: findForbiddenProcessorMarkers is not a function`.
- GREEN: the focused suite passed 5/5, covering classification, absolute limits, exact baseline growth,
  a tiny forbidden processor chunk, malformed baseline schema, and fail-closed CLI arguments.
- RED: after controller review expanded the tiny-chunk test to browser-runtime and `.wasm`, it failed
  1/5 because only the Worker marker was detected. GREEN: safe concrete package/runtime strings and
  punctuated codec/editor/WASM markers were aligned across both bundle and static-export discovery sweeps;
  the focused suite returned to 5/5 and both verifiers passed without changing measured bytes.
- `pnpm --filter @hereisit/web build` passed with 19 static pages, after which
  `node scripts/verify-discovery-bundles.mjs --write-baseline` wrote real measurements:
  `/` 16,985; `/tools` 3,042; `/my-tools` 1,906; `/workflows` 0; discovery-shared 11,369;
  framework-shared reported 185,272 gzip bytes.
- `node scripts/verify-discovery-bundles.mjs` passed against that baseline.

### Static import boundary

- RED: `pnpm test tests/discovery-import-verifier.test.ts --run` exited 1 with both child-process
  cases failing because the verifier did not exist; the forbidden case also lacked the required
  `forbidden.ts -> @hereisit/pdf-tool` edge diagnostic.
- GREEN: the same focused command passed 2/2. The default graph then passed with
  `Discovery import boundary passed (25 modules).`
- The verifier uses the installed TypeScript parser, follows static imports/exports, literal dynamic
  imports, CommonJS imports, and Worker URL specifiers, resolves workspace export maps, ignores type-only
  edges and framework/assets, and reports only module paths/specifiers.
- Manual self-review probes confirmed a type-only registry barrel and a source file containing ordinary
  `editing` words pass, while `fflate`, browser-runtime/PDF pipelines, PDF.js/pdf-lib, processor tools,
  Workers, codec/editor/WASM paths, and runtime tool contracts are rejected.
- RED: controller review built a runtime-only temporary graph whose neutral-named module was launched with
  `new Worker(...)`; the verifier incorrectly exited 0 because only the target path was followed. GREEN:
  Worker/SharedWorker construction is now rejected independently of filename while literal targets remain
  traversed; focused child-process coverage passed 3/3 and the default graph remained 25 clean modules.
- RED: three fail-closed controller cases then failed 3/6: non-literal `import()`/`require()` and an
  unknown benignly named bare runtime package incorrectly exited 0, while an absolute entrypoint was echoed
  in diagnostics. GREEN: non-literal runtime loaders are explicit violations, external terminals use the
  tight `next`/`react`/`react-dom` allowlist, absolute entrypoints are categorized, and unexpected internal
  exceptions receive a generic message. Root layout plus the applicable robots/sitemap convention roots
  were added to the implicit graph. Focused tests passed 6/6 and the expanded default graph passed across
  29 modules.
- Current workspace export maps use exact string targets, which the verifier resolves. Conditional export
  selection remains deterministic but is not intended to reproduce every package-manager condition order;
  no current discovery edge depends on that distinction.
- RED: final audit found that qualified `globalThis.Worker`/`window.SharedWorker` and an obvious constructor
  alias could bypass the bare-identifier check. Neutral-path regressions resolved instead of rejecting and
  the focused suite failed 1/7. GREEN: runtime references to bare Worker globals plus
  `globalThis`/`window`/`self` member and string-element forms are rejected at acquisition time, which
  catches simple aliases without pretending to solve arbitrary dataflow; qualified literal Worker targets
  remain traversed. Type nodes are intentionally skipped and covered by an accepted type-only fixture.
  Focused coverage passed 8/8 and the real default graph remained clean at 29 modules. The syntax gate
  deliberately treats any runtime-position identifier named `Worker`/`SharedWorker` as forbidden even when
  locally shadowed; this conservative false positive is accepted in favor of a fail-closed release gate,
  while type-only declarations remain allowed.

### Privacy observer and browser coverage

- RED cycles proved raw request URLs were exposed, `privacy.clear()` was absent, encoded history and
  `history.state` sentinels were missed, a wide history value was enumerated before its bound, probe
  storage remained populated, and unfulfilled probe requests reached 404/405 responses.
- GREEN: observation diagnostics now retain categories only; sentinel checks happen before values are
  discarded; history URL/state inspection is encoded-aware and bounded for arrays/maps/sets; probes use an
  isolated fulfilled prefix, revoke object URLs, remove the exact test storage value, and clear every
  observation checkpoint before real assertions. Existing console inspection/handle cleanup and
  `assertClean` teardown behavior remain covered.
- Discovery coverage now includes sentinel selection/detection/PDF handoff privacy, no thumbnails or object
  URLs, destination revalidation, exact 60-second expiry via controlled monotonic clock, target mismatch,
  one-use consumption, reload fallback, reduced motion, 200% zoom, enlarged mobile text, keyboard-only
  desktop/mobile menu/search/tabs, exact trigger focus return, and horizontal-overflow checks.
- Focused/track results: discovery Chromium + mobile Chromium 37/37; PDF Chromium 18/18; final probe and
  bounded-history cases 2/2; actual Next navigation plus observer in Chromium/Firefox 2/2; new Firefox
  privacy/handoff/accessibility group 8/8; PDF observer Firefox 5/5 plus encoded-history 1/1. Scoped Biome,
  `git diff --check`, and the six-package typecheck passed.

## Verification

- RED full gate: the first `pnpm verify:all` completed with exit 1 after 8.3 minutes:
  219 passed and four failed. The known-scan Chromium case reached the completed 69%-smaller result and
  explicit-save state but crossed the global 30-second test timeout. The catalog-link failure snapshot
  already contained the requested `/pdf/compress` card, proving its synchronous zero-count check raced
  hydration. Chromium and Firefox both failed an assertion for the removed top-level `PDF` link after the
  approved header redesign; the current active control is the `모든 도구` button.
- Before changing its timeout, the known-scan Chromium test passed three isolated repeats in 5.9s, 5.9s,
  and 5.7s. This rules out a repeatable processing hang and supports a test-local allowance for rare
  full-suite resource contention while preserving the global 30-second limit elsewhere.
- GREEN stabilization: the known-scan case received only a test-local 90-second ceiling; its functional
  result wait remains 60 seconds and every output/privacy assertion is unchanged. Catalog lookup now waits
  for either its requested card or the pagination control, and the route-state check targets the current
  active `모든 도구` button. Three Chromium and three Firefox repeats of all three cases passed 18/18 in
  1.2 minutes (Chromium known scan 5.7s; Firefox 7.8–8.0s). Independent review found no issue.
- `pnpm test tests/discovery-import-verifier.test.ts --run`: exit 0, 1 file and 8 tests passed.
- `pnpm test tests/discovery-bundle-verifier.test.ts --run`: exit 0, 1 file and 5 tests passed.
- `pnpm exec playwright test tests/e2e/discovery.spec.ts --project=chromium --project=firefox`:
  exit 0, 60/60 passed in 1.2 minutes.
- Complete `pnpm verify:all` before the final Node-only boundary hardening: exit 0. Biome checked 185 files;
  all six package typechecks passed; Vitest passed 45 files and 957 tests; the production build emitted 19
  static pages; static export, the 29-module import boundary, and bundle budgets passed; Playwright passed
  223/223 Chromium, Firefox, and mobile Chromium cases in 7.5 minutes.
- After the final verifier-only hardening, proportional `pnpm verify` passed again: Biome 185 files,
  typecheck 6/6, Vitest 45 files and 959/959 tests, 19 static pages, static export, 29-module import boundary,
  and bundle budgets. `pnpm verify:export` also passed independently with the same measured bundle report.
- Final measured gzip report remained `/` 16,985; `/tools` 3,042; `/my-tools` 1,906;
  `/workflows` 0; discovery-shared 11,369; framework-shared reported 185,272 bytes.
- `git diff --check` and focused Biome checks passed. A final grep/audit found only deliberate synthetic
  console/network probes in tests and category-only verifier output; no user filename, file content,
  thumbnail, request body, presigned URL, or blob URL is retained in diagnostics.
- The required WebKit discovery command could not start a browser on this host; the dependency failure is
  recorded below. It is explicitly `not run`, not represented as a passing browser result.

## Warnings and environment notes

- Next prints its existing multiple-lockfile/workspace-root inference warning from the nested worktree.
- Direct Node execution of `verify-static-export.mjs` prints the existing typeless-package reparsing warning
  for `apps/web/src/lib/tool-implementations.ts`; verification still exits 0.
- Playwright's installed WebKit browser cannot launch on this Ubuntu `questing` host. The safe setup attempt
  `sudo -n ... pnpm exec playwright install-deps webkit` updated apt metadata but exited 1/code 100: the
  unsupported OS fallback requested unavailable `libicu74`, while `libxml2` had no installation candidate.
  `ldd` also reports missing WebKitGTK/GTK4, ICU74, XML2, GStreamer, Soup, JXL/AVIF, WPE, and related
  libraries. No project dependency or lockfile changed. WebKit and mobile-WebKit results are therefore
  recorded as `not run`, not passed.

## Subagent contributions

- `privacy_browser_track`: reusable observer hardening plus PDF/discovery desktop and mobile Playwright
  coverage. It changed only its four assigned files and returned the focused matrix and environment results
  recorded above; integration review retained its changes.
- `import_gate_track`: TypeScript-AST transitive import verifier, immutable fixtures, and child-process
  self-test. It reported focused GREEN 2/2, a 25-module default closure, clean Biome output, and clean
  `git diff --check`; integration review retained its owned changes.
- `final_diff_audit`: found and then re-reviewed the qualified/aliased Worker fail-open. After the TDD fix,
  it reported no Critical or Important findings, confirmed category/module-path-only diagnostics, and noted
  only the accepted conservative false positive for locally shadowed runtime `Worker` identifiers.

## Self-review

- No production runtime source, dependency, lockfile, deployment, or account state changed. All files are
  within the Task 7 release-gate/test/documentation scope plus two evidence-backed compatibility assertions
  exposed by the complete suite.
- Privacy diagnostics store method/origin categories and leak labels only. Raw request URLs, request bodies,
  console values, storage values, object URLs, filenames, and bytes are inspected transiently at most and
  are never returned or logged.
- Import analysis fails closed for unresolved runtime edges, unknown bare packages, non-literal loaders,
  runtime Worker references and simple aliases, and absolute entrypoints. Bundle analysis fails closed for
  missing assets, malformed baselines, unknown CLI arguments, absolute/growth limit breaches, and tiny
  forbidden chunks.
- The baseline was written from a successful production build and revalidated unchanged; its real zero-byte
  `/workflows` owned layer was not replaced with a fabricated value.
- Full-suite timing fixes do not remove assertions or weaken the global timeout. Focused repeated tests and
  the second complete gate both pass, and no generated test result or unrelated file is included in the
  change set.

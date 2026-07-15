# Mobile Usability Design

**Status:** Approved on 2026-07-15

## Summary

Improve HereIsIt's mobile information density without creating separate mobile pages or changing any
file-processing behavior. On narrow screens, discovery tabs become one horizontally scrollable row,
tool cards become compact single-column rows, and the home and detail-page file selectors move into the
first useful viewport. Desktop layouts, catalog data, tool contracts, local-only processing, and public
routes remain unchanged.

The mobile card summary is intentionally bounded to the tool name, two lines of description, and the
local-processing label. The complete description remains available on the canonical tool detail page.

## Evidence and problem

The production audit covered `/`, `/tools`, `/my-tools`, `/workflows`, `/image/compress`, and
`/pdf/organize` at widths 320, 360, 390, and 430 pixels. The current UI has no horizontal overflow,
runtime errors, or broken menu and tab interactions, but it is difficult to scan and delays the primary
action:

- the 320-pixel home grid gives each card 122 pixels and its text about 30 pixels, making one card as
  tall as 961 pixels and the page 7,452 pixels tall;
- `/tools` changes from a readable single column at 360 pixels to two narrow columns at 390 pixels;
- the home file button begins around y=818, the first `/tools` result around y=1,083, the image selector
  around y=1,002, and the PDF selector around y=1,005 at the narrow audit viewport;
- supporting workbench text can be 10 pixels, while the brand and a few navigation targets are shorter
  or narrower than 44 pixels.

The root cause is not a rendering failure. Responsive tests currently prove only that content stays
inside the viewport and explicitly preserve two-column mobile card grids. Shared cards then reserve a
separate 44-pixel favorite column plus padding and gaps, leaving too little width for Korean text. Large
mobile hero and empty-workbench blocks place explanation and decoration before the action.

## Goals

- Make mobile tool lists readable at 320 through 600 pixels without horizontal overflow.
- Keep domain selection as tabs while showing the selected panel immediately below one tab row.
- Put the home file selector fully inside the initial 320×568 viewport.
- Put the primary image and PDF selectors inside the initial 390×844 viewport.
- Show the first `/tools` result inside the initial 390×844 viewport.
- Preserve complete tool descriptions on detail pages while limiting discovery-card summaries to two
  lines.
- Keep primary touch targets at least 44×44 pixels and functional helper text at least 12 pixels.
- Preserve keyboard, screen-reader, reduced-motion, local-processing, and storage-denial behavior.
- Keep desktop discovery, tool execution, bundle boundaries, and public routes behaviorally unchanged.

## Non-goals

- Changing image or PDF processors, contracts, limits, output bytes, or download behavior.
- Redesigning desktop navigation or creating a separate mobile component tree.
- Removing privacy, compatibility, or password warnings from tool pages.
- Changing catalog search, ranking, filtering semantics, favorites, or recent-tool persistence.
- Adding a UI framework, carousel, gesture, state-management, or measurement dependency.
- Solving workflow execution or adding a new tool as part of this release.

## Approach decision

Use shared components with a narrow-screen presentation mode. The implementation combines responsive
CSS with the smallest structural adjustments required for reliable semantics and action ordering.

Three approaches were considered:

1. **CSS-only overrides.** This is quick, but it cannot reliably improve information order when the
   explanatory shell precedes the workbench and tends to accumulate fragile exceptions.
2. **Shared mobile compact mode (selected).** Existing cards, tabs, detail shells, and workbenches remain
   authoritative. Responsive rules and small shared markup changes compact them without duplicating
   application state or file logic.
3. **Dedicated mobile pages.** This offers the most visual freedom but duplicates accessibility,
   navigation, preferences, and workbench integration and creates unacceptable drift risk.

The compact mode applies at a maximum viewport width of 600 pixels. The existing tablet layout remains
available above that boundary. Content-width behavior must still be tested at 320, 360, 390, 430, 600,
and immediately above the boundary.

## Experience design

### Shared tool cards

- Discovery grids use one column at 600 pixels and below.
- The favorite control sits at the card's top-right without reserving a separate full-height text
  column. The card link retains a safe right inset so the targets never overlap.
- The card link and favorite button remain sibling controls rather than nested interactive elements.
  The favorite button keeps a tool-specific accessible name, both targets are center-hit-testable, and
  visual positioning does not change their predictable DOM and keyboard order.
- The name may use at most two visual lines. The description uses a two-line clamp. The local-processing
  label remains visible.
- The entire non-favorite card body remains one link with a minimum 44-pixel target. Truncation is only
  visual; the accessible link name continues to include the canonical tool name and description.
- Related-tool cards use the same compact rule so discovery and detail pages do not diverge.

### Home

- The mobile hero uses smaller type, padding, and gaps while retaining the brand statement, local-first
  promise, and search.
- The file-launcher heading and drop zone become a compact mobile block. Mobile users see a clear file
  selection action rather than desktop drag-and-drop decoration.
- With clean local storage, a 320×568 CSS viewport, and 100-percent text scale, the file selector must
  have `top >= 0` and `bottom <= 568` before any interaction.
- File inspection, detection progress, recommendations, handoff, and reset behavior do not change.
- Domain tabs form one horizontal row whose clipped next tab provides a visual continuation cue on a
  320-pixel viewport. The row scrolls locally and never creates document-level horizontal overflow.
- Arrow, Home, and End keys continue selecting and focusing tabs. Moving focus must bring the selected
  tab into view. The controlled tab panel remains directly after the row.

### Complete catalog

- Domain tabs use the same one-row mobile behavior as home.
- Purpose filters form a separate horizontally scrollable row instead of wrapping into several rows.
- Search remains a 16-pixel input and its submit button remains fully visible at 320 pixels.
- With clean local storage and the default unfiltered URL, the result heading and at least the first
  card's complete 44-pixel link target must have `top >= 0` and `bottom <= 844` in a 390×844 CSS
  viewport.
- Planned-tool filtering and URL serialization remain unchanged.

### Tool detail pages and workbenches

- Breadcrumbs, title, favorite action, canonical description, summary, processing disclosure, and
  important notices remain in document order and accessible.
- Mobile spacing and type are reduced enough to expose the work area earlier. The title reserves room
  for the favorite button without forcing a single trailing Korean character onto its own line.
- Processing disclosure becomes a compact trust row on mobile; it is not removed or made interactive.
- Image and PDF empty workbenches reduce their mobile minimum height, icon size, decoration, and gaps.
  The primary selector remains visually dominant and at least 44 pixels high.
- The image and PDF primary selectors must have `top >= 0` and `bottom <= 844` in a 390×844 CSS
  viewport with clean local storage. At 320×568, the workbench bounding box must begin above the
  viewport bottom. Named Korean titles are checked across engines during visual QA for awkward
  single-character final lines rather than through a font-dependent geometry assertion.
- Warning and support notices remain visible before file selection. No warning is collapsed behind a
  disclosure.

### Navigation and typography

- The mobile menu remains a modal drawer with its current focus trap, inert background, Escape behavior,
  and focus restoration.
- Brand, drawer-domain, breadcrumb, and workflow-link hit areas receive at least a 44-pixel target box
  without enlarging their visible text unnecessarily.
- Functional status and helper text use at least 12 pixels. Functional text includes any action,
  state/progress, privacy, limitation, warning, or error information. Only a purely redundant decorative
  eyebrow may remain 11 or 12 pixels.
- Horizontal rows expose keyboard focus outlines and respect reduced motion. Scrollbar hiding, if used,
  cannot remove touch, trackpad, Shift+wheel, or keyboard scrolling. A mouse-operable scrollbar remains
  available where the platform normally exposes one; no wheel-normalization handler is added. Focused
  tabs scroll with nearest-block behavior so selection never jumps the document vertically.

## Component boundaries

- `ToolCard` remains the only available-tool card implementation. Its CSS owns compact text and favorite
  placement; callers do not create mobile-specific card variants.
- `DomainToolTabs` owns domain-tab selection and focus. A small focus/scroll helper may be added here;
  tool selection and recommendation logic stay untouched.
- `HomeDiscovery` and `HomeFileLauncher` own only home presentation changes. File reads and pending-tool
  handoff remain in their existing libraries.
- `ToolCatalogBrowser` keeps URL-backed query, domain, purpose, and planned state. Its CSS owns mobile
  filter-row presentation.
- `ToolDetailPage` remains the common information shell. It may add semantic wrappers needed to compact
  content but cannot branch on a user agent or duplicate descriptions.
- Image and PDF workbench modules own empty-state sizing. Processor workers and tool contracts are out of
  scope.

## Data flow, privacy, and performance

No data flow changes. Catalog selection stays in React state or URL parameters, preferences remain
bounded local tool IDs, and file selection remains local to the browser. The redesign must not add
network requests, analytics, filename logging, file-derived telemetry, or storage of file content.

Browser tests intercept requests after initial static assets settle. Selecting and processing one image
and one PDF must cause no cross-origin or file-derived request. Unexpected-request failures report only
an aggregate count and request classification, never a URL, filename, query, body, blob, or thumbnail.

The change adds no dependency and no runtime viewport listener. CSS media queries control presentation;
the only permitted JavaScript addition is condition-based tab scrolling tied to existing focus changes.
Discovery bundles must remain inside their current budgets and free of codecs and workbench processors.

## Error and edge handling

- Long Korean and English tool names clamp without overflowing or becoming character-wide columns.
- Text zoom to 200 percent keeps document width bounded and preserves access to every control.
- Empty domains retain their honest preparation message immediately below the selected tab.
- Storage denial, an unknown recent ID, or unavailable planned tool does not change card layout.
- A horizontal tab or filter row remains usable by touch, trackpad, wheel, and keyboard.
- Safe-area insets and the mobile drawer continue working independently of compact content rules.

## Verification

### Automated layout and interaction

Update mobile Playwright coverage to assert:

- no document-level horizontal overflow at 320, 360, 390, 430, 600, and 601 pixels;
- one-column home, catalog, and related cards at 600 pixels and below;
- the established tablet layout resumes at 601 pixels without hiding or overlapping controls;
- bounded card text width and height, a two-line visual description clamp, and a non-overlapping 44-pixel
  favorite target; the card link and favorite remain sibling controls with tool-specific accessible
  names and predictable link-then-favorite tab order;
- one visual row for home and catalog domain tabs, local horizontal overflow, and a panel immediately
  following the row;
- keyboard selection, focus synchronization, and selected-tab visibility after Arrow, Home, and End;
- a one-row purpose filter surface with unchanged URL state;
- home file selection visible at 320×568;
- first catalog result and image/PDF selection visible at 390×844;
- at 320×568 and 390×844, detecting, processing, error, and result states keep status perceivable,
  controls and results reachable, and document width bounded for one representative image and PDF flow;
- after initial assets settle, file selection and processing produce no cross-origin or file-derived
  request, using the privacy-safe interceptor described above;
- mobile menu focus trapping, background inertness, Escape close, and exact trigger focus return;
- 200-percent root text enlargement, applied with a test-only `html { font-size: 200% }` stylesheet at
  320×568, without document overflow or unreachable controls;
- no relevant console error, page error, failed same-origin resource, or framework overlay.

Existing pure tests continue covering catalog selection, URL serialization, recommendations, file
validation, geometry, naming, and pipeline planning. No byte-stability assertion is added for browser
codecs.

### Regression and visual QA

- Run `pnpm verify:all` as the release gate, using targeted mobile Chromium, Firefox, and WebKit projects
  for focused diagnosis and evidence.
- Capture first-viewport and full-page evidence for home, `/tools`, `/image/compress`, and
  `/pdf/organize` at 320×568 and 390×844.
- Compare desktop home, catalog, and detail pages at 1280 pixels to ensure layout and content are
  unchanged.
- Exercise home file selection, one image tool, and one PDF workspace without logging filenames or file
  content.
- Verify the Cloudflare preview from its immutable URL before merging and repeat navigation, image, and
  PDF smoke checks against production after deployment.

Real iOS Safari safe-area, Dynamic Type, browser text zoom, and font-rendering review remains a manual
release check when a device is available. Test-only root font scaling is an automated reflow proxy;
Linux Playwright WebKit is useful cross-engine evidence but neither is represented as physical iOS
Safari validation.

## Rollout

Deliver the redesign as one focused pull request from `feat/mobile-usability`. Cloudflare deployment
continues through Git integration only. No Direct Upload or manual Wrangler deployment is permitted.
If a compact rule causes a desktop regression, revert the presentation commit without touching catalog
or processor contracts.

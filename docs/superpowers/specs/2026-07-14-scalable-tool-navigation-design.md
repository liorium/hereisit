# Scalable Tool Navigation and Catalog Design

**Status:** Approved on 2026-07-14

## Summary

Restructure HereIsIt from an image-and-PDF site into a scalable, privacy-first tool platform without
rewriting the working image or PDF processors. The home page combines a prominent local search field, a
separate file-based tool recommender, and a compact domain-tab discovery area. A future-facing header
provides access to all tools, workflows, personal shortcuts, and search. A unified metadata-only
`ToolCatalog` becomes the source of truth for navigation, search, filtering, metadata, sitemap entries,
related actions, recent tools, and favorites.

Tool pages no longer share one rigid format-specific template. Each catalog entry selects one of three
experience shells: `quick`, `file`, or `workspace`. The established `/image/...` and `/pdf/...` URLs and
their processing contracts remain canonical and behaviorally unchanged during the information
architecture migration.

The redesign preserves HereIsIt's central promise: browser tools process locally, file recommendation
does not upload or run anything automatically, and a future server tool must disclose its upload and
deletion boundary before any transfer occurs.

## Context and problem

The current navigation and page structure were designed around two file families:

- the header maps `이미지` and `PDF` directly to one representative tool instead of true hubs;
- the home page renders separate image and PDF grids and eagerly includes an image workbench;
- image and PDF page templates repeat a fixed three-step explanation and every tool in the same format;
- site metadata is split into independent `imageTools` and `pdfTools` collections;
- the mobile header assumes only two primary links.

That model becomes harder to understand and maintain as HereIsIt adds video, audio, data, text, AI,
developer, calculator, and everyday tools. A single long list would technically fit more items but would
not help users answer the two questions that matter: "I know what I want; where is it?" and "I have this
file; what can I do with it?"

## Goals

- Make known-item lookup fast through local search and a complete `/tools` catalog.
- Let a user choose or drop a local file and see compatible tools without uploading or auto-running it.
- Organize a growing catalog by both broad domain and user purpose.
- Make the selected home category and its tools visually inseparable.
- Keep the header useful when the catalog expands beyond image and PDF.
- Give simple utilities, file pipelines, and full editors appropriately different page structures.
- Keep every existing public image and PDF route, processing contract, and local-processing guarantee.
- Derive all discovery surfaces from one lightweight, validated catalog.
- Keep home, navigation, and catalog bundles free of codecs, workbenches, and processor Workers.
- Preserve keyboard, screen-reader, mobile, reduced-motion, and storage-denial usability.

## Non-goals

- Building a workflow editor or executing multi-tool workflows in this redesign.
- Implementing the planned video, audio, data, text, AI, developer, or everyday tools.
- Creating placeholder detail pages for planned tools.
- Adding accounts, cloud sync, server-side favorites, or cross-device history.
- Persisting selected files, filenames, file bytes, thumbnails, or recommendation results.
- Changing existing image or PDF tool contracts, codecs, limits, batch behavior, or result semantics.
- Adding a generic server-processing backend or silently falling back to upload processing.
- Replacing existing canonical `/image/...` and `/pdf/...` routes with category-based URLs.
- Introducing a new UI, search, state-management, or persistence dependency.

## Approach decision

Version one uses a hybrid discovery model:

1. search for users who know an action or tool name;
2. a separate local file recommender for users starting from a file;
3. domain tabs and purpose filters for browsing;
4. a unified catalog that supplies every discovery surface;
5. three experience shells selected by the needs of each tool.

This combines the strongest parts of three alternatives without making any one of them the entire
navigation:

1. A format-only hierarchy is familiar for image and PDF users but does not scale to calculators,
   developer tools, text tools, or cross-domain converters.
2. A flat "all tools" directory is easy to generate but becomes slow to scan, especially on mobile, and
   gives the home page no meaningful prioritization.
3. A file-first interface is useful when a file exists but excludes non-file tools and can feel unsafe if
   selecting a file starts work without a separate confirmation.

A fourth alternative, one universal tool-page template, is rejected because a word counter, a PDF
merger, and a canvas editor have fundamentally different interaction costs. Shared trust and navigation
elements remain consistent while the work area changes by shell.

## Information architecture

### Domains

The initial domain taxonomy is stable and ordered:

| ID | Korean label | Scope |
| --- | --- | --- |
| `all` | 전체·추천 | Featured, recent, and broadly useful available tools |
| `image` | 이미지 | Raster and vector image operations |
| `document` | PDF·문서 | PDF and document operations |
| `media` | 영상·오디오 | Video and audio operations |
| `data` | 데이터·변환 | Structured data and cross-format conversion |
| `text-ai` | 텍스트·AI | Text utilities and explicitly disclosed AI features |
| `web-dev` | 웹·개발 | Web and developer utilities |
| `everyday` | 생활·계산 | Calculators and everyday helpers |

`all` is a discovery view, not a category assigned to tools. A tool may belong to more than one real
domain. For example, an image-to-PDF converter can appear under both `image` and `document` while keeping
one stable ID and one canonical URL.

Domain IDs are internal and URL-safe. Korean labels can change without invalidating stored tool IDs or
shared catalog URLs. Adding or renaming a domain is a deliberate catalog schema change covered by
validation tests; individual pages do not define their own category labels.

### Purposes

The initial purpose taxonomy is:

- `optimize`: `압축·최적화`
- `convert`: `변환`
- `edit`: `편집`
- `create`: `만들기`
- `extract`: `추출·분석`
- `protect`: `보안·표시`

Purpose describes what the user wants to accomplish and is independent of domain. A tool may have
multiple purposes. `전체` is the unfiltered state and is not stored on catalog entries.

### Route map

The redesign adds these discovery routes:

| Route | Purpose |
| --- | --- |
| `/` | Search, local file recommendation, and domain-tab discovery |
| `/tools` | Searchable and filterable complete catalog |
| `/my-tools` | Local recent tools and favorites, with a useful empty state |
| `/workflows` | Honest "준비 중" explanation and examples; no workflow execution |

Existing `/image/...` and `/pdf/...` tool routes stay canonical. New tools may use the best stable domain
path for their product and SEO needs; catalog membership never rewrites that route. A cross-domain tool
has exactly one canonical route.

`/workflows` prevents the future-facing header item from being a dead control. It explains that planned
workflows will chain explicit tool steps locally when possible, labels every example `준비 중`, and
offers working links back to individual available tools. It contains no fake builder, disabled primary
call to action, or claim that workflow execution already exists.

### Indexing and metadata

The home page, `/tools`, and every available canonical tool route are indexable and included in the
sitemap. Filtered `/tools?...` views canonicalize to `/tools`. `/my-tools` is personalized client state,
so it is `noindex,follow` and omitted from the sitemap. `/workflows` is also `noindex,follow` and omitted
while it is only a preparation page; it becomes indexable only when a separately reviewed functional
workflow experience exists. Planned entries generate no metadata or sitemap URL.

The existing static-export verifier must derive expected available routes from the catalog instead of a
hardcoded image/PDF count. Metadata generation reads the lightweight catalog only and cannot import an
implementation configuration or processor.

## Unified tool catalog

### Catalog entry

The metadata source of truth is a static, dependency-free `ToolCatalog`. Its public shape is equivalent
to:

~~~ts
type ToolId = `${string}.${string}`;
type DomainId =
  | "image"
  | "document"
  | "media"
  | "data"
  | "text-ai"
  | "web-dev"
  | "everyday";
type PurposeId = "optimize" | "convert" | "edit" | "create" | "extract" | "protect";
type Experience = "quick" | "file" | "workspace";
type Execution = "browser" | "server";

type FileKind =
  | "image/jpeg"
  | "image/png"
  | "image/webp"
  | "image/heic"
  | "image/heif"
  | "application/pdf"
  | "text/plain"
  | "application/json"
  | "application/zip"
  | `video/${string}`
  | `audio/${string}`;

type ResultKind = FileKind | "value/text" | "value/number";

type CatalogBase = {
  id: ToolId;
  name: string;
  shortDescription: string;
  domains: readonly [DomainId, ...DomainId[]];
  purposes: readonly [PurposeId, ...PurposeId[]];
  searchAliases: readonly string[];
  rank: number;
};

type LauncherInput = {
  role: "source";
  kinds: readonly [FileKind, ...FileKind[]];
  minFiles: number;
  maxFiles: number;
  allowMixedKinds: boolean;
};

type AvailableToolEntry = CatalogBase & {
  availability: "available";
  route: `/${string}`;
  launcherInput: LauncherInput | null;
  outputKinds: readonly ResultKind[];
  experience: Experience;
  execution: Execution;
  contract: { id: string; version: number };
  featured: boolean;
  newUntil?: `${number}-${number}-${number}`;
  relatedToolIds: readonly [ToolId, ToolId, ToolId];
};

type PlannedToolEntry = CatalogBase & {
  availability: "planned";
  route?: never;
  launcherInput?: never;
  outputKinds?: never;
  experience?: never;
  execution?: never;
  contract?: never;
  featured?: never;
  newUntil?: never;
  relatedToolIds?: never;
};

type ToolCatalogEntry = AvailableToolEntry | PlannedToolEntry;
~~~

`LauncherInput` describes only the primary source files used for local discovery. Secondary inputs such
as an image-watermark logo are selected and validated inside the destination tool and remain part of its
versioned processing contract. This prevents the lightweight catalog from duplicating full processor
specifications. `minFiles` and `maxFiles` are recommendation constraints: a type-compatible tool below
its minimum can still appear after ready tools with a clear `파일 N개 더 필요` label, while a selection
above its maximum shows the limit and requires the user to reduce or choose a subgroup before handoff.
`allowMixedKinds` applies only among the explicitly listed kinds.

HEIC and HEIF MIME hints remain distinct catalog kinds, but structural detection may normalize a
supported HEIF-labelled HEIC still image to the canonical kind returned by the existing image inspector.
The destination contract remains authoritative. A tool with `launcherInput: null` is searchable and
browsable but is never offered by the file recommender.

Catalog IDs identify product surfaces; contract IDs identify processor protocols. They are deliberately
separate. For example, `image.compress`, `image.resize`, and `image.convert` are three catalog entries
that currently share `image.pipeline@1` without weakening any entry's stable identity.

### Existing tool classifications

The initial available entries use this mapping. File ranges are launcher-readiness ranges and must agree
with the destination's existing stricter validation; this redesign does not change those limits.

| Catalog ID | Canonical route | Domains | Purposes | Shell | Primary files | Contract |
| --- | --- | --- | --- | --- | --- | --- |
| `image.compress` | `/image/compress` | image | optimize | file | 1–100 image, mixed | `image.pipeline@1` |
| `image.resize` | `/image/resize` | image | edit, optimize | file | 1–100 image, mixed | `image.pipeline@1` |
| `image.convert` | `/image/convert` | image, data | convert | file | 1–100 image, mixed | `image.pipeline@1` |
| `image.watermark` | `/image/watermark` | image | edit, protect | file | 1–100 image, mixed | `image.watermark@1` |
| `pdf.merge` | `/pdf/merge` | document | create, edit | file | 2–20 PDF | `pdf.merge@1` |
| `pdf.split` | `/pdf/split` | document | extract, edit | file | 1 PDF | `pdf.split@1` |
| `pdf.organize` | `/pdf/organize` | document | edit | workspace | 1 PDF | `pdf.organize@1` |
| `pdf.watermark` | `/pdf/watermark` | document | edit, protect | file | 1 PDF | `pdf.watermark@1` |
| `pdf.to-image` | `/pdf/to-image` | document, image, data | convert, extract | file | 1 PDF | `pdf.to-images@1` |
| `pdf.image-to-pdf` | `/pdf/image-to-pdf` | image, document, data | convert, create | file | 1–100 JPG/PNG, mixed | `pdf.images-to-pdf@1` |
| `pdf.compress-scanned` | `/pdf/compress` | document | optimize | file | 1 PDF | `pdf.compress-scanned@1` |

Their intentional next actions are seeded as follows; later changes are reviewed catalog changes rather
than automatic same-format expansion:

| Catalog ID | Related tool IDs, in display order |
| --- | --- |
| `image.compress` | `image.resize`, `image.convert`, `image.watermark` |
| `image.resize` | `image.compress`, `image.convert`, `image.watermark` |
| `image.convert` | `image.compress`, `image.resize`, `pdf.image-to-pdf` |
| `image.watermark` | `image.compress`, `image.resize`, `pdf.watermark` |
| `pdf.merge` | `pdf.split`, `pdf.organize`, `pdf.image-to-pdf` |
| `pdf.split` | `pdf.merge`, `pdf.organize`, `pdf.to-image` |
| `pdf.organize` | `pdf.merge`, `pdf.split`, `pdf.watermark` |
| `pdf.watermark` | `pdf.organize`, `pdf.merge`, `image.watermark` |
| `pdf.to-image` | `pdf.image-to-pdf`, `pdf.split`, `image.convert` |
| `pdf.image-to-pdf` | `pdf.to-image`, `pdf.merge`, `image.convert` |
| `pdf.compress-scanned` | `pdf.merge`, `pdf.split`, `pdf.to-image` |

The concrete `FileKind` vocabulary grows through reviewed additions rather than arbitrary per-page
strings. A detector maps structural file evidence to these kinds.

Every available tool must declare exactly three intentional related tool IDs. The detail page renders
those in order after filtering out unavailable entries. It does not automatically show every tool from
the same file family. Catalog validation fails when an available tool references itself, a missing ID,
or fewer than three available related actions.

### Validation and ownership

The catalog is validated in pure unit tests and at build time:

- IDs and canonical routes are globally unique.
- Available routes resolve to a real statically exportable page; planned entries have no route.
- Domain, purpose, input-kind, result-kind, experience, execution, and availability values are known.
- Contract IDs are non-empty and versions are positive integers.
- Launcher file bounds are positive integers, `minFiles <= maxFiles`, and match current destination limits.
- Planned tools cannot declare routes, contracts, execution, experience, launcher inputs, or related IDs
  and are not referenced as related actions.
- Available tools have exactly three valid available related IDs.
- Rank values are finite and provide deterministic ordering with tool ID as the final tie-breaker.
- Search aliases are trimmed, NFC-normalized, and unique within an entry after normalization.

Catalog metadata must not import React components, workbenches, Workers, WASM, PDF parsers, image
codecs, tool implementations, or the runtime `@hereisit/tool-contracts` entry point, which imports Zod.
Catalog data uses literals and type-only imports in a dedicated lightweight entry point. Processor-side
tests may compare catalog contract literals with runtime contract constants without placing those
constants in discovery bundles. Route modules load their actual UI and processor only after navigation.

The concrete shared manifest lives at `packages/tool-registry/src/tool-catalog.ts`. It uses literal data,
erasable TypeScript syntax, relative/type-only imports only, and no runtime dependency or path alias. The
web app imports its public lightweight subpath, while the existing Node 24 static-export verifier imports
that same source file directly. This is one authored manifest, not generated or copied JSON, and requires
no new loader dependency.

The catalog owns discovery and SEO identity: stable ID, name, short description, canonical route,
taxonomy, aliases, launcher envelope, availability, rank, featured/new state, and related IDs. A separate
implementation configuration keyed by `ToolId` owns processor intent/class, detailed limits, warnings,
long default summaries, runtime requirements, and lazy workbench composition. It must not duplicate
catalog-owned fields. Tool pages and temporary migration adapters join the two by ID. Build tests compare
launcher bounds with the corresponding lightweight implementation-limit descriptors so the recommender
cannot promise a selection that the current destination rejects merely because the two configurations
drifted.

During migration, temporary typed adapters may expose `imageTools` and `pdfTools` views for old page
code. Those adapters join `ToolCatalog` with the implementation configuration; they are not independently
maintained datasets. Once all consumers migrate, the adapters are removed. There is never more than one
editable source for a tool's name, route, taxonomy, availability, or related IDs.

### Planned tools

`/tools` shows available tools by default. An `예정 도구 포함` control adds a separate, clearly labelled
planned section after the available results. A planned card has a `준비 중` badge, no link, no button,
no public page, and no reserved route. It cannot appear in home recommendations, file recommendations,
search suggestions, recent tools, favorites, related actions, metadata, or the sitemap. This permits
honest roadmap context without creating fake product surfaces.

## Home page

The home page follows this order:

1. compact global header;
2. title and trust statement;
3. prominent tool search field;
4. a separate local file-selection/drop area;
5. compact domain tabs;
6. the visibly attached selected-domain tool panel;
7. supporting privacy and product explanation.

The home page does not mount a workbench or import processing code.

### Search field

The search field is a tool lookup, not a file picker. As the user types, it locally shows up to five
available matches from catalog metadata. Selecting a suggestion navigates to the canonical tool route.
Submitting text navigates to `/tools?q=<encoded query>`, where the full local result list appears.

Ranking and filtering use no search API and send no search analytics. A submitted query is intentionally
shareable in `/tools?q=...`; a reload or shared URL can therefore expose that text in ordinary CDN or
origin access logs. The UI never derives this query from a selected file, and it should be treated as a
general tool-search phrase rather than private file data. Empty search does not show a blank overlay; the
user remains on the curated home view.

### Local file recommender

The file area says that choosing a file only finds compatible tools and that the file stays on the
device. Selection never starts a conversion, upload, decode, or full-file read. Once structural detection
finishes, the area replaces its empty state with:

- the detected general type, without echoing the filename into logs, URLs, or persistence;
- compatible available tools ordered by catalog rank and relevance;
- a clear `도구 선택` action on each recommendation;
- `다른 파일 선택` and `파일 없이 도구 찾기` escape paths.

Unknown or unsupported input produces a neutral explanation and links to search and domain browsing.
It does not guess from the extension alone. Mixed selections first show tools compatible with the entire
selection; if none exist, results are grouped by detected type and the user chooses which group to
continue with. The recommender never auto-navigates or auto-runs.

One selection event may contain up to 100 file references. Detection reads at most the first 64 KiB of
each file, processes no more than two prefixes concurrently, and releases each prefix buffer before
moving on. MIME and extension values are hints only; recommendation requires supported structural
evidence. Files beyond the count cap are not inspected, and the UI asks the user to reduce the selection.
Individual tools still enforce their own stricter count, byte, geometry, and runtime limits after entry.

Selection immediately displays `0/N개 형식 확인 중` and updates the completed count after every prefix.
Each selection increments a generation token and stops scheduling reads for the prior generation. A new
selection, reset, or unmount invalidates prior work; an already-running read may finish, but its token is
checked before any state update and its buffer is released in `finally`. Only the newest generation may
publish recommendations or create a pending handoff. This gives fast, honest feedback and prevents a
slow earlier selection from overwriting newer results.

### Domain tabs and attached result panel

The tab labels appear in the fixed domain order defined above. They are compact horizontal/wrapping
controls rather than a vertical sidebar or oversized category cards:

- wide desktop: eight tabs in one row;
- medium width: four tabs per row;
- mobile: two tabs per row.

The selected tab is visually connected to the result panel immediately below it. That panel always
contains a heading, a one-line description, an available-tool count, and a responsive card grid. It may
never disappear while a tab is selected. Tool cards appear in multiple columns and rows according to
available width; mobile keeps two columns when accessibility font scaling and the viewport permit it,
then falls back to one without horizontal scrolling.

Each home panel shows at most 12 cards. `전체·추천` takes up to four recent available IDs, then fills with
deduplicated featured entries and finally other available entries in ascending `rank` and tool-ID order.
Other panels show the first 12 available tools in that domain using the same deterministic order and
include a working `모두 보기` link to the corresponding `/tools` URL. Planned tools never appear here.

## Header and global menus

The approved desktop header is:

`HereIsIt | 모든 도구 | 워크플로 | 내 도구 | 검색`

- `HereIsIt` links home.
- `모든 도구` opens the mega menu on click, Enter, or Space.
- `워크플로` links to `/workflows` and carries a restrained `준비 중` label until execution exists.
- `내 도구` links to `/my-tools`.
- `검색` opens or focuses a compact catalog search control.

The desktop `모든 도구` mega menu contains all seven real domain links, up to four featured quick-start
tools, up to four recent available tools when local history exists, a small honest workflow teaser, and
links to `/tools` and `/workflows`. All tool content comes from the catalog. The trigger exposes
`aria-expanded` and `aria-controls`; the mega panel is a navigation disclosure rather than an ARIA
application menu. Focus stays on the trigger when it opens so Tab reaches the first link predictably. It
closes on an outside pointer action or Escape, and focus returns to the trigger. Opening one global
overlay closes any other.

On small screens, one menu button opens a modal drawer containing search, the four primary destinations,
a two-column domain grid, available recent tools, and a local-processing privacy footer. The drawer
traps focus, initially focuses its close control, closes on Escape or that control, restores trigger
focus, prevents background scrolling, and does not rely on hover.

## Complete catalog at `/tools`

The catalog page contains, in order:

1. page title and local search;
2. the same compact/wrapping domain tabs;
3. purpose filters;
4. an available-results count and card grid;
5. an optional planned-tools control and separate planned section.

The filters combine with AND semantics: a result must match the query, selected real domain, and selected
purpose. `전체` removes the corresponding constraint. Available results are sorted by relevance for a
non-empty query and by ascending `rank`, then tool ID, otherwise. The initial render is capped at 24
cards; a local `더 보기` control reveals the next 24 without a network request. Changing filters resets
the visible count.

Catalog state is shareable and survives browser back/forward navigation:

~~~text
/tools?q=png&domain=image&purpose=convert&planned=1
~~~

Default values are omitted. Invalid values are ignored and replaced with safe defaults. Query updates
use history replacement while typing and history pushes for explicit tab, filter, or planned-state
changes. No filename, file type discovered from a user's selection, recent-tool list, or favorite is
placed in the URL.

Because HereIsIt is statically exported, a client filter island reads these search parameters behind a
static fallback; `/tools` does not become a dynamic server route. Every query-string variant declares
`/tools` as its canonical URL.

On mobile, domain tabs use two columns, purpose filters wrap, and tool cards target two columns before
falling back to one for constrained width or enlarged text. The page never requires horizontal scrolling.

## Local search behavior

Search normalization trims input, applies Unicode NFC normalization, lowercases where applicable, and
collapses repeated whitespace. Version one deliberately avoids fuzzy-search dependencies and opaque
ranking. Available entries are ranked in this order:

1. exact tool name;
2. tool-name prefix;
3. exact alias;
4. alias prefix;
5. name or alias substring;
6. purpose-label or purpose-ID match;
7. domain-label or domain-ID match;
8. ascending catalog `rank`, then stable tool ID.

Each entry appears once even when several fields match. Planned entries participate only in the separate
planned section when the user enables it. The search index contains metadata strings only and is built
without importing page or processor modules.

## My tools

`/my-tools` is useful without authentication. It has two local sections:

- `즐겨찾기`: tool IDs explicitly starred by the user;
- `최근 사용`: the most recently entered available tool IDs, newest first.

Storage values are versioned arrays containing tool IDs only. Array order provides recency; timestamps,
queries, filenames, file types, settings, results, thumbnails, and selected files are not stored. Both
lists are deduplicated and capped at 12 IDs. Missing, planned, or removed IDs are ignored when rendered.

If persistent browser storage is denied or unavailable, HereIsIt uses an in-memory list for the current
document runtime and shows a subtle non-blocking explanation. All catalog-owned internal navigation in
the header, cards, related actions, and tool pages uses Next client navigation, so that fallback survives
normal in-app movement. An unavoidable hard navigation or reload starts a new empty fallback; no marker is
persisted merely to distinguish that case. Search, file recommendation, tool processing, and saving
results continue to work. The empty state links to available featured tools and `/tools`.

Entering a tool route updates recent IDs. Starring a tool is an explicit action on available tool cards
and detail pages. No account prompt appears in this redesign.

## Tool detail experiences

Tool pages share navigation and trust behavior, not one rigid work area. The catalog selects one of three
shells.

### `quick`

For calculators, text utilities, encoders, generators, and developer helpers where input and output can
fit in one view.

- input and result remain visible together;
- processing is immediate only for non-file values where that is expected and reversible;
- copy and save actions are explicit and accessible;
- large optional explanations follow the result instead of separating input from output.

### `file`

For bounded upload-style browser pipelines such as image compression, conversion, or PDF merging.

- selection/drop area;
- tool-specific settings and constraints;
- explicit start action;
- honest per-item or overall progress;
- result preview or summary;
- explicit individual or batch save actions.

The selected file is not uploaded merely because the UI resembles an upload area. Existing image and
PDF workbenches are inserted into this shell during migration without changing their processors.

### `workspace`

For crop, annotate, compose, arrange, and other iterative visual operations.

- persistent canvas or document surface;
- contextual sidebars or toolbars;
- reversible edit state and clear reset/undo behavior appropriate to the tool;
- a sticky, explicit export/save action;
- no claim that an edit is saved before the user exports it.

Workspace code and assets load only after entering that tool.

The current 11-tool inventory uses `file` and `workspace`; it has no honest `quick` tool. This redesign
defines and reserves the `quick` catalog contract but does not ship an unused quick component or a fake
public route. Its production UI and browser coverage arrive with the first real quick tool. This keeps
the information architecture extensible without manufacturing implementation scope solely to exercise
an otherwise unused branch.

### Shared modules

Every available tool page includes:

- global header and breadcrumb;
- tool title and concise purpose;
- a visible execution disclosure: `이 기기에서 처리` or an explicit server boundary;
- constraints and corrective errors near the affected control;
- honest progress where work is not instantaneous;
- explicit result saving;
- exactly three intentional next-action cards from `relatedToolIds`.

Optional modules include examples, settings, batch lists, before/after previews, privacy details, FAQs,
and SEO explanation. Pages compose only the modules they need. The old fixed three-step block and the
automatic list of every same-format tool are removed.

## File recommendation and handoff

### Detection flow

File recommendation is a local capability match:

~~~text
select files
  -> read bounded prefixes
  -> structural type detection
  -> map detected input kinds to available catalog entries
  -> show recommendations
  -> user explicitly selects one tool
  -> client-side in-memory handoff
  -> destination validates and presents its normal start action
~~~

The launcher adds a dedicated, versioned, prefix-only general-kind detector. It recognizes only bounded
container signatures needed for recommendation and returns unknown for incomplete evidence. It does not
reuse full image inspectors or PDF validators on arbitrary truncated input; those existing validators
continue to read and validate the complete data only after entering a destination tool. A supplied MIME
type or extension can narrow which signatures are tested but cannot establish support by itself.
Detection does not decode pixels, inspect dimensions, parse document bodies, create thumbnails, create
object URLs, or call a server. A future format that cannot be identified honestly within the prefix
budget remains unknown in this launcher and can still be selected inside a dedicated tool with its own
validation.

Recommendations include only `available` entries with a compatible `launcherInput`. A complete selection
inside its declared bounds is ready; a type-compatible selection below `minFiles` is secondary and states
how many more files are needed; a selection above `maxFiles` cannot be handed off until the user reduces
or chooses a compatible subgroup. Ranking favors ready complete-selection matches, then exact detected
kind, ascending catalog rank, and stable ID. File contents and filenames never influence marketing or
remote analytics.

### Pending selection handoff

The selected `File` references use a single module-scoped, in-memory pending record:

~~~ts
type PendingToolSelection = {
  targetToolId: ToolId;
  items: readonly {
    file: File;
    detectedKind: FileKind;
  }[];
  createdAtMonotonicMs: number;
};
~~~

There is at most one record per tab. Creating a new record clears references from the old one. The record
expires after 60 seconds and can be consumed once only by the matching available tool ID. Consumption,
expiry, a nonmatching consumption attempt, and replacement all clear the record immediately. When the
user chooses a detected-type subgroup, only that subgroup's paired file/kind items enter the record.

Recommendation actions create the record and use client-side routing; they are never plain hard-navigation
anchors. Their Next links disable automatic prefetch so merely rendering recommendations cannot trigger
a request. Destination workbenches gain a narrow initial-file adapter that consumes the matching record,
moves its file references into ordinary component state, and then invokes the same complete validation as
manual selection before enabling processing. The adapter does not alter Worker or processor contracts.

The record is never serialized to a URL, local storage, session storage, IndexedDB, history state, a log,
or a server. It creates no object URLs. When the same client runtime observes expiry or a nonmatching
consume, it shows `파일을 다시 선택해 주세요`. A hard navigation, reload, or restored tab has no safe way
to distinguish a lost handoff from an ordinary first visit, so it shows the normal empty selector and
persists no marker merely to produce a special message. Client navigation to another page does not extend
the original 60-second expiry. Handoff never bypasses the destination's explicit start action.

## Execution disclosure and future server tools

All current migrated image and PDF tools remain `execution: "browser"`. Their shared disclosure states
that the file stays in the current device and that saving is explicit.

A future `execution: "server"` entry is incomplete unless its detail experience adds, before selection or
transfer:

- an unmistakable server-upload label;
- what data is transferred and why;
- retention/deletion behavior and a link to the applicable policy;
- limits and likely processing time;
- explicit user confirmation before the first byte is uploaded.

The home file recommender still operates locally for such a tool and does not upload during detection.
There is no automatic browser-to-server fallback.

## Error and empty-state behavior

Errors distinguish the action the user can take:

- `파일 형식을 확인하지 못했어요`: browse/search or choose another file;
- `이 형식에 맞는 도구가 아직 없어요`: show relevant domains and planned tools only when requested;
- `이 브라우저에서는 사용할 수 없어요`: explain the missing runtime capability;
- `도구의 파일 개수 또는 크기 제한을 넘었어요`: show the tool's actual limit;
- `파일을 다시 선택해 주세요`: the current client runtime observed pending handoff expiry or mismatch;
- processor-specific failures: preserve existing structured, per-item corrective messages.

No failure silently uploads, auto-runs another tool, or discards successful batch results. A missing
catalog entry fails the build rather than rendering an ambiguous card. Empty search and filter results
keep the active filters visible and offer a one-action reset.

## Performance and resource policy

- `/`, `/tools`, `/my-tools`, `/workflows`, the header, and the mega menu import catalog metadata only.
- Image codecs, PDF parsers, workbenches, Workers, editors, and WASM are absent from discovery-route
  client chunks and load only from their tool routes.
- The home page does not render `ImageWorkbench`, `PdfWorkbench`, or an invisible processor preload.
- File recommendation reads at most 64 KiB per file with two concurrent prefix reads and releases buffers
  promptly; it never reads the full file for discovery.
- Home domain panels show at most 12 cards. `/tools` progressively reveals groups of 24 cards. The mega
  menu shows at most four featured and four recent tools.
- Search and filters run locally over normalized catalog metadata and require no network round trip.
- Route metadata and sitemap generation reuse the catalog without importing implementation code.
- Existing tool-specific Worker concurrency, memory, timeout, result-budget, and cancellation policies are
  unchanged by this redesign.
- CSS and platform APIs implement menus, tabs, filtering, and persistence; no new runtime dependency is
  added.

The static-export verifier consumes the same dependency-free catalog manifest instead of hardcoding the
current 11 paths. It checks every available catalog route plus `/`, `/tools`, `/my-tools`, and
`/workflows`, and scans each discovery route's dependency closure for every known workbench, Worker,
PDF.js, codec, editor, and WASM marker. A separate static-import boundary test follows discovery entry
points and rejects imports from processor/runtime modules even when minification removes readable marker
names.

Phase 2 records a checked-in gzip baseline for route-owned JavaScript chunks. Each discovery route may
own at most 75 KiB gzip, the combined discovery-only shared layer may be at most 120 KiB gzip, and a later
change may grow either a route or the shared layer by no more than the smaller of 10 KiB or 10% without
an explicit reviewed budget update. Framework chunks shared by every Next route are reported separately,
not hidden inside the route budget. Pulling processor code into discovery routes blocks release even when
the numeric budget still passes.

## Accessibility and responsive behavior

- All interactive controls have visible keyboard focus and an accessible name.
- Mega-menu triggers support click, Enter, and Space, expose `aria-expanded`/`aria-controls`, and keep
  trigger focus until Tab enters the disclosure; Escape closes and returns focus.
- Mobile menu focus is trapped until close, background content is inert, and body scroll is restored.
- Domain tabs use a roving tab stop, `aria-selected`, associated tab panels, and arrow-key navigation.
- Wrapped tabs follow DOM order: Left/Right select the previous/next tab with wraparound, Home/End select
  the first/last tab, and Up/Down remain native scrolling keys rather than guessing visual rows.
- Search suggestions expose active option state and support arrows, Enter, Escape, and touch.
- Visible search results update locally as input changes, while their polite result-count announcement is
  debounced for 150 ms so screen readers do not announce every intermediate keystroke.
- File detection and processing progress use polite live regions; errors move focus only when submission
  cannot continue.
- Tool cards remain usable at 200% zoom and enlarged mobile text without clipped actions or horizontal
  scrolling.
- Color is never the only signal for selected, available, planned, new, local, or server states.
- Reduced-motion preference removes non-essential menu, panel, and card motion.
- The implementation plan includes a short manual VoiceOver/Safari and NVDA/Firefox-or-Chrome checklist
  for header, search, tabs, file recommendation, and one representative tool page. Ubuntu CI cannot run
  those screen readers, so Playwright keyboard/semantic coverage is the automated release gate; a release
  owner with access to the required platform records the manual result in deployment notes when available.

## Privacy and security

- File recommendation makes no fetch, beacon, analytics, image, font, or other external request caused by
  the file selection.
- Prefix bytes, filenames, MIME hints, detected kinds, thumbnails, and selected tool recommendations are
  not logged or persisted.
- Source bytes, file contents, filenames, thumbnails, object URLs, and future presigned URLs are never
  passed to `console`, application loggers, analytics, or error-reporting breadcrumbs/events.
- No source file receives an object URL during recommendation.
- URLs contain catalog query/filter state only, never file-derived state.
- Recent tools and favorites store tool IDs only and continue safely when storage is unavailable.
- Catalog labels and aliases are static developer-authored strings; search renders them as text, never
  injected HTML.
- A tool route revalidates every handed-off file and does not trust the recommender's detected kind.
- Existing source/result object-URL revocation and Worker cleanup rules remain owned by each workbench.
- Future server tools require explicit pre-transfer disclosure and confirmation.

## Testing strategy

### Pure unit tests

- catalog ID, route, taxonomy, contract, availability, rank, and related-tool validation;
- deterministic catalog ordering and cross-domain de-duplication;
- normalization and every search-ranking tier, including Korean and Latin aliases;
- domain plus purpose plus query filtering and invalid URL-state recovery;
- structural detection from bounded prefixes and refusal to trust extension/MIME alone;
- multi-file capability intersection and grouped fallback;
- detection generation races, reset/unmount cancellation, stale-result rejection, progress counts, and
  buffer release after success or failure;
- pending handoff target matching, 60-second expiry, replacement, and one-consume behavior;
- recent/favorite de-duplication, caps, removed IDs, and denied-storage fallback.

### Component and browser tests

- desktop mega menu, outside close, Escape close, and focus return;
- mobile drawer focus trap, background inertness, scroll restoration, and two-column domains;
- home tabs, connected panel, arrow-key navigation, counts, responsive wrapping, and `모두 보기` URLs;
- search suggestions and `/tools` query/filter/history behavior;
- available/planned separation and absence of links on planned cards;
- unknown type, unsupported browser, tool-limit, empty-result, and expired-handoff messages;
- `/my-tools` favorites, recent order, empty state, and storage denial;
- representative current `file` and `workspace` pages at desktop and mobile sizes; the pure catalog
  validator accepts a `quick` fixture, while quick UI coverage begins with the first real quick tool;
- keyboard-only and reduced-motion coverage.

### Privacy and regression tests

- intercept network APIs while selecting files and assert that recommendation causes no external request;
- assert that filenames and detected file state never enter URLs or persistent storage;
- use sentinel filenames and byte markers to assert that selection and handoff do not call console,
  application logging, analytics, or error-reporting APIs with filenames, contents, thumbnails, object
  URLs, or presigned URLs;
- assert discovery-route client bundles exclude known processor, codec, parser, Worker, and workbench
  modules;
- run all existing image and PDF tool suites without changing byte, dimension, warning, naming, progress,
  cancellation, or saving expectations;
- cover Chromium, Firefox, WebKit, and representative mobile viewports;
- verify static export, canonical metadata, sitemap entries, and existing public routes.

`pnpm verify` is required during implementation. `pnpm verify:all` is required before release because the
approved behavior includes browser navigation, local files, keyboard interaction, responsive layouts,
and bundle boundaries.

## Migration and rollout

Implementation is incremental so information architecture work cannot destabilize processors.

### Phase 1: catalog foundation

- Add the static schema, taxonomy, existing image/PDF entries, validation, and search/filter helpers.
- Make the catalog the metadata source of truth.
- Add the prefix-only launcher detector; do not reuse complete image/PDF validators on truncated input.
- Keep temporary derived image/PDF adapters for consumers that have not migrated yet.
- Replace the static-export verifier's hardcoded 11-tool/image/PDF assumptions with the lightweight
  catalog manifest and the complete discovery-route processor-marker set.
- Add unit tests before moving navigation.

### Phase 2: discovery surfaces

- Build the approved header, desktop mega menu, mobile drawer, and global search behavior.
- Replace the home workbench-first layout with search, local file recommendation, tabs, and the attached
  result panel.
- Add `/tools`, `/my-tools`, and the honest `/workflows` page.
- Add recommendation-only client routing, prefetch suppression, one-consume pending handoff, and narrow
  initial-file adapters for existing workbenches.
- Verify that discovery bundles do not contain processing code and meet the recorded gzip budgets.

### Phase 3: detail shells

- Add shared navigation, trust, error, save, and next-action modules.
- Implement the current `file` and `workspace` shell boundaries; keep `quick` as a validated catalog
  experience until the first real quick tool justifies its production UI.
- Place existing workbenches inside the appropriate shell without changing processor contracts.
- Remove the fixed three-step block and automatic same-format related list.

### Phase 4: compatibility cleanup

- Migrate metadata, sitemap, cards, search, and every detail page to catalog selectors.
- Remove temporary independent-looking adapters once no consumer needs them.
- Run the full browser and production-build verification matrix.
- Work on a feature branch and use the existing Cloudflare preview before production.
- Merge to auto-deploying `main` only after `pnpm verify:all`, the production export checks, and CI WebKit
  pass; then verify the production URL through the existing Cloudflare pipeline.

Rollout does not create planned tool routes and does not change canonical URLs. A temporary feature flag
may protect the new navigation during development, but the final exported build has one coherent
navigation rather than two user-selectable systems.

## Acceptance criteria

The redesign is complete when all of the following are true:

- The header displays `모든 도구`, `워크플로`, `내 도구`, and search on desktop and an accessible drawer
  equivalent on mobile.
- `모든 도구` opens the approved mega menu and `/tools` provides shareable search/domain/purpose state.
- The home page has separate search and file recommendation areas, followed by compact wrapping tabs and
  an always-visible selected-domain result panel.
- Selecting files on home reads bounded local prefixes, makes no external request, shows recommendations,
  and never auto-runs or auto-uploads.
- An explicit tool choice can hand file references to the matching route once within 60 seconds; observed
  expiry asks for reselection, while reload safely returns to the ordinary empty selector without leaking
  or persisting file state.
- One validated catalog drives navigation, search, filters, home cards, metadata, sitemap, recent tools,
  favorites, and intentional related actions.
- Planned tools are hidden by default, clearly separated when enabled, and have no clickable fake route.
- `/my-tools` works without an account and persists only capped arrays of tool IDs when storage permits.
- `/workflows` is an honest, working preparation page and no workflow execution is implied.
- Available detail pages use their catalog-assigned current `file` or `workspace` experience and show
  execution disclosure, explicit saving, errors/limits, and three intentional next actions; the catalog
  can validate future `quick` entries without a fake quick route in this release.
- Existing image and PDF canonical routes and processor behaviors pass their regression suites unchanged.
- Discovery-route production chunks contain no heavy workbench, codec, parser, Worker, editor, or WASM
  implementation.
- Keyboard, screen-reader semantics, 200% zoom, reduced motion, storage denial, and target mobile layouts
  pass the approved browser tests.
- `pnpm verify` and `pnpm verify:all` pass before deployment.

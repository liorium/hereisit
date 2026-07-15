# Tool Catalog Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one dependency-light catalog the source of truth for the 11 available HereIsIt tools, then add pure discovery and bounded file-kind primitives without changing any current page or processor behavior.

**Architecture:** `@hereisit/tool-registry` publishes isolated catalog, discovery, and file-kind subpaths that contain literal data and pure functions only. The web app joins catalog-owned identity to a separately keyed implementation configuration during migration. SEO and static-export checks consume catalog identity without importing processors, workbenches, React, Zod, or browser runtimes.

**Tech Stack:** Node.js 24.13, pnpm 11.11, TypeScript 6, Next.js 16 static export, React 19, Vitest 4, existing Node verification scripts, Cloudflare Pages.

## Global Constraints

- Execute in an isolated feature worktree created with `superpowers:using-git-worktrees`; do not implement on auto-deploying `main`.
- Preserve all 11 canonical routes, versioned processing contracts, file limits, warnings, Workers, output naming, cancellation, progress, and save behavior.
- Keep source files local. Never log or persist file contents, filenames, thumbnails, object URLs, or presigned URLs.
- Do not add a dependency.
- Keep `packages/tool-registry/src/tool-catalog.ts` valid erasable TypeScript that Node 24 can import directly without a loader.
- Catalog modules may not import React, Zod at runtime, workbenches, Workers, codecs, PDF.js, browser runtime modules, or tool implementations.
- The catalog owns ID, name, description, route, taxonomy, aliases, availability, launcher envelope, rank, featured state, and related IDs. Implementation configuration owns intent/class, limits, detailed copy, notices, and bundle profile; it must not duplicate catalog-owned fields.
- Available entries require a real static page, contract, execution mode, experience, and exactly three available related IDs. Planned entries expose none of those executable fields and never reserve a route.
- Use RED → GREEN → REFACTOR for each behavior and make the focused Conventional Commit listed in each task.

---

## File Map

### New files

- `packages/tool-registry/src/tool-catalog.ts` — taxonomy, discriminated catalog, validation, selectors.
- `packages/tool-registry/src/tool-catalog.test.ts` — manifest and contract-boundary tests.
- `packages/tool-registry/src/tool-discovery.ts` — pure normalization, search, filtering, URL state, home selection, and capability matching.
- `packages/tool-registry/src/tool-discovery.test.ts` — deterministic discovery tests.
- `packages/tool-registry/src/file-kind.ts` — versioned detector over at most a 64 KiB prefix.
- `packages/tool-registry/src/file-kind.test.ts` — structural detection and hostile-hint tests.
- `apps/web/src/lib/site-identity.ts` — site URL and home metadata independent of tool implementations.
- `apps/web/src/lib/tool-implementations.ts` — implementation-only configuration keyed by available catalog ID.
- `tests/catalog-import-boundary.test.ts` — static import-closure guard for lightweight modules.
- `tests/tool-catalog-routes.test.ts` — available-route existence and planned-route absence.

### Modified files

- `packages/tool-registry/package.json` — retain root presets and publish three lightweight subpaths.
- `apps/web/src/lib/site.ts` and `apps/web/src/lib/site.test.ts` — temporary catalog-derived legacy adapters.
- `apps/web/src/lib/metadata.ts` — catalog-only tool metadata function.
- `apps/web/src/app/layout.tsx`, `apps/web/src/app/robots.ts`, `apps/web/src/app/sitemap.ts` — use site identity and catalog only.
- `apps/web/src/app/image/compress/page.tsx`, `apps/web/src/app/image/resize/page.tsx`, `apps/web/src/app/image/convert/page.tsx`, `apps/web/src/app/image/watermark/page.tsx` — pass strict catalog entries to metadata.
- `apps/web/src/app/pdf/merge/page.tsx`, `apps/web/src/app/pdf/split/page.tsx`, `apps/web/src/app/pdf/organize/page.tsx`, `apps/web/src/app/pdf/watermark/page.tsx`, `apps/web/src/app/pdf/to-image/page.tsx`, `apps/web/src/app/pdf/image-to-pdf/page.tsx`, `apps/web/src/app/pdf/compress/page.tsx` — pass strict catalog entries to metadata.
- `scripts/verify-static-export.mjs` — derive pages from the catalog and bundle markers from implementation profiles.

### Task 1: Publish and validate the unified catalog

**Files:**
- Create: `packages/tool-registry/src/tool-catalog.ts`
- Create: `packages/tool-registry/src/tool-catalog.test.ts`
- Modify: `packages/tool-registry/package.json`

**Interfaces:**
- Consumes: no runtime imports; processor contract constants are test-only.
- Produces: the taxonomy, manifest, exact `AvailableToolId` union, and strict lookup functions used by every later task.

~~~ts
export const domainDefinitions: readonly DomainDefinition[];
export const domainFilterDefinitions: readonly DomainFilterDefinition[];
export const purposeDefinitions: readonly PurposeDefinition[];
export const toolCatalog: readonly ToolCatalogEntry[];
export const availableToolEntries: readonly AvailableToolEntry[];
export const plannedToolEntries: readonly PlannedToolEntry[];
export function findToolById(id: string): ToolCatalogEntry | undefined;
export function findAvailableToolById(id: string): AvailableToolEntry | undefined;
export function getAvailableToolById(id: AvailableToolId): AvailableToolEntry;
export function getRelatedAvailableTools(
  id: AvailableToolId,
): readonly [AvailableToolEntry, AvailableToolEntry, AvailableToolEntry];
~~~

- [ ] **Step 1: Write the failing manifest tests**

Create `tool-catalog.test.ts` and first assert the approved inventory, discriminants, and lookup behavior:

~~~ts
import { describe, expect, it } from "vitest";
import {
  availableToolEntries,
  defineToolCatalog,
  getAvailableToolById,
  getRelatedAvailableTools,
  plannedToolEntries,
  toolCatalog,
} from "./tool-catalog";

describe("tool catalog", () => {
  it("publishes 11 real tools and one honest roadmap card", () => {
    expect(availableToolEntries).toHaveLength(11);
    expect(plannedToolEntries.map((tool) => tool.id)).toEqual(["media.video-compress"]);
    expect(getAvailableToolById("image.compress")).toMatchObject({
      route: "/image/compress",
      contract: { id: "image.pipeline", version: 1 },
      experience: "file",
      execution: "browser",
    });
    expect(getAvailableToolById("pdf.organize").experience).toBe("workspace");
  });

  it("keeps IDs, routes, aliases, and intentional relations valid", () => {
    expect(new Set(toolCatalog.map((tool) => tool.id)).size).toBe(toolCatalog.length);
    expect(new Set(availableToolEntries.map((tool) => tool.route)).size).toBe(11);
    expect(getRelatedAvailableTools("pdf.merge").map((tool) => tool.id)).toEqual([
      "pdf.split",
      "pdf.organize",
      "pdf.image-to-pdf",
    ]);
  });

  it("rejects executable fields on a planned entry", () => {
    expect(() => defineToolCatalog([{
      id: "media.fake",
      name: "가짜 도구",
      shortDescription: "경계 검증용 도구",
      domains: ["media"],
      purposes: ["convert"],
      searchAliases: [],
      rank: 1,
      availability: "planned",
      route: "/fake",
    }] as never))
      .toThrow(/planned/i);
  });

  it("rejects missing, planned, duplicate, or self-related tools", () => {
    const broken = structuredClone(availableToolEntries) as Array<Record<string, unknown>>;
    broken[0] = {
      ...broken[0],
      relatedToolIds: ["image.compress", "missing.tool", "media.video-compress"],
    };
    expect(() => defineToolCatalog(broken as never)).toThrow(/related/i);
  });
});
~~~

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `pnpm test packages/tool-registry/src/tool-catalog.test.ts --run`

Expected: FAIL because `./tool-catalog` does not exist.

- [ ] **Step 3: Implement the exact discriminated types**

Implement these types without a runtime import:

~~~ts
export type ToolId = `${string}.${string}`;
export type DomainId =
  | "image" | "document" | "media" | "data" | "text-ai" | "web-dev" | "everyday";
export type DiscoveryDomainId = "all" | DomainId;
export type PurposeId = "optimize" | "convert" | "edit" | "create" | "extract" | "protect";
export type PurposeFilter = "all" | PurposeId;
export type Experience = "quick" | "file" | "workspace";
export type Execution = "browser" | "server";
export type FileKind =
  | "image/jpeg" | "image/png" | "image/webp" | "image/heic" | "image/heif"
  | "application/pdf" | "text/plain" | "application/json" | "application/zip"
  | `video/${string}` | `audio/${string}`;
export type ResultKind = FileKind | "value/text" | "value/number";

export interface DomainDefinition {
  id: DomainId;
  label: string;
  description: string;
}
export interface DomainFilterDefinition {
  id: DiscoveryDomainId;
  label: string;
  description: string;
}
export interface PurposeDefinition { id: PurposeId; label: string }

interface CatalogBase {
  id: ToolId;
  name: string;
  shortDescription: string;
  domains: readonly [DomainId, ...DomainId[]];
  purposes: readonly [PurposeId, ...PurposeId[]];
  searchAliases: readonly string[];
  rank: number;
}

export interface LauncherInput {
  role: "source";
  kinds: readonly [FileKind, ...FileKind[]];
  minFiles: number;
  maxFiles: number;
  allowMixedKinds: boolean;
}

export type AvailableToolEntry = CatalogBase & {
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

export type PlannedToolEntry = CatalogBase & {
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

export type ToolCatalogEntry = AvailableToolEntry | PlannedToolEntry;
export function defineToolCatalog<const T extends readonly ToolCatalogEntry[]>(entries: T): T;
~~~

Declare `toolCatalog` with `as const` through `defineToolCatalog()`, then infer the exact available ID union from the authored result rather than maintaining another union:

~~~ts
export type AvailableToolId = Extract<
  (typeof toolCatalog)[number],
  { availability: "available" }
>["id"];
~~~

Export Korean `domainDefinitions` for `이미지`, `PDF·문서`, `영상·오디오`, `데이터·변환`, `텍스트·AI`, `웹·개발`, and `생활·계산` in that order. Their descriptions are respectively `사진과 이미지 작업 도구를 모았어요.`, `PDF와 문서 작업 도구를 모았어요.`, `영상과 오디오 작업 도구를 모았어요.`, `데이터와 형식 변환 도구를 모았어요.`, `텍스트와 명시적으로 안내된 AI 도구를 모았어요.`, `웹과 개발 작업 도구를 모았어요.`, `생활에 필요한 계산 도구를 모았어요.`. `domainFilterDefinitions` prepends `{ id: "all", label: "전체·추천", description: "최근 사용한 도구와 추천 도구를 모았어요." }`. Export `purposeDefinitions` in this order: `optimize`/`압축·최적화`, `convert`/`변환`, `edit`/`편집`, `create`/`만들기`, `extract`/`추출·분석`, `protect`/`보안·표시`. `defineToolCatalog()` must clone and freeze the outer array and throw for duplicate IDs/routes, unknown taxonomy, empty or non-NFC/trimmed duplicate aliases, non-finite ranks, invalid launcher integers/ranges, empty contract IDs, non-positive integer versions, executable planned fields, or anything other than exactly three distinct available non-self related IDs. Every deterministic sort ends with tool ID.

Use this validator structure so malformed `as never` fixtures fail at module construction rather than leaking into UI code:

~~~ts
const domainIds = new Set(domainDefinitions.map(({ id }) => id));
const purposeIds = new Set(purposeDefinitions.map(({ id }) => id));
const experienceIds = new Set<Experience>(["quick", "file", "workspace"]);
const executionIds = new Set<Execution>(["browser", "server"]);
const concreteFileKinds = new Set([
  "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif",
  "application/pdf", "text/plain", "application/json", "application/zip",
]);

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid tool catalog: ${message}`);
}

function isKnownFileKind(value: unknown): value is FileKind {
  return typeof value === "string" && (
    concreteFileKinds.has(value) || value.startsWith("video/") || value.startsWith("audio/")
  );
}

function isKnownResultKind(value: unknown): value is ResultKind {
  return value === "value/text" || value === "value/number" || isKnownFileKind(value);
}

export function defineToolCatalog<const T extends readonly ToolCatalogEntry[]>(entries: T): T {
  const ids = new Set<string>();
  const routes = new Set<string>();
  const cloned = entries.map((entry) => {
    invariant(typeof entry.id === "string" && /^[^.]+\.[^.]+/.test(entry.id), "tool ID");
    invariant(!ids.has(entry.id), `duplicate ID ${entry.id}`);
    ids.add(entry.id);
    invariant(entry.name.trim() !== "" && entry.shortDescription.trim() !== "", `${entry.id} copy`);
    invariant(entry.availability === "available" || entry.availability === "planned", `${entry.id} availability`);
    invariant(entry.domains.length > 0 && entry.domains.every((id) => domainIds.has(id)), `${entry.id} domain`);
    invariant(new Set(entry.domains).size === entry.domains.length, `${entry.id} duplicate domain`);
    invariant(entry.purposes.length > 0 && entry.purposes.every((id) => purposeIds.has(id)), `${entry.id} purpose`);
    invariant(new Set(entry.purposes).size === entry.purposes.length, `${entry.id} duplicate purpose`);
    invariant(Number.isFinite(entry.rank), `${entry.id} rank`);
    const normalizedAliases = entry.searchAliases.map((alias) => alias.normalize("NFC").trim());
    invariant(normalizedAliases.every((alias, index) => alias !== "" && alias === entry.searchAliases[index]), `${entry.id} alias normalization`);
    invariant(new Set(normalizedAliases.map((alias) => alias.toLocaleLowerCase("ko-KR"))).size === normalizedAliases.length, `${entry.id} duplicate alias`);

    if (entry.availability === "planned") {
      for (const key of ["route", "launcherInput", "outputKinds", "experience", "execution", "contract", "featured", "newUntil", "relatedToolIds"] as const) {
        invariant(!(key in entry), `${entry.id} planned field ${key}`);
      }
      return Object.freeze({ ...entry });
    }

    invariant(entry.route.startsWith("/") && entry.route.length > 1, `${entry.id} route`);
    invariant(!routes.has(entry.route), `duplicate route ${entry.route}`);
    routes.add(entry.route);
    invariant(experienceIds.has(entry.experience), `${entry.id} experience`);
    invariant(executionIds.has(entry.execution), `${entry.id} execution`);
    invariant(typeof entry.featured === "boolean", `${entry.id} featured`);
    invariant(entry.newUntil === undefined || /^\d{4}-\d{2}-\d{2}$/.test(entry.newUntil), `${entry.id} newUntil`);
    invariant(entry.contract.id.trim() !== "" && Number.isInteger(entry.contract.version) && entry.contract.version > 0, `${entry.id} contract`);
    invariant(entry.outputKinds.length > 0 && entry.outputKinds.every(isKnownResultKind), `${entry.id} output kind`);
    invariant(new Set(entry.outputKinds).size === entry.outputKinds.length, `${entry.id} duplicate output kind`);
    if (entry.launcherInput !== null) {
      const input = entry.launcherInput;
      invariant(input.role === "source" && input.kinds.length > 0 && input.kinds.every(isKnownFileKind), `${entry.id} launcher kind`);
      invariant(new Set(input.kinds).size === input.kinds.length, `${entry.id} duplicate launcher kind`);
      invariant(Number.isInteger(input.minFiles) && Number.isInteger(input.maxFiles), `${entry.id} launcher integers`);
      invariant(input.minFiles > 0 && input.minFiles <= input.maxFiles, `${entry.id} launcher range`);
      invariant(typeof input.allowMixedKinds === "boolean", `${entry.id} mixed-kind flag`);
    }
    invariant(entry.relatedToolIds.length === 3 && new Set(entry.relatedToolIds).size === 3, `${entry.id} related count`);
    return Object.freeze({ ...entry });
  });

  const byId = new Map(cloned.map((entry) => [entry.id, entry]));
  for (const entry of cloned) {
    if (entry.availability !== "available") continue;
    for (const relatedId of entry.relatedToolIds) {
      invariant(relatedId !== entry.id, `${entry.id} self-related`);
      invariant(byId.get(relatedId)?.availability === "available", `${entry.id} related ${relatedId}`);
    }
  }
  return Object.freeze(cloned) as unknown as T;
}
~~~

- [ ] **Step 4: Seed the approved 11 available records**

Copy each current `title` and `description` from `apps/web/src/lib/site.ts` exactly. Use this executable mapping:

| ID | Route | Domains | Purposes | Input count/mixed | Experience | Contract | Featured/rank |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `image.compress` | `/image/compress` | image | optimize | 1–100/yes | file | `image.pipeline@1` | yes/10 |
| `pdf.merge` | `/pdf/merge` | document | create, edit | 2–20/no | file | `pdf.merge@1` | yes/20 |
| `image.resize` | `/image/resize` | image | edit, optimize | 1–100/yes | file | `image.pipeline@1` | yes/30 |
| `pdf.compress-scanned` | `/pdf/compress` | document | optimize | 1/no | file | `pdf.compress-scanned@1` | yes/40 |
| `image.convert` | `/image/convert` | image, data | convert | 1–100/yes | file | `image.pipeline@1` | yes/50 |
| `pdf.split` | `/pdf/split` | document | extract, edit | 1/no | file | `pdf.split@1` | no/60 |
| `image.watermark` | `/image/watermark` | image | edit, protect | 1–100/yes | file | `image.watermark@1` | no/70 |
| `pdf.organize` | `/pdf/organize` | document | edit | 1/no | workspace | `pdf.organize@1` | no/80 |
| `pdf.to-image` | `/pdf/to-image` | document, image, data | convert, extract | 1/no | file | `pdf.to-images@1` | no/90 |
| `pdf.image-to-pdf` | `/pdf/image-to-pdf` | image, document, data | convert, create | 1–100/yes | file | `pdf.images-to-pdf@1` | no/100 |
| `pdf.watermark` | `/pdf/watermark` | document | edit, protect | 1/no | file | `pdf.watermark@1` | no/110 |

Image launcher kinds are JPEG, PNG, WebP, HEIC, and HEIF except `pdf.image-to-pdf`, which accepts JPEG and PNG only. PDF launcher kinds are PDF. Copy the exact three related IDs and normalized aliases from the approved design; assert their display order in the test. All current entries use `execution: "browser"`.

Use these output kinds and related IDs exactly:

| ID | Output kinds | Related IDs in display order |
| --- | --- | --- |
| `image.compress` | JPEG, PNG, WebP | `image.resize`, `image.convert`, `image.watermark` |
| `image.resize` | JPEG, PNG, WebP | `image.compress`, `image.convert`, `image.watermark` |
| `image.convert` | JPEG, PNG, WebP | `image.compress`, `image.resize`, `pdf.image-to-pdf` |
| `image.watermark` | JPEG, PNG, WebP | `image.compress`, `image.resize`, `pdf.watermark` |
| `pdf.merge` | PDF | `pdf.split`, `pdf.organize`, `pdf.image-to-pdf` |
| `pdf.split` | PDF, ZIP | `pdf.merge`, `pdf.organize`, `pdf.to-image` |
| `pdf.organize` | PDF | `pdf.merge`, `pdf.split`, `pdf.watermark` |
| `pdf.watermark` | PDF | `pdf.organize`, `pdf.merge`, `image.watermark` |
| `pdf.to-image` | JPEG, PNG, ZIP | `pdf.image-to-pdf`, `pdf.split`, `image.convert` |
| `pdf.image-to-pdf` | PDF | `pdf.to-image`, `pdf.merge`, `image.convert` |
| `pdf.compress-scanned` | PDF | `pdf.merge`, `pdf.split`, `pdf.to-image` |

Author these alias arrays exactly so search tests are stable:

~~~ts
const aliases = {
  "image.compress": ["사진 압축", "이미지 최적화", "용량 줄이기", "jpg 압축", "png 압축"],
  "image.resize": ["사진 크기", "리사이즈", "해상도 변경", "정사각형 자르기"],
  "image.convert": ["이미지 변환", "jpg 변환", "png 변환", "webp 변환", "heic 변환"],
  "image.watermark": ["사진 워터마크", "로고 넣기", "문구 넣기"],
  "pdf.merge": ["pdf 병합", "pdf 합치기", "문서 합치기"],
  "pdf.split": ["pdf 나누기", "페이지 추출", "pdf 분할"],
  "pdf.organize": ["페이지 순서", "pdf 회전", "페이지 삭제"],
  "pdf.watermark": ["문서 워터마크", "pdf 문구", "대외비"],
  "pdf.to-image": ["pdf jpg", "pdf png", "pdf 이미지 변환"],
  "pdf.image-to-pdf": ["jpg pdf", "png pdf", "사진 pdf"],
  "pdf.compress-scanned": ["pdf 압축", "스캔 pdf", "pdf 용량 줄이기"],
} as const;
~~~

After the literal entries, derive every public collection and lookup rather than authoring a second inventory:

~~~ts
export const availableToolEntries = Object.freeze(
  toolCatalog.filter((tool): tool is Extract<(typeof toolCatalog)[number], { availability: "available" }> =>
    tool.availability === "available"),
);
export const plannedToolEntries = Object.freeze(
  toolCatalog.filter((tool): tool is Extract<(typeof toolCatalog)[number], { availability: "planned" }> =>
    tool.availability === "planned"),
);

export function findToolById(id: string): ToolCatalogEntry | undefined {
  return toolCatalog.find((tool) => tool.id === id);
}

export function findAvailableToolById(id: string): AvailableToolEntry | undefined {
  const tool = findToolById(id);
  return tool?.availability === "available" ? tool : undefined;
}

export function getAvailableToolById(id: AvailableToolId): AvailableToolEntry {
  const tool = findAvailableToolById(id);
  if (tool === undefined) throw new Error(`Missing available tool: ${id}`);
  return tool;
}

export function getRelatedAvailableTools(
  id: AvailableToolId,
): readonly [AvailableToolEntry, AvailableToolEntry, AvailableToolEntry] {
  const related = getAvailableToolById(id).relatedToolIds.map((relatedId) => {
    const tool = findAvailableToolById(relatedId);
    if (tool === undefined) throw new Error(`Missing related tool: ${relatedId}`);
    return tool;
  });
  return related as [AvailableToolEntry, AvailableToolEntry, AvailableToolEntry];
}
~~~

- [ ] **Step 5: Add one non-clickable roadmap record**

Add only the companion-approved video card:

~~~ts
{
  id: "media.video-compress",
  name: "동영상 용량 줄이기",
  shortDescription: "브라우저에서 동영상 용량을 줄이는 기능을 준비하고 있어요.",
  domains: ["media"],
  purposes: ["optimize"],
  searchAliases: ["영상 압축", "동영상 압축", "mp4 압축"],
  rank: 10,
  availability: "planned",
}
~~~

Test that it has no `route`, `contract`, `execution`, `experience`, `launcherInput`, or `relatedToolIds`. Do not invent other planned products in this phase.

- [ ] **Step 6: Compare catalog contract literals to runtime constants in tests only**

Import the existing constants from `@hereisit/tool-contracts` only in `tool-catalog.test.ts` and assert every available catalog contract ID/version matches its current processor constant. Keep `tool-catalog.ts` free of that runtime dependency.

~~~ts
const expectedContracts = {
  "image.compress": [IMAGE_TOOL_ID, IMAGE_TOOL_VERSION],
  "image.resize": [IMAGE_TOOL_ID, IMAGE_TOOL_VERSION],
  "image.convert": [IMAGE_TOOL_ID, IMAGE_TOOL_VERSION],
  "image.watermark": [IMAGE_WATERMARK_TOOL_ID, IMAGE_WATERMARK_TOOL_VERSION],
  "pdf.merge": [PDF_MERGE_TOOL_ID, PDF_TOOL_VERSION],
  "pdf.split": [PDF_SPLIT_TOOL_ID, PDF_TOOL_VERSION],
  "pdf.organize": [PDF_ORGANIZE_TOOL_ID, PDF_TOOL_VERSION],
  "pdf.watermark": [PDF_WATERMARK_TOOL_ID, PDF_TOOL_VERSION],
  "pdf.to-image": [PDF_TO_IMAGES_TOOL_ID, PDF_TO_IMAGES_TOOL_VERSION],
  "pdf.image-to-pdf": [PDF_IMAGES_TO_PDF_TOOL_ID, PDF_TOOL_VERSION],
  "pdf.compress-scanned": [PDF_COMPRESS_SCANNED_TOOL_ID, PDF_COMPRESS_SCANNED_TOOL_VERSION],
} as const satisfies Record<AvailableToolId, readonly [string, number]>;

for (const tool of availableToolEntries) {
  const [id, version] = expectedContracts[tool.id];
  expect(tool.contract).toEqual({ id, version });
}
~~~

- [ ] **Step 7: Publish the isolated catalog subpath**

Retain the existing root export and add:

~~~json
{
  "exports": {
    ".": "./src/index.ts",
    "./catalog": "./src/tool-catalog.ts"
  }
}
~~~

- [ ] **Step 8: Verify GREEN and commit**

Run: `pnpm test packages/tool-registry/src/tool-catalog.test.ts --run && pnpm --filter @hereisit/tool-registry typecheck`

Expected: PASS with 11 available entries, one route-less planned entry, stable relations, and rejected invalid fixtures.

Commit:

~~~bash
git add packages/tool-registry/package.json packages/tool-registry/src/tool-catalog.ts packages/tool-registry/src/tool-catalog.test.ts
git commit -m "feat: add unified tool catalog"
~~~

### Task 2: Add deterministic catalog discovery rules

**Files:**
- Create: `packages/tool-registry/src/tool-discovery.ts`
- Create: `packages/tool-registry/src/tool-discovery.test.ts`
- Modify: `packages/tool-registry/package.json`

**Interfaces:**
- Consumes: `AvailableToolEntry`, `PlannedToolEntry`, taxonomy IDs, file kinds, and manifest selectors from `./tool-catalog.ts`.
- Produces: separate available/planned selectors, stable URL state, home ordering, and pure file-capability recommendations for Plan 2.

~~~ts
export interface CatalogFilters {
  query: string;
  domain: DiscoveryDomainId;
  purpose: PurposeFilter;
}
export interface CatalogUrlState extends CatalogFilters { includePlanned: boolean }
export function normalizeCatalogSearch(value: string): string;
export function searchAvailableTools(query: string): readonly AvailableToolEntry[];
export function selectAvailableTools(filters: CatalogFilters): readonly AvailableToolEntry[];
export function selectPlannedTools(state: CatalogUrlState): readonly PlannedToolEntry[];
export function parseCatalogUrlState(params: Pick<URLSearchParams, "get">): CatalogUrlState;
export function serializeCatalogUrlState(state: CatalogUrlState): string;
export function selectHomeTools(input: HomeToolSelection): readonly AvailableToolEntry[];
export function recommendAvailableTools(items: readonly DetectedKindItem[]): readonly ToolRecommendation[];
export function groupDetectedKinds(items: readonly DetectedKindItem[]): readonly DetectedKindGroup[];
~~~

- [ ] **Step 1: Write failing search, filter, and URL tests**

Cover NFC normalization, collapsed whitespace, Latin lowercasing, duplicate suppression, invalid query-state recovery, and this exact tier order: exact name, name prefix, exact alias, alias prefix, name/alias substring, purpose label/ID, domain label/ID, rank, ID.

~~~ts
expect(searchAvailableTools("PDF 합치기")[0]?.id).toBe("pdf.merge");
expect(searchAvailableTools("병합")[0]?.id).toBe("pdf.merge");
expect(selectAvailableTools({ query: "변환", domain: "image", purpose: "convert" })
  .map((tool) => tool.id))
  .toEqual(["image.convert", "pdf.to-image", "pdf.image-to-pdf"]);
expect(parseCatalogUrlState(
  new URLSearchParams("q=%20PNG%20&domain=bogus&purpose=convert&planned=1"),
)).toEqual({ query: "PNG", domain: "all", purpose: "convert", includePlanned: true });
~~~

Prove planned results come only from `selectPlannedTools()` when enabled; never return a mixed available/planned array from one selector. Serialization emits `q`, `domain`, `purpose`, `planned=1` in that order and omits defaults.

- [ ] **Step 2: Write failing home and capability-match tests**

~~~ts
expect(selectHomeTools({ domain: "all", recentToolIds: ["pdf.merge", "pdf.merge"], limit: 12 })[0]?.id)
  .toBe("pdf.merge");
expect(recommendAvailableTools([{ index: 0, kind: "application/pdf" }])
  .find(({ tool }) => tool.id === "pdf.merge"))
  .toMatchObject({ readiness: "needs-more", missingFiles: 1 });
expect(recommendAvailableTools([
  { index: 0, kind: "image/jpeg" },
  { index: 1, kind: "image/png" },
]).find(({ tool }) => tool.id === "image.convert"))
  .toMatchObject({ readiness: "ready" });
~~~

Also cover `too-many`, incompatible kinds, `allowMixedKinds: false`, exact detected-kind preference, planned exclusion, stable rank/ID ties, grouped fallback indexes, a maximum of four recent tools within the 12-card all view, and available-only domain panels.

- [ ] **Step 3: Run tests and confirm RED**

Run: `pnpm test packages/tool-registry/src/tool-discovery.test.ts --run`

Expected: FAIL because `./tool-discovery` does not exist.

- [ ] **Step 4: Implement pure selectors and recommendation shapes**

~~~ts
export interface HomeToolSelection {
  domain: DiscoveryDomainId;
  recentToolIds: readonly string[];
  limit?: number;
}
export interface DetectedKindItem { index: number; kind: FileKind }
export interface DetectedKindGroup { kind: FileKind; indexes: readonly number[] }
export type RecommendationReadiness = "ready" | "needs-more" | "too-many";
export interface ToolRecommendation {
  tool: AvailableToolEntry;
  readiness: RecommendationReadiness;
  missingFiles: number;
  maximumFiles: number;
  matchedIndexes: readonly number[];
}
~~~

All helpers use catalog metadata only. Query/domain/purpose combine with AND semantics. Recommendations consider the complete selection first, then deterministic kind groups; they use only available tools with non-null launcher input and never inspect a filename. Sort ready before needs-more before too-many, then exact complete-selection match, rank, and ID.

Implement the selectors with this control flow; `searchScore()` returns `Number.POSITIVE_INFINITY` for a non-match and each public selector returns a newly frozen array:

~~~ts
function compareRank(left: ToolCatalogEntry, right: ToolCatalogEntry): number {
  return left.rank - right.rank || left.id.localeCompare(right.id);
}

function searchScore(tool: ToolCatalogEntry, normalizedQuery: string): number {
  if (normalizedQuery === "") return 0;
  const name = normalizeCatalogSearch(tool.name);
  const aliases = tool.searchAliases.map(normalizeCatalogSearch);
  if (name === normalizedQuery) return 0;
  if (name.startsWith(normalizedQuery)) return 1;
  if (aliases.includes(normalizedQuery)) return 2;
  if (aliases.some((alias) => alias.startsWith(normalizedQuery))) return 3;
  if (name.includes(normalizedQuery) || aliases.some((alias) => alias.includes(normalizedQuery))) return 4;
  if (tool.purposes.some((id) => {
    const label = purposeDefinitions.find((item) => item.id === id)?.label ?? "";
    return normalizeCatalogSearch(`${id} ${label}`).includes(normalizedQuery);
  })) return 5;
  if (tool.domains.some((id) => {
    const label = domainDefinitions.find((item) => item.id === id)?.label ?? "";
    return normalizeCatalogSearch(`${id} ${label}`).includes(normalizedQuery);
  })) return 6;
  return Number.POSITIVE_INFINITY;
}

export function normalizeCatalogSearch(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("ko-KR");
}

export function searchAvailableTools(query: string): readonly AvailableToolEntry[] {
  const normalizedQuery = normalizeCatalogSearch(query);
  return Object.freeze(availableToolEntries
    .map((tool) => ({ tool, score: searchScore(tool, normalizedQuery) }))
    .filter(({ score }) => Number.isFinite(score))
    .sort((left, right) => left.score - right.score || compareRank(left.tool, right.tool))
    .map(({ tool }) => tool));
}

export function selectAvailableTools(filters: CatalogFilters): readonly AvailableToolEntry[] {
  const eligible = searchAvailableTools(filters.query).filter((tool) =>
    (filters.domain === "all" || tool.domains.includes(filters.domain)) &&
    (filters.purpose === "all" || tool.purposes.includes(filters.purpose)),
  );
  return Object.freeze(eligible);
}

export function selectPlannedTools(state: CatalogUrlState): readonly PlannedToolEntry[] {
  if (!state.includePlanned) return Object.freeze([]);
  const normalizedQuery = normalizeCatalogSearch(state.query);
  return Object.freeze(plannedToolEntries
    .filter((tool) => state.domain === "all" || tool.domains.includes(state.domain))
    .filter((tool) => state.purpose === "all" || tool.purposes.includes(state.purpose))
    .map((tool) => ({ tool, score: searchScore(tool, normalizedQuery) }))
    .filter(({ score }) => Number.isFinite(score))
    .sort((left, right) => left.score - right.score || compareRank(left.tool, right.tool))
    .map(({ tool }) => tool));
}
~~~

Parse and select with these remaining bodies:

~~~ts
function cleanQuery(value: string | null): string {
  return (value ?? "").normalize("NFC").trim().replace(/\s+/g, " ");
}

export function parseCatalogUrlState(params: Pick<URLSearchParams, "get">): CatalogUrlState {
  const domain = params.get("domain");
  const purpose = params.get("purpose");
  return {
    query: cleanQuery(params.get("q")),
    domain: domainFilterDefinitions.some((item) => item.id === domain)
      ? (domain as DiscoveryDomainId)
      : "all",
    purpose: purposeDefinitions.some((item) => item.id === purpose)
      ? (purpose as PurposeId)
      : "all",
    includePlanned: params.get("planned") === "1",
  };
}

export function serializeCatalogUrlState(state: CatalogUrlState): string {
  const params = new URLSearchParams();
  const query = cleanQuery(state.query);
  if (query !== "") params.set("q", query);
  if (state.domain !== "all") params.set("domain", state.domain);
  if (state.purpose !== "all") params.set("purpose", state.purpose);
  if (state.includePlanned) params.set("planned", "1");
  return params.toString();
}

export function selectHomeTools(input: HomeToolSelection): readonly AvailableToolEntry[] {
  const limit = Math.max(0, Math.min(12, input.limit ?? 12));
  const ranked = [...availableToolEntries].sort(compareRank);
  if (input.domain !== "all") {
    return Object.freeze(ranked.filter((tool) => tool.domains.includes(input.domain)).slice(0, limit));
  }
  const recent = [...new Set(input.recentToolIds)]
    .map(findAvailableToolById)
    .filter((tool): tool is AvailableToolEntry => tool !== undefined)
    .slice(0, 4);
  const ordered = [...recent, ...ranked.filter((tool) => tool.featured), ...ranked];
  return Object.freeze([...new Map(ordered.map((tool) => [tool.id, tool])).values()].slice(0, limit));
}

export function recommendAvailableTools(
  items: readonly DetectedKindItem[],
): readonly ToolRecommendation[] {
  if (items.length === 0) return Object.freeze([]);
  const distinctKinds = new Set(items.map((item) => item.kind));
  const recommendations = availableToolEntries.flatMap((tool) => {
    const input = tool.launcherInput;
    if (input === null) return [];
    if (items.some((item) => !input.kinds.includes(item.kind))) return [];
    if (!input.allowMixedKinds && distinctKinds.size > 1) return [];
    const readiness: RecommendationReadiness =
      items.length < input.minFiles ? "needs-more" :
        items.length > input.maxFiles ? "too-many" : "ready";
    return [{
      tool,
      readiness,
      missingFiles: Math.max(0, input.minFiles - items.length),
      maximumFiles: input.maxFiles,
      matchedIndexes: items.map((item) => item.index),
      specificity: input.kinds.length,
    }];
  });
  const readinessOrder = { ready: 0, "needs-more": 1, "too-many": 2 } as const;
  return Object.freeze(recommendations.sort((left, right) =>
    readinessOrder[left.readiness] - readinessOrder[right.readiness] ||
    left.specificity - right.specificity || compareRank(left.tool, right.tool),
  ).map(({ specificity: _specificity, ...recommendation }) => recommendation));
}

export function groupDetectedKinds(items: readonly DetectedKindItem[]): readonly DetectedKindGroup[] {
  const groups = new Map<FileKind, number[]>();
  for (const item of items) groups.set(item.kind, [...(groups.get(item.kind) ?? []), item.index]);
  return Object.freeze([...groups].map(([kind, indexes]) => ({ kind, indexes: Object.freeze(indexes) })));
}
~~~

`recommendAvailableTools()` evaluates exactly the items passed to it; Plan 2 calls it first for the whole selection and then for each group only when the complete selection has no compatible tool.

- [ ] **Step 5: Publish the discovery subpath**

Add `"./discovery": "./src/tool-discovery.ts"` beside the root and catalog exports in `packages/tool-registry/package.json`.

- [ ] **Step 6: Verify GREEN and commit**

Run: `pnpm test packages/tool-registry/src/tool-discovery.test.ts --run && pnpm --filter @hereisit/tool-registry typecheck`

Expected: PASS with deterministic available/planned separation and no browser or processor import.

Commit:

~~~bash
git add packages/tool-registry/package.json packages/tool-registry/src/tool-discovery.ts packages/tool-registry/src/tool-discovery.test.ts
git commit -m "feat: add catalog discovery rules"
~~~

### Task 3: Detect broad file kinds from bounded prefixes

**Files:**
- Create: `packages/tool-registry/src/file-kind.ts`
- Create: `packages/tool-registry/src/file-kind.test.ts`
- Modify: `packages/tool-registry/package.json`

**Interfaces:**
- Consumes: `FileKind` as a type-only relative import from `./tool-catalog.ts`.
- Produces: a versioned bounded structural detector and human-readable general-kind labels for the home launcher.

~~~ts
export const FILE_KIND_DETECTOR_VERSION = 1 as const;
export const MAX_FILE_KIND_PREFIX_BYTES = 64 * 1024;
export interface FileKindHint { mime?: string; extension?: string }
export function detectFileKindPrefix(
  prefix: Uint8Array,
  hint?: FileKindHint,
): FileKind | undefined;
export function fileKindLabel(kind: FileKind): string;
~~~

- [ ] **Step 1: Write failing structural and hostile-hint tests**

~~~ts
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
expect(detectFileKindPrefix(png, { mime: "application/pdf", extension: ".pdf" }))
  .toBe("image/png");
expect(detectFileKindPrefix(new TextEncoder().encode("%PDF-1.7\n"))).toBe("application/pdf");
expect(detectFileKindPrefix(new TextEncoder().encode("not a pdf"), { mime: "application/pdf" }))
  .toBeUndefined();
expect(detectFileKindPrefix(new Uint8Array(65_537))).toBeUndefined();
expect(fileKindLabel("application/pdf")).toBe("PDF");
~~~

Add JPG `ff d8 ff`, PNG, `RIFF....WEBP`, PDF header within the first 1,024 bytes, supported HEIC `ftyp` major/compatible brands, HEIF MIME normalization, truncation, AVIF-only rejection, generic ZIP rejection, and empty input cases.

- [ ] **Step 2: Run tests and confirm RED**

Run: `pnpm test packages/tool-registry/src/file-kind.test.ts --run`

Expected: FAIL because `./file-kind` does not exist.

- [ ] **Step 3: Implement bounded signature detection**

Use byte equality rather than decoding source content. MIME and extension hints are accepted for future check ordering but cannot produce a result:

~~~ts
import type { FileKind } from "./tool-catalog";

export const FILE_KIND_DETECTOR_VERSION = 1 as const;
export const MAX_FILE_KIND_PREFIX_BYTES = 64 * 1024;
const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs"]);

function hasBytes(value: Uint8Array, offset: number, expected: readonly number[]): boolean {
  return expected.every((byte, index) => value[offset + index] === byte);
}

function ascii(value: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...value.subarray(offset, offset + length));
}

function hasPdfHeader(value: Uint8Array): boolean {
  const limit = Math.min(1024, value.byteLength - 4);
  for (let offset = 0; offset <= limit; offset += 1) {
    if (hasBytes(value, offset, [0x25, 0x50, 0x44, 0x46, 0x2d])) return true;
  }
  return false;
}

function hasHeicBrand(value: Uint8Array): boolean {
  if (value.byteLength < 12 || ascii(value, 4, 4) !== "ftyp") return false;
  const declaredSize = (
    value[0]! * 0x1000000 + value[1]! * 0x10000 + value[2]! * 0x100 + value[3]!
  );
  const boxEnd = declaredSize === 0 ? value.byteLength : Math.min(declaredSize, value.byteLength);
  if (boxEnd < 12) return false;
  if (HEIC_BRANDS.has(ascii(value, 8, 4))) return true;
  for (let offset = 16; offset + 4 <= boxEnd; offset += 4) {
    if (HEIC_BRANDS.has(ascii(value, offset, 4))) return true;
  }
  return false;
}

export function detectFileKindPrefix(
  prefix: Uint8Array,
  _hint: FileKindHint = {},
): FileKind | undefined {
  if (prefix.byteLength === 0 || prefix.byteLength > MAX_FILE_KIND_PREFIX_BYTES) return undefined;
  if (hasBytes(prefix, 0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (hasBytes(prefix, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (prefix.byteLength >= 12 && ascii(prefix, 0, 4) === "RIFF" && ascii(prefix, 8, 4) === "WEBP") {
    return "image/webp";
  }
  if (hasPdfHeader(prefix)) return "application/pdf";
  if (hasHeicBrand(prefix)) return "image/heic";
  return undefined;
}

export function fileKindLabel(kind: FileKind): string {
  const labels: Partial<Record<FileKind, string>> = {
    "image/jpeg": "JPG 이미지", "image/png": "PNG 이미지", "image/webp": "WebP 이미지",
    "image/heic": "HEIC 이미지", "image/heif": "HEIF 이미지", "application/pdf": "PDF",
    "text/plain": "텍스트", "application/json": "JSON", "application/zip": "ZIP",
  };
  return labels[kind] ?? (kind.startsWith("video/") ? "동영상" : "오디오");
}
~~~

Do not decode pixels, inspect dimensions, parse a PDF body/EOF, create an object URL, or reuse existing full-file validators. AVIF-only and generic `mif1` evidence remain unknown. A structurally supported HEIC file with a misleading HEIF MIME hint normalizes to `image/heic`.

- [ ] **Step 4: Publish the file-kind subpath**

Add `"./file-kind": "./src/file-kind.ts"` beside the existing root, catalog, and discovery exports in `packages/tool-registry/package.json`.

- [ ] **Step 5: Verify GREEN against existing validators and commit**

Run: `pnpm test packages/tool-registry/src/file-kind.test.ts packages/image-tool/src/file-format.test.ts packages/pdf-tool/src/file-format.test.ts --run && pnpm --filter @hereisit/tool-registry typecheck`

Expected: PASS; existing complete image/PDF validation remains unchanged.

Commit:

~~~bash
git add packages/tool-registry/package.json packages/tool-registry/src/file-kind.ts packages/tool-registry/src/file-kind.test.ts
git commit -m "feat: detect file kinds from bounded prefixes"
~~~

### Task 4: Separate site identity, SEO identity, and implementation configuration

**Files:**
- Create: `apps/web/src/lib/site-identity.ts`
- Create: `apps/web/src/lib/tool-implementations.ts`
- Modify: `apps/web/src/lib/site.ts`
- Modify: `apps/web/src/lib/site.test.ts`
- Modify: `apps/web/src/lib/metadata.ts`
- Modify: `apps/web/src/app/layout.tsx`
- Modify: `apps/web/src/app/robots.ts`
- Modify: `apps/web/src/app/sitemap.ts`
- Modify: `apps/web/src/app/image/compress/page.tsx`
- Modify: `apps/web/src/app/image/resize/page.tsx`
- Modify: `apps/web/src/app/image/convert/page.tsx`
- Modify: `apps/web/src/app/image/watermark/page.tsx`
- Modify: `apps/web/src/app/pdf/merge/page.tsx`
- Modify: `apps/web/src/app/pdf/split/page.tsx`
- Modify: `apps/web/src/app/pdf/organize/page.tsx`
- Modify: `apps/web/src/app/pdf/watermark/page.tsx`
- Modify: `apps/web/src/app/pdf/to-image/page.tsx`
- Modify: `apps/web/src/app/pdf/image-to-pdf/page.tsx`
- Modify: `apps/web/src/app/pdf/compress/page.tsx`

**Interfaces:**
- Consumes: catalog identity and exact `AvailableToolId` from `@hereisit/tool-registry/catalog`.
- Produces: processor-free site identity, catalog-only metadata, keyed implementation descriptors, and temporary legacy adapters for Plan 2/3.

~~~ts
export type ToolBundleProfile =
  | "image" | "image-watermark" | "pdf-editing" | "pdf-to-images" | "pdf-compress-scanned";
export interface SourceFileLimits {
  minFiles: number;
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  constrainedMaxTotalBytes?: number;
}
export interface ToolNotice { tone: "support" | "warning"; text: string }
export interface ToolStep { title: string; description: string }
export type ImageToolIntent = "compress" | "resize" | "convert" | "watermark";
export type PdfToolIntent =
  | "merge" | "split" | "organize" | "watermark" | "to-image" | "image-to-pdf" | "compress";
export type PdfEditingIntent = Exclude<PdfToolIntent, "compress" | "to-image">;
export type PdfToolIntentClass = "editing" | "pdf-to-images" | "pdf-compress-scanned";
export function isPdfEditingIntent(intent: PdfToolIntent): intent is PdfEditingIntent {
  return intent !== "compress" && intent !== "to-image";
}
export interface ToolImplementationConfig {
  family: "image" | "pdf";
  bundleProfile: ToolBundleProfile;
  intent: string;
  intentClass?: PdfToolIntentClass;
  sourceFileLimits: SourceFileLimits;
  eyebrow: string;
  defaultSummary: string;
  notices: readonly ToolNotice[];
  legacyNavLabel: string;
  legacySteps: readonly [ToolStep, ToolStep, ToolStep];
}
export type ToolImplementationConfigMap = Readonly<
  Record<AvailableToolId, ToolImplementationConfig>
>;
export function getToolImplementation<const Id extends AvailableToolId>(
  id: Id,
): (typeof toolImplementationConfig)[Id];
~~~

The object key is the tool ID; values must not duplicate an `id` field. Export `toolImplementationConfig` with the inferred return type of `defineToolImplementationConfig()` and a `satisfies Record<AvailableToolId, ToolImplementationConfig>` constraint—do not add a broad `ToolImplementationConfigMap` annotation to the constant, because `getToolImplementation()` must preserve each keyed literal intent/profile.

- [ ] **Step 1: Write failing ownership tests**

Extend `site.test.ts` to assert:

~~~ts
expect(Object.keys(toolImplementationConfig).sort()).toEqual(
  availableToolEntries.map((tool) => tool.id).sort(),
);
for (const tool of availableToolEntries) {
  const limits = getToolImplementation(tool.id).sourceFileLimits;
  expect(tool.launcherInput?.minFiles ?? 0).toBe(limits.minFiles);
  expect(tool.launcherInput?.maxFiles ?? 0).toBe(limits.maxFiles);
}
expect(imageTools.compress.path).toBe(getAvailableToolById("image.compress").route);
expect(pdfTools.merge.description).toBe(getAvailableToolById("pdf.merge").shortDescription);
~~~

Add a type-level `satisfies Record<AvailableToolId, ToolImplementationConfig>` assertion so missing and extra keys fail typecheck.

- [ ] **Step 2: Run the library test and confirm RED**

Run: `pnpm test apps/web/src/lib/site.test.ts --run`

Expected: FAIL because site identity and implementation configuration have not been separated.

- [ ] **Step 3: Move site identity out of `site.ts`**

Create `site-identity.ts` with `SITE_NAME`, `SITE_URL`, and this approved home copy:

~~~ts
export const HOME_TITLE = "HereIsIt — 필요한 도구, 여기 있어요";
export const HOME_DESCRIPTION =
  "이미지와 PDF 작업을 시작으로 필요한 도구를 한곳에서 찾으세요. 파일은 가능한 한 업로드 없이 내 기기에서 빠르게 처리합니다.";
export const HOME_OPEN_GRAPH_DESCRIPTION =
  "필요한 도구를 빠르게 찾고, 지원되는 파일은 내 기기에서 안전하게 처리하세요.";
~~~

Make `layout.tsx` and `robots.ts` import only from `site-identity.ts`. `metadata.ts` imports site identity plus catalog types only. `sitemap.ts` imports site identity plus `availableToolEntries`. This prevents site-wide metadata from reaching implementation configuration through `site.ts`.

- [ ] **Step 4: Move implementation-only data and retain temporary adapters**

Populate all 11 keyed configs with the current exact intent/class, long summary, warnings/HEIC notes, navigation labels, and three legacy steps. Convert HEIC notes and warnings into ordered `notices` values. Use these source limits:

- all image workbenches: 1–100, 50 MiB/file, 250 MiB total;
- PDF merge: 2–20, 50 MiB/file, 100 MiB total, 60 MiB constrained total;
- PDF split/organize/watermark: 1, the same per-file/total/constrained bounds;
- image-to-PDF: 1–100, the same PDF workbench byte bounds;
- PDF-to-image and scanned compression: 1, 50 MiB/file and 50 MiB total.

Assign explicit bundle profiles: image pipeline routes `image`, image watermark `image-watermark`, merge/split/organize/watermark/image-to-PDF `pdf-editing`, PDF-to-image `pdf-to-images`, and scanned compression `pdf-compress-scanned`.

Use a keyed definition helper and lookup that cannot silently fall back:

~~~ts
function defineToolImplementationConfig<
  const T extends Record<AvailableToolId, ToolImplementationConfig>,
>(entries: T): Readonly<T> {
  return Object.freeze(entries);
}

export function getToolImplementation<const Id extends AvailableToolId>(
  id: Id,
): (typeof toolImplementationConfig)[Id] {
  const implementation = toolImplementationConfig[id];
  if (implementation === undefined) throw new Error(`Missing tool implementation: ${id}`);
  return implementation;
}
~~~

Create `toolImplementationConfig` with `defineToolImplementationConfig({...} as const satisfies Record<AvailableToolId, ToolImplementationConfig>)`. Use this complete discriminant map, then move each entry's required `eyebrow`, `defaultSummary`, notice text, navigation label, and three steps verbatim from the matching current `site.ts` object:

| ID | Family | Bundle profile | Intent | Intent class | Source count / byte limits |
| --- | --- | --- | --- | --- | --- |
| `image.compress` | image | image | compress | omitted | 1–100; 50/250 MiB |
| `image.resize` | image | image | resize | omitted | 1–100; 50/250 MiB |
| `image.convert` | image | image | convert | omitted | 1–100; 50/250 MiB |
| `image.watermark` | image | image-watermark | watermark | omitted | 1–100; 50/250 MiB |
| `pdf.merge` | pdf | pdf-editing | merge | editing | 2–20; 50/100 MiB; constrained 60 MiB |
| `pdf.split` | pdf | pdf-editing | split | editing | 1; 50/100 MiB; constrained 60 MiB |
| `pdf.organize` | pdf | pdf-editing | organize | editing | 1; 50/100 MiB; constrained 60 MiB |
| `pdf.watermark` | pdf | pdf-editing | watermark | editing | 1; 50/100 MiB; constrained 60 MiB |
| `pdf.image-to-pdf` | pdf | pdf-editing | image-to-pdf | editing | 1–100; 50/100 MiB; constrained 60 MiB |
| `pdf.to-image` | pdf | pdf-to-images | to-image | pdf-to-images | 1; 50/50 MiB |
| `pdf.compress-scanned` | pdf | pdf-compress-scanned | compress | pdf-compress-scanned | 1; 50/50 MiB |

Rebuild the existing `imageTools`, `pdfTools`, lists, and related helper exports by joining catalog identity with `toolImplementationConfig`. They remain compatibility adapters only; no name, description, route, taxonomy, availability, or related ID is authored in `site.ts`.

~~~ts
function createLegacyImageTool<const Id extends Extract<AvailableToolId, `image.${string}`>>(
  id: Id,
): ImageToolConfig {
  const catalog = getAvailableToolById(id);
  const implementation = getToolImplementation(id);
  if (implementation.family !== "image") throw new Error(`Expected image implementation: ${id}`);
  const supportNotice = implementation.notices.find(({ tone }) => tone === "support")?.text;
  return {
    intent: implementation.intent,
    path: catalog.route as `/image/${ImageToolIntent}`,
    navLabel: implementation.legacyNavLabel,
    eyebrow: implementation.eyebrow,
    title: catalog.name,
    description: catalog.shortDescription,
    defaultSummary: implementation.defaultSummary,
    steps: implementation.legacySteps,
    ...(supportNotice === undefined ? {} : { heicNote: supportNotice }),
  };
}

function createLegacyPdfTool<const Id extends Extract<AvailableToolId, `pdf.${string}`>>(
  id: Id,
): PdfToolConfig {
  const catalog = getAvailableToolById(id);
  const implementation = getToolImplementation(id);
  if (implementation.family !== "pdf") throw new Error(`Expected PDF implementation: ${id}`);
  const warning = implementation.notices.find(({ tone }) => tone === "warning")?.text;
  if (implementation.intentClass === undefined) throw new Error(`Missing PDF class: ${id}`);
  return {
    intent: implementation.intent,
    intentClass: implementation.intentClass,
    path: catalog.route as `/pdf/${PdfToolIntent}`,
    navLabel: implementation.legacyNavLabel,
    eyebrow: implementation.eyebrow,
    title: catalog.name,
    description: catalog.shortDescription,
    defaultSummary: implementation.defaultSummary,
    steps: implementation.legacySteps,
    ...(warning === undefined ? {} : { warning }),
  };
}
~~~

Until Plan 2 moves the scanned-PDF workbench to keyed implementation data, keep `PDF_COMPRESS_SCANNED_WARNING` as a derived compatibility export sourced from `toolImplementationConfig["pdf.compress-scanned"].notices`; do not retain a second warning string.

- [ ] **Step 5: Make tool metadata catalog-only and update every route**

Replace the legacy union signature with:

~~~ts
import type { AvailableToolEntry } from "@hereisit/tool-registry/catalog";
import type { Metadata } from "next";
import { SITE_NAME, SITE_URL } from "./site-identity";

export function createToolMetadata(tool: AvailableToolEntry): Metadata {
  const canonical = new URL(tool.route, SITE_URL).toString();
  const socialTitle = `${tool.name} | ${SITE_NAME}`;
  return {
    title: tool.name,
    description: tool.shortDescription,
    alternates: { canonical },
    openGraph: {
      title: socialTitle,
      description: tool.shortDescription,
      url: canonical,
      siteName: SITE_NAME,
      type: "website",
      locale: "ko_KR",
    },
    twitter: { card: "summary", title: socialTitle, description: tool.shortDescription },
  };
}
~~~

Use `tool.route`, `tool.name`, and `tool.shortDescription`. Remove `createImageToolMetadata`. In each of the 11 route modules import `getAvailableToolById()` and pass the strict catalog entry to metadata while retaining the temporary legacy adapter only for rendering:

~~~ts
const catalogTool = getAvailableToolById("image.compress");
const tool = imageTools.compress;
export const metadata = createToolMetadata(catalogTool);
~~~

Do this for `image.compress`, `image.resize`, `image.convert`, `image.watermark`, `pdf.merge`, `pdf.split`, `pdf.organize`, `pdf.watermark`, `pdf.to-image`, `pdf.image-to-pdf`, and `pdf.compress-scanned`. Sitemap maps `availableToolEntries` and does not add future discovery routes until they exist in Plan 2.

~~~ts
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: new URL("/", SITE_URL).toString(), changeFrequency: "weekly", priority: 1 },
    ...availableToolEntries.map((tool) => ({
      url: new URL(tool.route, SITE_URL).toString(),
      changeFrequency: "weekly" as const,
      priority: 0.9,
    })),
  ];
}
~~~

- [ ] **Step 6: Verify behavior-preserving migration and commit**

Run: `pnpm test apps/web/src/lib/site.test.ts --run && pnpm --filter @hereisit/web typecheck && pnpm --filter @hereisit/web build`

Expected: PASS; the same 11 pages export and render, while SEO imports no implementation or processor module.

Commit:

~~~bash
git add apps/web/src/lib/site-identity.ts apps/web/src/lib/tool-implementations.ts apps/web/src/lib/site.ts apps/web/src/lib/site.test.ts apps/web/src/lib/metadata.ts apps/web/src/app/layout.tsx apps/web/src/app/robots.ts apps/web/src/app/sitemap.ts apps/web/src/app/image apps/web/src/app/pdf
git commit -m "refactor: derive tool identity from catalog"
~~~

### Task 5: Enforce lightweight imports and catalog-driven static export

**Files:**
- Create: `tests/catalog-import-boundary.test.ts`
- Create: `tests/tool-catalog-routes.test.ts`
- Modify: `scripts/verify-static-export.mjs`

**Interfaces:**
- Consumes: `availableToolEntries` from the authored catalog and `bundleProfile` from keyed implementation configuration.
- Produces: build-breaking import, route, metadata, sitemap, and per-profile bundle isolation checks used by every later release gate.

- [ ] **Step 1: Write failing import-closure and route-presence tests**

`catalog-import-boundary.test.ts` recursively follows relative static imports starting at:

- `packages/tool-registry/src/tool-catalog.ts`
- `packages/tool-registry/src/tool-discovery.ts`
- `packages/tool-registry/src/file-kind.ts`
- `apps/web/src/lib/site-identity.ts`
- `apps/web/src/lib/metadata.ts`

Reject any runtime import containing `tool-contracts`, `browser-runtime`, `image-tool`, `pdf-tool`, `components/`, `.worker`, `pdfjs`, codec/WASM names, React, or `tool-implementations`. Permit `import type` and the catalog's relative pure helpers. The failure message prints only module paths, never user data.

`tool-catalog-routes.test.ts` maps each available `tool.route` to `apps/web/src/app${route}/page.tsx`, asserts the file exists, and asserts planned entries have no route and no corresponding app directory.

Implement the import test with the already-installed TypeScript parser so multiline imports cannot bypass a regex:

~~~ts
import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const entrypoints = [
  "packages/tool-registry/src/tool-catalog.ts",
  "packages/tool-registry/src/tool-discovery.ts",
  "packages/tool-registry/src/file-kind.ts",
  "apps/web/src/lib/site-identity.ts",
  "apps/web/src/lib/metadata.ts",
];
const allowedRuntimePackages = new Set(["@hereisit/tool-registry/catalog"]);
const forbidden = /(tool-contracts|browser-runtime|image-tool|pdf-tool|components\/|\.worker|pdfjs|codec|wasm|react|tool-implementations)/i;

async function visit(file: string, seen: Set<string>): Promise<void> {
  const absolute = path.resolve(root, file);
  if (seen.has(absolute)) return;
  seen.add(absolute);
  const source = await readFile(absolute, "utf8");
  const tree = ts.createSourceFile(absolute, source, ts.ScriptTarget.Latest, true);
  for (const statement of tree.statements) {
    const declaration = ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
      ? statement
      : undefined;
    if (declaration?.moduleSpecifier === undefined || !ts.isStringLiteral(declaration.moduleSpecifier)) continue;
    const typeOnly = ts.isImportDeclaration(declaration)
      ? declaration.importClause?.isTypeOnly === true
      : declaration.isTypeOnly;
    if (typeOnly) continue;
    const specifier = declaration.moduleSpecifier.text;
    expect(specifier).not.toMatch(forbidden);
    if (!specifier.startsWith(".")) {
      expect(allowedRuntimePackages.has(specifier)).toBe(true);
      continue;
    }
    const resolved = path.resolve(path.dirname(absolute), specifier.endsWith(".ts") ? specifier : `${specifier}.ts`);
    await visit(path.relative(root, resolved), seen);
  }
  function rejectDynamicImport(node: ts.Node): void {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      throw new Error(`Dynamic import is forbidden in lightweight module: ${path.relative(root, absolute)}`);
    }
    ts.forEachChild(node, rejectDynamicImport);
  }
  rejectDynamicImport(tree);
}

it("keeps discovery and metadata import closures lightweight", async () => {
  const seen = new Set<string>();
  for (const entrypoint of entrypoints) await visit(entrypoint, seen);
  expect([...seen].map((file) => path.relative(root, file)).sort()).toContain(
    "packages/tool-registry/src/tool-catalog.ts",
  );
});
~~~

Implement the route test as a filesystem contract:

~~~ts
import { access } from "node:fs/promises";
import path from "node:path";
import { availableToolEntries, plannedToolEntries } from "@hereisit/tool-registry/catalog";
import { expect, it } from "vitest";

it("backs every available route with a static page", async () => {
  for (const tool of availableToolEntries) {
    await expect(access(path.join(process.cwd(), "apps/web/src/app", tool.route.slice(1), "page.tsx")))
      .resolves.toBeUndefined();
  }
});

it("does not reserve a route for roadmap cards", async () => {
  expect(plannedToolEntries.every((tool) => !("route" in tool))).toBe(true);
  await expect(access(path.join(process.cwd(), "apps/web/src/app/media/video-compress/page.tsx")))
    .rejects.toMatchObject({ code: "ENOENT" });
});
~~~

- [ ] **Step 2: Run the boundary tests and confirm RED**

Run: `pnpm test tests/catalog-import-boundary.test.ts tests/tool-catalog-routes.test.ts --run`

Expected: FAIL until the legacy metadata import and hardcoded route assumptions are fully removed.

- [ ] **Step 3: Prove Node 24 imports the authored manifest directly**

Run:

~~~bash
node --input-type=module -e "import('./packages/tool-registry/src/tool-catalog.ts').then(({availableToolEntries}) => { if (availableToolEntries.length !== 11) process.exit(1); })"
~~~

Expected: exit 0 without a loader or runtime Zod import.

Also prove the verifier's implementation-data import stays Node-compatible:

~~~bash
node --input-type=module -e "import('./apps/web/src/lib/tool-implementations.ts').then(({toolImplementationConfig}) => { if (Object.keys(toolImplementationConfig).length !== 11) process.exit(1); })"
~~~

Expected: exit 0 without importing React, a workbench, or a processor.

- [ ] **Step 4: Make static-export verification data-driven**

At the top of `scripts/verify-static-export.mjs`, import both lightweight authored sources:

~~~js
import { toolImplementationConfig } from "../apps/web/src/lib/tool-implementations.ts";
import { availableToolEntries } from "../packages/tool-registry/src/tool-catalog.ts";

const toolPages = availableToolEntries.map((tool) => ({
  file: `${tool.route.slice(1)}.html`,
  path: tool.route,
  title: tool.name,
  description: tool.shortDescription,
  bundleProfile: toolImplementationConfig[tool.id].bundleProfile,
}));
~~~

Remove the exact 11-page assertion, hardcoded image/PDF arrays, the `['image', 'pdf']` output-directory enumeration, prefix-based classification, route-class counts, and contract-ID-to-bundle inference. Use each catalog-derived `file` for existence/HTML checks and compare its canonical/sitemap identity to `tool.path`; Plan 2 separately registers and verifies discovery-only routes. Keep an explicit marker matrix keyed by `ToolBundleProfile`; preserve every current positive/negative Worker, PDF.js, remote asset, metadata, sitemap, security-header, and route-isolation assertion.

~~~js
const ALL_PROCESSING_MARKERS = [
  IMAGE_WORKER_MARKER,
  IMAGE_WATERMARK_WORKER_MARKER,
  PDF_WORKER_MARKER,
  PDF_INSPECTION_WORKER_MARKER,
  PDF_TO_IMAGES_WORKER_MARKER,
  PDF_COMPRESS_SCANNED_WORKER_MARKER,
  PDFJS_MARKER,
];
const bundleProfileMarkers = {
  image: [IMAGE_WORKER_MARKER],
  "image-watermark": [IMAGE_WATERMARK_WORKER_MARKER],
  "pdf-editing": [PDF_WORKER_MARKER, PDF_INSPECTION_WORKER_MARKER],
  "pdf-to-images": [PDF_INSPECTION_WORKER_MARKER, PDF_TO_IMAGES_WORKER_MARKER, PDFJS_MARKER],
  "pdf-compress-scanned": [
    PDF_INSPECTION_WORKER_MARKER,
    PDF_COMPRESS_SCANNED_WORKER_MARKER,
    PDFJS_MARKER,
  ],
};

for (const { tool, closure } of routeClosures) {
  const required = bundleProfileMarkers[tool.bundleProfile];
  assert.ok(required !== undefined, `Unknown bundle profile for ${tool.path}`);
  for (const marker of required) assertClosureHas(closure, marker, `${tool.path} is missing ${marker}.`);
  for (const marker of ALL_PROCESSING_MARKERS.filter((candidate) => !required.includes(candidate))) {
    assertClosureLacks(closure, marker, `${tool.path} unexpectedly loaded ${marker}.`);
  }
}
~~~

- [ ] **Step 5: Verify GREEN and run the complete foundation gate**

Run:

~~~bash
pnpm test tests/catalog-import-boundary.test.ts tests/tool-catalog-routes.test.ts --run
pnpm verify:export
pnpm verify
~~~

Expected: all commands PASS; every available catalog route is exported and all lightweight boundaries exclude processors.

- [ ] **Step 6: Commit verification guards**

~~~bash
git add tests/catalog-import-boundary.test.ts tests/tool-catalog-routes.test.ts scripts/verify-static-export.mjs
git commit -m "test: enforce catalog export boundaries"
~~~

## Completion checkpoint

This plan is complete only when the public UI and all processors behave exactly as before, the catalog is the sole source of discovery/SEO identity, the one planned video card has no route, Node 24 imports the exact authored manifest directly, and `pnpm verify` passes. Continue with `2026-07-14-tool-discovery-navigation.md`; do not redesign detail pages during this phase.

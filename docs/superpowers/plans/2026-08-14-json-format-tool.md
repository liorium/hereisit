# JSON 정리·검사 도구 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 값 표현을 바꾸지 않고 JSON을 검사·정리·축소하는 첫 브라우저 전용 `quick` 도구를 `/data/json`에 제공한다.

**Architecture:** 네이티브 `JSON.parse()`는 문법 검증에만 사용하고, 별도의 단일 순회 변환기가 문자열 밖 공백과 구조 문자만 다시 배치한다. 기존 카탈로그와 상세 페이지를 최소 확장하고, 전용 React workbench가 입력·결과·복사·다운로드 상태만 소유한다. 입력 1 MiB, 중첩 100단계, 출력 4 MiB를 fail-closed로 제한한다.

**Tech Stack:** TypeScript 6, React 19, Next.js 16 App Router, Vitest 4, hosted Playwright, CSS Modules, pnpm 11.

## Global Constraints

- 새 런타임 의존성, 서버 API, Worker, 계정, 저장 기능을 추가하지 않는다.
- JSON 내용·일부 내용·키·값·결과·파서 예외·클립보드 내용을 로그나 네트워크로 보내지 않는다.
- `JSON.stringify()`로 결과를 생성하지 않고 문자열·숫자·리터럴 토큰의 원문을 그대로 보존한다.
- 입력은 UTF-8 최대 1 MiB, 중첩은 최대 100단계, 출력은 UTF-8 최대 4 MiB다.
- Playwright 브라우저는 로컬에서 설치하거나 실행하지 않고 GitHub Actions에 맡긴다.
- 기존 파일·workspace 도구, `/workflows`, 처리 계약과 discovery import 경계를 바꾸지 않는다.

---

### Task 1: 값 보존 JSON 변환 코어

**Files:**
- Create: `apps/web/src/lib/json-format.ts`
- Create: `apps/web/src/lib/json-format.test.ts`
- Modify: `packages/tool-contracts/src/index.ts`
- Modify: `packages/tool-contracts/src/index.test.ts`

**Interfaces:**
- Produces: `JSON_FORMAT_TOOL_ID`, `JSON_FORMAT_TOOL_VERSION`, `JSON_FORMAT_LIMITS`, `JsonFormatMode`, `JsonFormatErrorCode`, `JsonFormatResult`, `transformJsonText(source, mode)`.
- Consumes: platform `TextEncoder` and `JSON.parse`; no third-party parser.

- [ ] **Step 1: Write failing contract and transformation tests**

Add the identity assertion to `packages/tool-contracts/src/index.test.ts`:

```ts
expect(JSON_FORMAT_TOOL_ID).toBe("json.format");
expect(JSON_FORMAT_TOOL_VERSION).toBe(1);
```

Create `apps/web/src/lib/json-format.test.ts` with exact public behavior:

```ts
import { describe, expect, it } from "vitest";
import { JSON_FORMAT_LIMITS, transformJsonText } from "./json-format";

describe("transformJsonText", () => {
  it("pretty-prints structure while preserving every value token", () => {
    const source =
      '{"big":9007199254740993,"decimal":1.2300,"exponent":1e+09,"escaped":"\\u0061","dup":1,"dup":2,"nested":[true,null]}';
    expect(transformJsonText(source, "pretty")).toEqual({
      ok: true,
      output:
        '{\n  "big": 9007199254740993,\n  "decimal": 1.2300,\n  "exponent": 1e+09,\n  "escaped": "\\u0061",\n  "dup": 1,\n  "dup": 2,\n  "nested": [\n    true,\n    null\n  ]\n}',
    });
  });

  it("minifies only JSON whitespace outside strings", () => {
    expect(transformJsonText(' { "text" : "a b, { c }" , "array" : [ 1, 2 ] } ', "minify"))
      .toEqual({ ok: true, output: '{"text":"a b, { c }","array":[1,2]}' });
  });

  it.each([
    ["", "EMPTY_INPUT"],
    ["{", "INVALID_JSON"],
    [`${"[".repeat(101)}0${"]".repeat(101)}`, "NESTING_TOO_DEEP"],
  ] as const)("rejects bounded invalid input", (source, code) => {
    expect(transformJsonText(source, "pretty")).toEqual({ ok: false, code });
  });

  it("enforces the exact UTF-8 input ceiling", () => {
    const exact = `"${"a".repeat(JSON_FORMAT_LIMITS.maxInputBytes - 2)}"`;
    expect(transformJsonText(exact, "minify").ok).toBe(true);
    expect(transformJsonText(`${exact} `, "minify")).toEqual({
      ok: false,
      code: "INPUT_TOO_LARGE",
    });
  });

  it("stops pretty output before the four MiB ceiling", () => {
    const source = `${"[".repeat(100)}${Array.from({ length: 45_000 }, () => "0").join(",")}${"]".repeat(100)}`;
    expect(transformJsonText(source, "pretty")).toEqual({
      ok: false,
      code: "OUTPUT_TOO_LARGE",
    });
  });
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
pnpm exec vitest run packages/tool-contracts/src/index.test.ts apps/web/src/lib/json-format.test.ts
```

Expected: FAIL because the JSON contract constants and `json-format.ts` do not exist.

- [ ] **Step 3: Add the contract identity and minimal bounded transformer**

Add to `packages/tool-contracts/src/index.ts`:

```ts
export const JSON_FORMAT_TOOL_ID = "json.format" as const;
export const JSON_FORMAT_TOOL_VERSION = 1 as const;
```

Create `apps/web/src/lib/json-format.ts` with this public shape:

```ts
export const JSON_FORMAT_LIMITS = Object.freeze({
  maxInputBytes: 1024 * 1024,
  maxDepth: 100,
  maxOutputBytes: 4 * 1024 * 1024,
});

export type JsonFormatMode = "pretty" | "minify";
export type JsonFormatErrorCode =
  | "EMPTY_INPUT"
  | "INPUT_TOO_LARGE"
  | "INVALID_JSON"
  | "NESTING_TOO_DEEP"
  | "OUTPUT_TOO_LARGE";
export type JsonFormatResult =
  | { ok: true; output: string }
  | { ok: false; code: JsonFormatErrorCode };

export function transformJsonText(source: string, mode: JsonFormatMode): JsonFormatResult;
```

Implementation rules:

1. Reject `source.length > maxInputBytes` before allocating encoded bytes; otherwise use one `TextEncoder` to enforce the exact UTF-8 limit.
2. Reject an input containing only JSON whitespace (space, tab, CR and LF) as `EMPTY_INPUT`; non-JSON whitespace such as NBSP proceeds to strict syntax validation.
3. Call `JSON.parse(source)` inside `try/catch`, discard the value, and map every exception to `INVALID_JSON` without retaining its message.
4. Scan UTF-16 code units with `inString` and `escaped` flags. Outside strings, count `{` and `[` depth, reject depth 101, and remove only space, tab, CR and LF.
5. For `minify`, return the compact token-preserving string.
6. For `pretty`, scan the compact string and append structure, newlines and `"  ".repeat(depth)` to a chunk array. Track chunk UTF-16 length and stop when it exceeds 4 MiB; after join, use `TextEncoder` for the exact UTF-8 output check.
7. Never include source text or caught error text in the failure object.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
pnpm exec vitest run packages/tool-contracts/src/index.test.ts apps/web/src/lib/json-format.test.ts
pnpm --filter @hereisit/tool-contracts typecheck
pnpm --filter @hereisit/web typecheck
```

Expected: all tests and both typechecks exit `0`.

- [ ] **Step 5: Commit the core**

```bash
git add packages/tool-contracts/src/index.ts packages/tool-contracts/src/index.test.ts \
  apps/web/src/lib/json-format.ts apps/web/src/lib/json-format.test.ts
git commit -m "feat: add bounded JSON formatting core"
```

---

### Task 2: 카탈로그 quick 경계와 JSON workbench

**Files:**
- Create: `apps/web/src/components/tool-detail-experience.ts`
- Create: `apps/web/src/components/tool-detail-experience.test.ts`
- Create: `apps/web/src/components/json-format-workbench.tsx`
- Create: `apps/web/src/components/json-format-workbench.module.css`
- Create: `apps/web/src/app/data/json/page.tsx`
- Modify: `packages/tool-registry/src/tool-catalog.ts`
- Modify: `packages/tool-registry/src/tool-catalog.test.ts`
- Modify: `apps/web/src/lib/tool-implementations.ts`
- Modify: `apps/web/src/lib/tool-implementations.test.ts`
- Modify: `apps/web/src/components/tool-detail-page.tsx`
- Modify: `apps/web/src/components/tool-detail-page.module.css`
- Modify: `scripts/verify-static-export.mjs`
- Test: `tests/tool-catalog-routes.test.ts`

**Interfaces:**
- Consumes: Task 1 `JSON_FORMAT_*`, `JSON_FORMAT_LIMITS`, `transformJsonText()`.
- Produces: available catalog entry `data.json-format`, `/data/json`, `getToolWorkAreaPresentation(experience)`, and interactive `JsonFormatWorkbench`.

- [ ] **Step 1: Write failing catalog, implementation and quick-shell tests**

Update the exact catalog fixtures to include:

```ts
"data.json-format": {
  aliases: ["json 정리", "json 포맷", "json 검사", "json 축소"],
  contract: [JSON_FORMAT_TOOL_ID, JSON_FORMAT_TOOL_VERSION],
  related: ["image.convert", "pdf.to-image", "pdf.image-to-pdf"],
  execution: [undefined, undefined, undefined, undefined, ["application/json", "value/text"]],
}
```

Add an implementation expectation:

```ts
"data.json-format": { intent: "json-format", bundleProfile: "json-quick" },
```

Create `apps/web/src/components/tool-detail-experience.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { getToolWorkAreaPresentation } from "./tool-detail-experience";

describe("getToolWorkAreaPresentation", () => {
  it("maps every catalog experience to one honest work area", () => {
    expect(getToolWorkAreaPresentation("quick")).toEqual({
      label: "빠른 작업 영역",
      style: "quick",
    });
    expect(getToolWorkAreaPresentation("file")).toEqual({
      label: "파일 작업 영역",
      style: "file",
    });
    expect(getToolWorkAreaPresentation("workspace")).toEqual({
      label: "편집 작업 공간",
      style: "workspace",
    });
  });
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
pnpm exec vitest run packages/tool-registry/src/tool-catalog.test.ts \
  apps/web/src/lib/tool-implementations.test.ts \
  apps/web/src/components/tool-detail-experience.test.ts \
  tests/tool-catalog-routes.test.ts
```

Expected: FAIL because the new available tool, implementation profile, quick presentation helper and route are absent.

- [ ] **Step 3: Publish the catalog and implementation metadata**

Add this entry before the planned video entry:

```ts
{
  id: "data.json-format",
  name: "JSON 정리·검사",
  shortDescription:
    "JSON 문법을 검사하고 읽기 좋게 정리하거나 공백을 줄이세요. 내용은 브라우저 밖으로 나가지 않습니다.",
  domains: ["data", "web-dev"],
  purposes: ["edit", "convert"],
  searchAliases: ["json 정리", "json 포맷", "json 검사", "json 축소"],
  rank: 10,
  availability: "available",
  route: "/data/json",
  launcherInput: null,
  outputKinds: ["application/json", "value/text"],
  experience: "quick",
  execution: "browser",
  contract: { id: JSON_FORMAT_TOOL_ID, version: JSON_FORMAT_TOOL_VERSION },
  featured: false,
  relatedToolIds: ["image.convert", "pdf.to-image", "pdf.image-to-pdf"],
},
```

Extend `ToolBundleProfile` with `"json-quick"`. Make `ToolImplementationConfig` a discriminated union: existing image/PDF entries retain required `sourceFileLimits`; the data entry requires `sourceTextLimitBytes`, `maxOutputBytes`, and `maxDepth`, and has no file limits. Add:

```ts
"data.json-format": {
  family: "data",
  bundleProfile: "json-quick",
  intent: "json-format",
  sourceTextLimitBytes: JSON_FORMAT_LIMITS.maxInputBytes,
  maxOutputBytes: JSON_FORMAT_LIMITS.maxOutputBytes,
  maxDepth: JSON_FORMAT_LIMITS.maxDepth,
  eyebrow: "JSON FORMATTER",
  defaultSummary: "JSON 값을 바꾸지 않고 문법을 확인한 뒤 읽기 좋게 정리하거나 공백만 줄여요.",
  notices: [],
},
```

Update implementation tests so `launcherInput === null` is required only for the quick profile and file-limit assertions run only after narrowing to image/PDF.

Add `"json-quick": []` to `bundleProfileMarkers` in `scripts/verify-static-export.mjs`; an empty marker list means the route must contain none of the processing markers.

- [ ] **Step 4: Implement the quick shell and workbench**

Create `tool-detail-experience.ts` as an exhaustive frozen mapping from `Experience` to label/style. Use it in `ToolDetailPage`; remove the quick-tool throw, use the returned label and `styles[presentation.style]`, and add `.quick` to the existing full-width `.file, .workspace` rule.

Create `JsonFormatWorkbench` as a client component with:

```ts
type OutputState = { mode: "pretty" | "minify"; text: string } | null;
type Feedback =
  | { tone: "success"; message: string }
  | { tone: "error"; code: JsonFormatErrorCode | "COPY_FAILED"; message: string }
  | null;
```

Required behavior:

- labeled editable input textarea and labeled read-only result textarea;
- primary `정리하기`, secondary `공백 줄이기`, `지우기`;
- `transformJsonText()` call only on explicit formatting actions;
- exact Korean messages for empty, too large, invalid, too deep and oversized output without parser text;
- error block with `role="alert"`, `tabIndex={-1}`, input `aria-describedby`, and focus after a failed action;
- `aria-live="polite"` success/copy status;
- copy through `navigator.clipboard.writeText(output.text)` with retained result on failure;
- download through a temporary `Blob([text], { type: "application/json;charset=utf-8" })`, hidden anchor, `formatted.json` or `minified.json`, immediate anchor removal and URL revocation;
- reset clears input, result and feedback, then focuses input;
- no storage, fetch, console output, effect, automatic clipboard or automatic download.

CSS must keep the surface within `min(calc(100% - 32px), 760px)`, use `box-sizing: border-box`, give controls at least 44px height, use `overflow-x: auto` only inside result, and stack action buttons without page overflow at 320px.

Create `/data/json/page.tsx` using the existing metadata/page pattern:

```tsx
const toolId = "data.json-format" satisfies AvailableToolId;
export const metadata = createToolMetadata(getAvailableToolById(toolId));

export default function JsonFormatPage() {
  return <ToolDetailPage toolId={toolId} workbench={<JsonFormatWorkbench />} />;
}
```

- [ ] **Step 5: Run focused tests and typechecks**

Run:

```bash
pnpm exec vitest run packages/tool-registry/src/tool-catalog.test.ts \
  apps/web/src/lib/tool-implementations.test.ts \
  apps/web/src/components/tool-detail-experience.test.ts \
  apps/web/src/lib/json-format.test.ts \
  tests/tool-catalog-routes.test.ts
pnpm --filter @hereisit/tool-registry typecheck
pnpm --filter @hereisit/web typecheck
```

Expected: every command exits `0`.

- [ ] **Step 6: Commit the vertical product slice**

```bash
git add packages/tool-registry/src/tool-catalog.ts packages/tool-registry/src/tool-catalog.test.ts \
  apps/web/src/lib/tool-implementations.ts apps/web/src/lib/tool-implementations.test.ts \
  apps/web/src/components/tool-detail-experience.ts \
  apps/web/src/components/tool-detail-experience.test.ts \
  apps/web/src/components/tool-detail-page.tsx apps/web/src/components/tool-detail-page.module.css \
  apps/web/src/components/json-format-workbench.tsx \
  apps/web/src/components/json-format-workbench.module.css apps/web/src/app/data/json/page.tsx \
  scripts/verify-static-export.mjs tests/tool-catalog-routes.test.ts
git commit -m "feat: publish JSON formatting tool"
```

---

### Task 3: 호스팅 수용 범위, 문서와 전체 검증

**Files:**
- Modify: `tests/e2e/tool-pages.spec.ts`
- Modify: `tests/e2e/tool-detail-shells.spec.ts`
- Modify: `tests/e2e/mobile.spec.ts`
- Modify: `scripts/smoke-navigation.mjs`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/superpowers/specs/2026-08-13-json-format-tool-design.md`
- Create: `docs/superpowers/plans/2026-08-14-json-format-tool.md`

**Interfaces:**
- Consumes: the published `/data/json` route and exact accessible labels from Task 2.
- Produces: hosted-browser acceptance source, truthful release smoke, documentation and a fully verified clean branch.

- [ ] **Step 1: Add hosted browser acceptance source without running it locally**

Add a focused test in `tests/e2e/tool-pages.spec.ts` that:

1. reveals `/data/json` from `/tools` and verifies title, canonical and description;
2. installs a test-only clipboard stub before navigation, fills a value containing `9007199254740993`, `1.2300`, `1e+09`, `\\u0061` and duplicate keys;
3. clicks `정리하기` and asserts exact read-only output;
4. copies and asserts the stub received exactly that output;
5. clicks `공백 줄이기` and asserts exact compact output;
6. waits for the explicit download and checks `minified.json` plus exact bytes;
7. enters invalid JSON, asserts the sanitized Korean error and focused alert, then resets and verifies both fields are empty;
8. records requests after the route is ready and asserts no request method outside GET/HEAD, no body, no cross-origin URL, and no JSON sentinel in URLs.

Extend `expectCatalogShell` in `tool-detail-shells.spec.ts` to accept `"빠른 작업 영역"`, then assert the JSON route has that region, the local disclosure, and ordered related routes `/image/convert`, `/pdf/to-image`, `/pdf/image-to-pdf`.

Add `/data/json` to the 320×568 representative work-area loop in `mobile.spec.ts` and verify page scroll width stays at most 320.

Do not invoke Playwright locally.

- [ ] **Step 2: Repair and extend the tracked navigation smoke source**

Update `scripts/smoke-navigation.mjs` to match the already-shipped navigation decision and the new tool:

- add `/data/json` to `ROUTE_PATHS`;
- require zero `워크플로` links in the primary header;
- require 12 available catalog cards;
- require no quick work area on the home page;
- visit `/data/json` and call `assertDetailShell()` with `빠른 작업 영역`, `이 기기에서 처리`, and the three related routes.

Do not run the smoke locally because it launches Playwright; hosted CI owns browser execution.

- [ ] **Step 3: Update current capability documentation**

Update README to describe browser-local JSON validation/formatting, document `quick` alongside `file` and `workspace`, and add current limits: 1 MiB input, 100 nesting levels, 4 MiB output, token spelling preserved, no JSON5/comments/repair.

Update `docs/architecture.md` to change inventory from ten file plus one workspace tool to ten file, one workspace and one quick tool; document `json.format@1`, validation-only `JSON.parse`, token-preserving whitespace transformation, explicit copy/download and the three resource limits.

Keep the approved design synchronized with final error labels and limits; do not broaden excluded scope.

- [ ] **Step 4: Run formatting and focused non-browser verification**

Run:

```bash
pnpm exec biome check --write \
  packages/tool-contracts/src/index.ts packages/tool-contracts/src/index.test.ts \
  packages/tool-registry/src/tool-catalog.ts packages/tool-registry/src/tool-catalog.test.ts \
  apps/web/src/lib/json-format.ts apps/web/src/lib/json-format.test.ts \
  apps/web/src/lib/tool-implementations.ts apps/web/src/lib/tool-implementations.test.ts \
  apps/web/src/components/tool-detail-experience.ts \
  apps/web/src/components/tool-detail-experience.test.ts \
  apps/web/src/components/tool-detail-page.tsx apps/web/src/components/tool-detail-page.module.css \
  apps/web/src/components/json-format-workbench.tsx \
  apps/web/src/components/json-format-workbench.module.css apps/web/src/app/data/json/page.tsx \
  tests/tool-catalog-routes.test.ts tests/e2e/tool-pages.spec.ts \
  tests/e2e/tool-detail-shells.spec.ts tests/e2e/mobile.spec.ts \
  scripts/verify-static-export.mjs scripts/smoke-navigation.mjs README.md docs/architecture.md

pnpm exec vitest run packages/tool-contracts/src/index.test.ts \
  packages/tool-registry/src/tool-catalog.test.ts apps/web/src/lib/json-format.test.ts \
  apps/web/src/lib/tool-implementations.test.ts \
  apps/web/src/components/tool-detail-experience.test.ts tests/tool-catalog-routes.test.ts
pnpm --filter @hereisit/tool-contracts typecheck
pnpm --filter @hereisit/tool-registry typecheck
pnpm --filter @hereisit/web typecheck
git diff --check
```

Expected: all commands exit `0`.

- [ ] **Step 5: Run the full repository gate**

Run:

```bash
pnpm verify
```

Expected: production audit, lint, all package typechecks, unit and Worker integration suites, image fuzz, all builds, static export, discovery import isolation, and bundle budgets exit `0`.

- [ ] **Step 6: Clean generated outputs and review exact scope**

Remove only generated outputs produced by verification: `apps/*/dist`, `apps/web/.next`, `apps/web/out`, generated `apps/web/public/pdfjs`, generated `apps/web/public/_headers`, and transient task-owned Docker image tags/containers. Preserve the retained PDF benchmark image and unrelated user artifacts.

Run:

```bash
git status --short
git diff --check
git diff --stat HEAD
git diff -- apps/web/src/app/workflows/page.tsx
```

Expected: only the approved JSON tool, quick shell, catalog, hosted acceptance source, release smoke, documentation, design amendment and plan are changed; `/workflows` is untouched.

- [ ] **Step 7: Commit the acceptance and documentation slice**

```bash
git add tests/e2e/tool-pages.spec.ts tests/e2e/tool-detail-shells.spec.ts \
  tests/e2e/mobile.spec.ts scripts/smoke-navigation.mjs README.md docs/architecture.md \
  docs/superpowers/specs/2026-08-13-json-format-tool-design.md \
  docs/superpowers/plans/2026-08-14-json-format-tool.md
git commit -m "test: gate JSON formatting tool release"
```

- [ ] **Step 8: Verify the committed result**

Run:

```bash
git status --short
git diff --check HEAD~3 HEAD
git log -4 --oneline
```

Expected: tracked worktree clean; three implementation commits follow the approved design commit; no push, PR, deployment or local Playwright run has occurred.

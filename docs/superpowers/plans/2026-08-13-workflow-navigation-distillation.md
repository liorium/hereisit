# Workflow Navigation Distillation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the unavailable workflow destination from global navigation while preserving the `/workflows` route for future expansion.

**Architecture:** Keep the existing `SiteHeader` structure and delete only the three workflow entry points plus their dedicated CSS. Share the remaining link destinations between desktop and mobile through one small constant, preserve the route, metadata, catalog, processing contracts, and direct-route coverage, and update hosted Playwright source for full interaction coverage.

**Tech Stack:** React 19, Next.js 16, Vitest, Playwright E2E source, CSS Modules, pnpm 11.

## Global Constraints

- Do not add dependencies or a feature flag.
- Keep `/workflows` directly renderable and non-indexed.
- Keep keyboard focus, overlay close, mobile drawer, file handoff, and search behavior unchanged.
- Do not install or run Playwright browsers locally; GitHub Actions owns browser execution.
- Do not change tool catalog entries, processing contracts, or workbench behavior.

---

### Task 1: Hide unfinished workflows from global navigation

**Files:**
- Create: `apps/web/src/components/site-header-navigation.ts`
- Create: `apps/web/src/components/site-header-navigation.test.ts`
- Modify: `apps/web/src/components/site-header.tsx`
- Modify: `apps/web/src/components/site-header.module.css`
- Modify: `tests/e2e/discovery.spec.ts`
- Modify: `tests/e2e/discovery-mobile.spec.ts`

**Interfaces:**
- Consumes: existing `SiteHeader({ activePath?: string })` and `/workflows` route.
- Produces: `globalNavigationLinks` containing only currently usable shared destinations, and the same `SiteHeader` API without any rendered global link whose `href` is `/workflows`.

- [x] **Step 1: Write the failing component regression test**

Create `apps/web/src/components/site-header-navigation.test.ts` before the production module exists:

```ts
import { describe, expect, it } from "vitest";
import { globalNavigationLinks } from "./site-header-navigation";

describe("globalNavigationLinks", () => {
  it("contains only destinations users can use now", () => {
    expect(globalNavigationLinks).toEqual([{ href: "/my-tools", label: "내 도구" }]);
  });
});
```

Production mutation caught: restoring `/workflows` through the shared global destination list changes the exact public list and fails the test. Hosted E2E source independently asserts the rendered desktop, mega-menu and mobile surfaces.

- [x] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm exec vitest run apps/web/src/components/site-header-navigation.test.ts
```

Expected: FAIL because `site-header-navigation.ts` does not exist yet.

- [x] **Step 3: Update hosted browser acceptance source**

In `tests/e2e/discovery.spec.ts`:

- Replace the client-navigation handoff test's `워크플로` click with `내 도구` and expect `/my-tools`.
- In the desktop destination test, assert the exact `워크플로` link count is `0` before and after opening the mega menu.
- Remove the `준비 중` and `워크플로 보기` positive assertions.
- Preserve all domain-link, focus-entry, Escape-close, direct `/workflows`, canonical and sitemap assertions.

In `tests/e2e/discovery-mobile.spec.ts`, replace the positive drawer assertion with:

```ts
await expect(drawer.getByRole("link", { name: "워크플로", exact: true })).toHaveCount(0);
```

Do not run Playwright locally.

- [x] **Step 4: Implement the minimum header change**

Create `apps/web/src/components/site-header-navigation.ts`:

```ts
export const globalNavigationLinks = Object.freeze([{ href: "/my-tools", label: "내 도구" }]);
```

In `apps/web/src/components/site-header.tsx`, map `globalNavigationLinks` in the desktop and mobile navigation, and delete:

- the desktop `/workflows` `Link` and its `준비 중` badge;
- the mega-menu `workflowTeaser` aside;
- the mobile drawer `/workflows` `Link`.

In `apps/web/src/components/site-header.module.css`, delete all `.workflowTeaser` rules and its now-unused responsive override. Do not change the remaining grid, navigation order, focus handling, or route.

- [x] **Step 5: Verify GREEN and static quality**

Run:

```bash
pnpm exec vitest run apps/web/src/components/site-header-navigation.test.ts
pnpm --filter @hereisit/web typecheck
pnpm exec biome check apps/web/src/components/site-header-navigation.test.ts apps/web/src/components/site-header-navigation.ts apps/web/src/components/site-header.tsx apps/web/src/components/site-header.module.css tests/e2e/discovery.spec.ts tests/e2e/discovery-mobile.spec.ts
git diff --check
```

Expected: every command exits `0`; the Vitest file reports `1` passing test.

- [x] **Step 6: Run the repository verification gate**

Run:

```bash
pnpm verify
```

Expected: lint, package typechecks, unit/integration tests, fuzz, builds, static export and bundle checks all exit `0`. Playwright browser execution remains deferred to hosted CI by repository policy.

The first audit exposed GHSA-2v37-7h3g-55p8 in the pinned `nanoid@3.3.17`. The minimum compatible patch to `3.3.18`, lockfile, notice, and supply-chain checksum was applied and verified separately before the full gate passed.

- [x] **Step 7: Review scope and commit**

Run:

```bash
git diff --check
git status --short
git diff --stat HEAD
```

Confirm that the direct `/workflows` page and processing code are untouched, then commit:

```bash
git add apps/web/src/components/site-header-navigation.test.ts apps/web/src/components/site-header-navigation.ts apps/web/src/components/site-header.tsx apps/web/src/components/site-header.module.css tests/e2e/discovery.spec.ts tests/e2e/discovery-mobile.spec.ts docs/superpowers/plans/2026-08-13-workflow-navigation-distillation.md
git commit -m "fix: hide unfinished workflows from navigation"
```

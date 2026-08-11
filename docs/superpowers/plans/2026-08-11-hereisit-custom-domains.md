# HereIsIt Custom Domains Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `https://hereisit.app` the public site and `https://api.hereisit.app` the production processing API without opening public server processing before the existing exact-SHA safety gates pass.

**Architecture:** Attach the existing Pages project and production Worker directly to Cloudflare Custom Domains; do not add a proxy or service. Keep the legacy Pages and `workers.dev` endpoints available during migration, but build new production assets against the custom API and admit only the apex plus the legacy Pages origin.

**Tech Stack:** Cloudflare Pages, Workers Custom Domains, Wrangler 4.111.0, Next.js 16 static export, Vitest, Playwright, GitHub Actions.

## Global Constraints

- Official web origin is exactly `https://hereisit.app`.
- Official processing API origin is exactly `https://api.hereisit.app`.
- `www.hereisit.app` permanently redirects to the apex while preserving path and query.
- Keep `https://hereisit.pages.dev` and the production `workers.dev` endpoint available during this migration.
- Production `APP_ORIGINS` contains exactly the apex and legacy Pages origins; staging origins remain unchanged.
- Public server processing remains fail-closed until CI, hosted browser tests, staging, production canary, and the existing USD 5 monthly admission gate pass.
- Do not add dependencies, a proxy, a self-hosted runner, a staging custom domain, codec changes, or UI changes.
- Never log file contents, filenames, thumbnails, presigned URLs, credentials, or response bodies that may contain them.

---

## File Map

- `apps/web/src/lib/site-identity.ts`: one source of truth for the public site origin.
- `scripts/generate-processing-wrangler.mjs`: exact Worker custom-domain route and production app-origin validation.
- `tests/generate-processing-wrangler.test.ts`: production route and allowlist contract.
- `.github/workflows/processing-production.yml`: custom production API/site origins, legacy Pages deployment alias, two-origin Worker config, custom-domain canary.
- `.github/workflows/processing-production-admission.yml`: same origins and two-origin allowlist for promotion/recovery.
- `scripts/report-product-analytics.mjs` and `tests/report-product-analytics.test.ts`: production analytics host.
- `scripts/verify-static-export.mjs`, `tests/e2e/discovery.spec.ts`, and `tests/e2e/tool-pages.spec.ts`: canonical, sitemap, robots, and browser expectations.
- `scripts/smoke-navigation.mjs`, `scripts/smoke-image-watermark.mjs`, `scripts/smoke-pdf-compress.mjs`, and `scripts/smoke-pdf-to-images.mjs`: public smoke defaults.
- `docs/deployment.md`, `docs/deployment/product-analytics.md`, and `docs/architecture.md`: official URL and recovery documentation.

---

### Task 1: Attach and verify the Cloudflare domains

**Files:**
- No repository file changes.

**Interfaces:**
- Consumes: active zone `042cfd6bf7db1a53c26ce5ffaa45f5ce`, Pages project `hereisit`, Worker service `hereisit-processing-production`.
- Produces: active `api.hereisit.app` Worker domain, active `hereisit.app` Pages domain, and a verified `www` apex redirect.

- [ ] **Step 1: Re-read current platform state without mutation**

  Query the Worker domains, Pages domains, DNS records, and redirect rules through the Cloudflare v4 API using the existing Wrangler OAuth credential. Validate exact account, zone, service, and project names; print only IDs, hostnames, statuses, and rule descriptions.

- [ ] **Step 2: Attach the Worker custom domain idempotently**

  If absent, call `PUT /accounts/{account_id}/workers/domains` with:

  ```json
  {
    "hostname": "api.hereisit.app",
    "service": "hereisit-processing-production",
    "zone_id": "042cfd6bf7db1a53c26ce5ffaa45f5ce",
    "zone_name": "hereisit.app"
  }
  ```

  Poll the exact domain until it has a certificate and resolves over HTTPS. Do not redeploy or change the Worker version.

- [ ] **Step 3: Verify the custom API read-only**

  Request `/health` and the anonymous `/v1/policy` contract from `https://api.hereisit.app` with origin `https://hereisit.pages.dev`. Assert status, HereIsIt JSON contract, exact CORS origin, security headers, local execution, and `upload: false`. Do not create a job.

- [ ] **Step 4: Attach the Pages apex idempotently**

  If absent, call `POST /accounts/{account_id}/pages/projects/hereisit/domains` with:

  ```json
  { "name": "hereisit.app" }
  ```

  Poll `GET /accounts/{account_id}/pages/projects/hereisit/domains/hereisit.app` until `status`, validation, and verification are active. Confirm `/`, `/tools`, `/image/compress`, and a static asset return 200 over HTTPS.

- [ ] **Step 5: Configure the native Cloudflare www redirect**

  Reuse an existing zone `http_request_dynamic_redirect` ruleset if present; otherwise create the one zone entrypoint required by Cloudflare. Add one enabled 301 rule matching only `http.host eq "www.hereisit.app"`, targeting `concat("https://hereisit.app", http.request.uri.path)`, preserving the query string. Ensure a proxied `www` DNS record exists. If the current OAuth credential lacks the exact DNS/Rulesets write permission, stop before partial www mutation and report the precise permission delta.

- [ ] **Step 6: Verify domain behavior**

  Assert `https://hereisit.app/...` serves Pages, `https://www.hereisit.app/a?b=1` produces exactly one 301 to `https://hereisit.app/a?b=1`, and `https://api.hereisit.app/health` reaches the existing production Worker. Record no response bodies beyond bounded public contract fields.

### Task 2: Move production source-of-truth URLs with TDD

**Files:**
- Modify: `tests/generate-processing-wrangler.test.ts`
- Modify: `tests/report-product-analytics.test.ts`
- Modify: `tests/e2e/discovery.spec.ts`
- Modify: `tests/e2e/tool-pages.spec.ts`
- Modify: `scripts/verify-static-export.mjs`
- Modify: `apps/web/src/lib/site-identity.ts`
- Modify: `scripts/generate-processing-wrangler.mjs`
- Modify: `scripts/report-product-analytics.mjs`
- Modify: `scripts/smoke-navigation.mjs`
- Modify: `scripts/smoke-image-watermark.mjs`
- Modify: `scripts/smoke-pdf-compress.mjs`
- Modify: `scripts/smoke-pdf-to-images.mjs`
- Modify: `.github/workflows/processing-production.yml`
- Modify: `.github/workflows/processing-production-admission.yml`
- Modify: `docs/deployment.md`
- Modify: `docs/deployment/product-analytics.md`
- Modify: `docs/architecture.md`

**Interfaces:**
- Consumes: active custom domains from Task 1.
- Produces: production Worker config with `routes: [{ pattern: "api.hereisit.app", custom_domain: true }]`, exact two-origin `APP_ORIGINS`, and web output canonicalized to `hereisit.app`.

- [ ] **Step 1: Write the failing Worker configuration tests**

  Change the production fixture to:

  ```ts
  appOrigins: ["https://hereisit.app", "https://hereisit.pages.dev"]
  ```

  Add expectations:

  ```ts
  expect(config.routes).toEqual([{ pattern: "api.hereisit.app", custom_domain: true }]);
  expect(config.workers_dev).toBe(true);
  expect(config.vars.APP_ORIGINS).toBe(
    '["https://hereisit.app","https://hereisit.pages.dev"]',
  );
  expect(generateProcessingWrangler(validInput("staging")).routes).toBeUndefined();
  ```

  Add rejection coverage for a staging config containing either production origin and a production config containing `https://www.hereisit.app` or a staging origin.

- [ ] **Step 2: Write the failing public-origin tests**

  Update analytics to expect `host: "hereisit.app"`. Update browser canonical and sitemap expectations to `https://hereisit.app`. Change `DEPLOYED_ORIGIN` and all explicit canonical/sitemap/robots assertions in `scripts/verify-static-export.mjs` to the apex. Keep staging test values unchanged.

- [ ] **Step 3: Run the focused tests to verify RED**

  Run:

  ```bash
  pnpm exec vitest run tests/generate-processing-wrangler.test.ts tests/report-product-analytics.test.ts tests/generate-web-headers.test.ts
  ```

  Expected: failures showing the missing production route, old one-origin allowlist, and old analytics host.

- [ ] **Step 4: Implement the smallest production config change**

  In `generateProcessingWrangler`, add `routes` only when `environment === "production"`:

  ```js
  routes: [{ pattern: "api.hereisit.app", custom_domain: true }],
  ```

  Reject both exact production origins in staging, reject any staging or `www` origin in production, preserve `workers_dev: true`, and leave every staging field untouched.

- [ ] **Step 5: Change the public site and analytics origins**

  Set:

  ```ts
  export const SITE_URL = "https://hereisit.app";
  ```

  Use `hereisit.app` as the production analytics host and public smoke default. Do not introduce another URL abstraction; reuse the existing site identity constant where TypeScript already imports it and change literal CLI defaults where scripts are independent.

- [ ] **Step 6: Change only production workflow origins**

  Set both production workflows to:

  ```yaml
  PRODUCTION_API_ORIGIN: https://api.hereisit.app
  PRODUCTION_PAGES_ORIGIN: https://hereisit.app
  LEGACY_PRODUCTION_PAGES_ORIGIN: https://hereisit.pages.dev
  ```

  Pass two `--app-origin` flags whenever generating production Wrangler config. Continue passing the legacy URL to `verify-pages-alias.mjs` for exact production-deployment binding, and use the custom site/API origins for policy, browser canary, public smoke, and recovery checks.

- [ ] **Step 7: Run focused GREEN and static export verification**

  Run:

  ```bash
  pnpm exec vitest run tests/generate-processing-wrangler.test.ts tests/report-product-analytics.test.ts tests/generate-web-headers.test.ts
  NEXT_PUBLIC_PROCESSING_API_ORIGIN=https://api.hereisit.app pnpm --filter @hereisit/web build
  pnpm verify:export
  ```

  Expected: all pass; generated CSP contains only self, Cloudflare analytics, and `https://api.hereisit.app`; canonical, sitemap, and robots use only the apex.

- [ ] **Step 8: Update operational documentation**

  Replace public `pages.dev` commands and analytics host with the official apex, document the custom API, and state that legacy endpoints remain compatibility/recovery paths. Do not change schema `$id` values or historical plan/spec records.

- [ ] **Step 9: Verify the entire repository and commit**

  Run:

  ```bash
  pnpm verify
  git diff --check
  ```

  Commit only the planned files with `feat: move HereIsIt to custom domains`.

### Task 3: Publish, verify, deploy, admit, and clean up

**Files:**
- No new product files; GitHub and Cloudflare produce temporary, sanitized evidence artifacts.

**Interfaces:**
- Consumes: Task 2 reviewed commit.
- Produces: merged exact SHA, green hosted browser evidence, green staging and production custom-domain canaries, rollout 100% under the USD 5 gate, and a clean checkout.

- [ ] **Step 1: Review the exact branch diff**

  Compare the branch against its fixed base. Confirm no staging origins, codec/UI behavior, schema IDs, dependencies, secrets, file metadata, or unrelated worktrees changed.

- [ ] **Step 2: Push and open one focused pull request**

  Push the feature branch, create a PR containing the domain mapping, compatibility paths, RED/GREEN evidence, and rollback behavior. Do not include credentials or Cloudflare response bodies.

- [ ] **Step 3: Require hosted CI evidence**

  Wait for `pnpm verify`, the protected six-project Playwright matrix including WebKit/mobile, product analytics, and Cloudflare Pages preview. Fix only branch-caused failures with a new focused RED/GREEN cycle.

- [ ] **Step 4: Merge and bind the exact main SHA**

  Merge only when all protected checks are green. Confirm local `main`, `origin/main`, the merge SHA, and every later workflow `head_sha` match exactly.

- [ ] **Step 5: Verify staging before production**

  Require the existing processing-staging workflow to pass its immutable build, deployment, authenticated upload/codec/download/ACK/delete smoke, leak check, and orphan check. Staging endpoints must remain unchanged.

- [ ] **Step 6: Run production closed-canary deployment**

  Approve the existing protected production environment. Require generated config to retain the custom Worker route, both production app origins, rollout 0%, paused queues, and local anonymous policy before the isolated runner calls `https://api.hereisit.app` through the apex web build.

- [ ] **Step 7: Admit public processing only after the custom-domain canary passes**

  Let the existing admission workflow promote the exact canary to rollout 100%. Require anonymous policy/server execution, full public smoke, projected monthly cost ceiling `5000000` microusd, live cost-per-1000 ceiling `500000` microusd, primary queue resumed, DLQ paused, and fail-closed recovery evidence.

- [ ] **Step 8: Verify public URLs and compatibility paths**

  Check canonical/sitemap/robots/CSP on the apex, one-hop www redirect, custom API CORS/health/policy, legacy Pages availability, and legacy `workers.dev` health. Do not disable either legacy endpoint in this task.

- [ ] **Step 9: Clean up completed-task resources**

  Remove downloaded CI artifacts, stopped servers, temporary files, containers/volumes created by this task, the merged remote feature branch, local feature branch, and task worktree. Preserve unrelated worktrees and the clean primary checkout.

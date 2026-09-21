# Cloudflare Pages deployment

HereIsIt is deployed as a static Next.js export through Cloudflare Pages Git integration.
Pages serves static assets; image transformations, text/logo watermarking, and JSON formatting run
locally in the browser. Image compression defaults to a disclosed native server engine and offers
local processing as an explicit option. The processing API is deployed separately from Pages.

The official production web origin is `https://hereisit.app`; `https://www.hereisit.app` redirects to
the apex, and `https://api.hereisit.app` is the production processing API. The legacy Pages and
`workers.dev` origins remain available only for migration compatibility and recovery.

Public image compression uses the same-format native server engine only after the exact-SHA production
admission workflow passes. The UI discloses the upload before selection. Server availability failures
can fall back to local browser processing when the selected files and options are supported locally.

## Important choice

The production project is Git-integration-only: connect the GitHub repository from the Cloudflare
dashboard and publish only reviewed Git commits. Never create or use a Direct Upload project for
production, and never run `wrangler pages project create` or `wrangler pages deploy` for it.

## Local checks

Requirements: Node.js 24 LTS and pnpm 11.11.0.

~~~bash
pnpm install --frozen-lockfile
pnpm verify
pnpm cloudflare:preview
~~~

Use `pnpm verify:all` only when the local processing-stack check is also needed.

The GitHub Actions `browser` job is the authoritative browser release gate for the pull-request merge candidate.
It runs desktop and mobile Chromium, Firefox, and WebKit; routine local verification does not install or run
Playwright browsers.

The developer server (`pnpm dev`) and developer-facing Pages preview (`pnpm cloudflare:preview`) use
http://127.0.0.1:3000, one at a time. The Pages preview serves `apps/web/out` through the same Wrangler
runtime used for deployment and does not require a Cloudflare login.

Run automated browser checks in GitHub Actions. For an explicitly requested one-off local diagnosis,
the tracked browser smokes can target the developer-facing preview below; remove generated outputs
afterward. Do not install or run Playwright browsers as routine local verification.

~~~bash
node scripts/smoke-navigation.mjs http://127.0.0.1:3000
node scripts/smoke-image-watermark.mjs http://127.0.0.1:3000
~~~

Without an argument, each command targets https://hereisit.app. The navigation smoke checks six
release routes, exact security headers, catalog/header/search behavior, representative detail shells, and
read-only same-origin traffic. The image-watermark smoke creates a local 320×180 PNG, verifies the default
text settings and security headers, proves that processing starts no download or upload, then explicitly
downloads the exact PNG result. These local-processing smokes reject redirects, cross-origin uploads,
write-method, request-body, failed-request, and page-error activity.

CI browser checks use the separate non-interactive `preview:test` command on port 4173;
do not confuse it with the developer-facing `cloudflare:preview` default on port 3000:

~~~bash
pnpm --filter @hereisit/web preview:test
node scripts/smoke-navigation.mjs http://127.0.0.1:4173
node scripts/smoke-image-watermark.mjs http://127.0.0.1:4173
~~~

For a pull request, wait for Cloudflare's immutable preview for the exact HEAD SHA and repeat both
commands against that HTTPS origin:

~~~bash
CLOUDFLARE_PREVIEW_ORIGIN="https://<immutable-preview>.pages.dev"
node scripts/smoke-navigation.mjs "$CLOUDFLARE_PREVIEW_ORIGIN"
node scripts/smoke-image-watermark.mjs "$CLOUDFLARE_PREVIEW_ORIGIN"
~~~

## Release evidence record

For the local release preview, immutable Cloudflare preview, and production deployment, record the target
origin, exact Git SHA, full command, and exit code for every smoke. Record manual VoiceOver/Safari and
NVDA/Firefox-or-Chrome results from the
[discovery accessibility checklist](testing/discovery-accessibility-checklist.md) separately. When the
required platform or assistive technology is unavailable, write `not run` and the reason; automated tests
are not manual-pass evidence. Never include selected filenames, file contents, thumbnails, object URLs,
preference values, or other file-derived data in release evidence.

Server-processing staging deploys automatically after a successful `main` CI push. See the
[processing staging deployment guide](deployment/processing-staging-bootstrap.md). Production uses the
same push-based path with a protected GitHub environment approval after its resources are provisioned.

Optional account commands:

~~~bash
pnpm cloudflare:whoami
pnpm cloudflare:login
~~~

The login command opens Cloudflare OAuth. It is not required for dashboard Git deployment.

## Create the project

1. Open https://dash.cloudflare.com/ and select Workers & Pages.
2. Choose Create application, Pages, then Connect to Git.
3. Authorize the GitHub application for liorium/hereisit. Repository-only access is preferred.
4. Select liorium/hereisit and use these build settings:

| Field | Value |
| --- | --- |
| Project name | hereisit |
| Production branch | main |
| Framework preset | Next.js (Static HTML Export) |
| Root directory | leave blank |
| Build command | pnpm --filter @hereisit/web build |
| Build output directory | apps/web/out |
| Build system version | 3 |

Add the following variables to both Production and Preview builds:

| Variable | Value |
| --- | --- |
| NODE_VERSION | 24.13.0 |
| PNPM_VERSION | 11.11.0 |
| NEXT_TELEMETRY_DISABLED | 1 |

Enable build cache, save the project, and start the first deployment. The Pages Git integration needs no
deploy API token, account ID, or GitHub Actions deployment workflow. Server image compression uses the
separately provisioned processing stack.

## First-deploy checks

- The generated pages.dev URL loads over HTTPS.
- The response includes the security headers from apps/web/public/_headers.
- Sample images convert to WebP and download as a ZIP.
- `/image/watermark` returns HTTP 200 and loads its dedicated Worker without any unrelated image
  Worker bundle. A local 320×180 PNG receives the default `© HereIsIt` bottom-right watermark without an
  upload or automatic download, then downloads as `source-watermarked-hereisit.png` only on request. A
  JPG/PNG/WebP logo can also be selected once, reused across a multi-image batch, and downloaded only on
  request.
- Local-processing tools make no upload or write requests. Image compression discloses its temporary
  server upload, provides an explicit local option, and cleans server artifacts after use.
- A pull request receives its own preview URL and deployment status check.

The Pages project must list `hereisit.app` as an active custom domain before a production release. The
production Worker must likewise retain the active `api.hereisit.app` custom domain; do not replace either
with a proxy or disable the legacy compatibility origins in the same release.

For a production release, run both tracked smokes only after the current GitHub CI and Cloudflare
Pages production deployment have succeeded for the exact merge SHA:

~~~bash
node scripts/smoke-navigation.mjs https://hereisit.app
node scripts/smoke-image-watermark.mjs https://hereisit.app
~~~

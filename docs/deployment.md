# Cloudflare Pages deployment

HereItIs is deployed as a static Next.js export through Cloudflare Pages Git integration. Image
processing, PDF page organization, rasterized text watermarking, and PDF-page-to-image rendering remain in
the browser; Pages serves only versioned static assets. The PDF image renderer uses self-hosted PDF.js
6.1.200 parser Worker, CMap, and standard-font files, with no CDN, WASM, upload, or server fallback. The site
does not use a server-side PDF processor or claim general PDF compression.

## Important choice

Connect the repository from the Cloudflare dashboard before using any Wrangler upload command.
A Pages project created with Direct Upload cannot later switch to Git integration. Do not run
wrangler pages project create or wrangler pages deploy for the production project.

## Local checks

Requirements: Node.js 24 LTS and pnpm 11.11.0.

~~~bash
pnpm install --frozen-lockfile
pnpm verify:all
pnpm cloudflare:preview
~~~

The preview is available at http://127.0.0.1:3000 and serves apps/web/out through the same
Wrangler Pages runtime used for deployment. Local preview does not require a Cloudflare login.

After the preview starts, the tracked PDF-to-image smoke command can target it explicitly:

~~~bash
node scripts/smoke-pdf-to-images.mjs http://127.0.0.1:3000
~~~

Without an argument, the command targets https://hereisit.pages.dev. It checks the route and the pinned
parser Worker, one packed CMap, and one standard font; verifies the current security headers; then performs
one rotated-page PNG/96DPI direct download and one two-page default JPG/150DPI ordered ZIP. It also rejects
cross-origin, write-method, request-body, failed-request, and page-error activity.

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

Enable build cache, save the project, and start the first deployment. No API token, account ID,
GitHub Actions deploy workflow, or server runtime is required.

## First-deploy checks

- The generated pages.dev URL loads over HTTPS.
- The response includes the security headers from apps/web/public/_headers.
- A sample image converts to WebP and downloads as a ZIP.
- Two sample PDFs merge in order, a PDF splits into a ZIP, and JPG/PNG images download as one PDF.
- A three-page PDF can be reordered, quarter-turned, and reduced to selected pages in one organized PDF.
- A text watermark can be placed locally and the downloaded result opens as a PDF with the same page
  count.
- `/pdf/to-image` and the versioned PDF.js parser Worker, packed CMaps, and standard fonts return HTTP 200
  from the same origin with the current CSP and other security headers.
- A two-page PDF with a rotated second page can select page 2 and download a 1056×816 PNG at 96DPI.
- A two-page 612×792pt PDF downloads an ordered two-entry JPG ZIP whose images are 1275×1650 at the default
  150DPI and quality 85.
- Browser network activity contains no external upload or write request.
- A pull request receives its own preview URL and deployment status check.

After these pass, add a custom domain from the Pages project Custom domains screen if desired.
Cloudflare provisions the TLS certificate automatically after DNS validation.

For a production release, run the tracked smoke only after the current GitHub CI and Cloudflare Pages checks
have succeeded for the exact release commit:

~~~bash
node scripts/smoke-pdf-to-images.mjs https://hereisit.pages.dev
~~~

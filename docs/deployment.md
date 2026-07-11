# Cloudflare Pages deployment

HereItIs is deployed as a static Next.js export through Cloudflare Pages Git integration. Image and PDF
processing remain in the browser; Pages serves only versioned static assets.

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
- Browser network activity contains no external upload or write request.
- A pull request receives its own preview URL and deployment status check.

After these pass, add a custom domain from the Pages project Custom domains screen if desired.
Cloudflare provisions the TLS certificate automatically after DNS validation.

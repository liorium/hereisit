# Playwright CI Centralization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run HereIsIt's complete Playwright browser matrix only in GitHub Actions and remove the local WebKit Docker path without losing browser coverage or failure evidence.

**Architecture:** Reuse the existing GitHub Actions `browser` job and Playwright configuration. A single `test:e2e:ci` package script runs two sequential browser groups in the hosted runner; a small shell status aggregation guarantees that WebKit still runs after an earlier browser failure. Local commands retain non-browser verification only.

**Tech Stack:** pnpm 11.11.0, Playwright 1.62.1, Vitest 4.1.10, GitHub Actions `ubuntu-24.04`, TypeScript 6.0.3

## Global Constraints

- Automated Playwright E2E runs in GitHub Actions only; local Playwright is reserved for an explicitly requested one-off diagnosis.
- Keep Chromium, Firefox, WebKit, mobile Chromium, mobile Firefox, and mobile WebKit coverage.
- Run the WebKit group with exactly one worker.
- Do not add a dependency, wrapper service, self-hosted runner, or new workflow.
- Keep failure artifacts limited to `test-results/` and `playwright-report/`, uploaded only on failure for 7 days.
- Never log file contents, filenames, thumbnails, or presigned URLs.
- Preserve `pnpm verify` and the existing image-engine, processing-stack, build, deployment, and product-analytics behavior.
- Do not delete `~/.cache/ms-playwright`; Chrome DevTools MCP currently uses a browser executable from that shared cache.
- Remove completed temporary outputs and worktrees after merge; retain an item only with a stated active-work, reproducibility, deployment, or audit reason.

---

### Task 1: Replace the WebKit Docker path with the hosted browser matrix

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `package.json`
- Modify: `playwright.config.ts`
- Delete: `scripts/test-playwright-webkit-container.mjs`
- Replace: `tests/playwright-webkit-container.test.ts` → `tests/playwright-ci-workflow.test.ts`

**Interfaces:**
- Consumes: existing `browser` job, Playwright project names, `pnpm --filter @hereisit/web build`
- Produces: package script `test:e2e:ci`, CI-only WebKit inclusion, one hosted browser test step that returns exit code 1 when either browser group fails

- [ ] **Step 1: Rename the obsolete container test and replace it with the failing CI contract test**

Run:

```bash
git mv tests/playwright-webkit-container.test.ts tests/playwright-ci-workflow.test.ts
```

Replace `tests/playwright-ci-workflow.test.ts` with:

```ts
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
const config = readFileSync("playwright.config.ts", "utf8");

describe("Playwright CI workflow", () => {
  it("runs all browser projects on the hosted runner without Docker", () => {
    expect(manifest.scripts["test:e2e:ci"]).toBe("playwright test");
    expect(manifest.scripts["verify:all"]).toBe(
      "pnpm verify && pnpm test:processing-stack",
    );
    expect(manifest.scripts).not.toHaveProperty("test:e2e");
    expect(manifest.scripts).not.toHaveProperty("test:e2e:ui");
    expect(manifest.scripts).not.toHaveProperty("test:e2e:webkit");

    expect(workflow).toContain(
      "pnpm exec playwright install --with-deps chromium firefox webkit",
    );
    for (const project of [
      "chromium",
      "firefox",
      "mobile-chromium",
      "mobile-firefox",
      "webkit",
      "mobile-webkit",
    ]) {
      expect(workflow).toContain(`--project=${project}`);
    }
    expect(workflow).toContain("--workers=1");
    expect(workflow).toContain("--output=test-results/primary");
    expect(workflow).toContain("--output=test-results/webkit");
    expect(workflow).toContain("PLAYWRIGHT_HTML_OUTPUT_DIR=playwright-report/primary");
    expect(workflow).toContain("PLAYWRIGHT_HTML_OUTPUT_DIR=playwright-report/webkit");
    expect(workflow).not.toContain("pnpm test:e2e:webkit");
    expect(workflow).not.toContain("test-playwright-webkit-container");
    expect(existsSync("scripts/test-playwright-webkit-container.mjs")).toBe(false);
  });

  it("attempts WebKit after the first browser group and combines both statuses", () => {
    const firstGroup = workflow.indexOf("--project=mobile-firefox");
    const firstStatus = workflow.indexOf("primary_status=$?", firstGroup);
    const webkitGroup = workflow.indexOf("--project=webkit", firstStatus);
    const webkitStatus = workflow.indexOf("webkit_status=$?", webkitGroup);
    const combinedExit = workflow.indexOf(
      "if (( primary_status != 0 || webkit_status != 0 )); then",
      webkitStatus,
    );

    expect(workflow).toContain("set +e");
    expect(firstGroup).toBeGreaterThan(-1);
    expect(firstStatus).toBeGreaterThan(firstGroup);
    expect(webkitGroup).toBeGreaterThan(firstStatus);
    expect(webkitStatus).toBeGreaterThan(webkitGroup);
    expect(combinedExit).toBeGreaterThan(webkitStatus);
  });

  it("includes WebKit only in CI and uses the normal preview server", () => {
    expect(config).toContain("const includeWebKit = isCI;");
    expect(config).not.toContain("PLAYWRIGHT_WEBKIT");
    expect(config).not.toContain("PLAYWRIGHT_CONTAINER");
    expect(config).toContain('command: "pnpm --filter @hereisit/web preview:test"');
    expect(config).toContain('["html", { open: "never" }]');
  });
});
```

- [ ] **Step 2: Run the contract test and confirm the old structure fails it**

Run:

```bash
pnpm vitest run tests/playwright-ci-workflow.test.ts
```

Expected: FAIL because `test:e2e:ci` is absent, the workflow does not install native WebKit, the Docker script still exists, and the configuration still reads the two container flags.

- [ ] **Step 3: Reduce the package scripts to one CI browser entry point**

In `package.json`, replace the four browser-related scripts with:

```json
"test:e2e:ci": "playwright test",
"verify:all": "pnpm verify && pnpm test:processing-stack"
```

Do not modify dependencies or `pnpm-lock.yaml`.

- [ ] **Step 4: Make WebKit a native CI project and remove the container preview branch**

At the top of `playwright.config.ts`, keep:

```ts
const isCI = Boolean(process.env.CI);
const includeWebKit = isCI;
```

Delete `isContainer` and both `biome-ignore` comments for `PLAYWRIGHT_WEBKIT` and `PLAYWRIGHT_CONTAINER`. Replace the `webServer` value with:

```ts
webServer: {
  command: "pnpm --filter @hereisit/web preview:test",
  url: "http://127.0.0.1:4173",
  reuseExistingServer: false,
  timeout: 120_000,
},
```

Replace the CI reporter line with the built-in GitHub and HTML reporters while keeping the local list reporter:

```ts
reporter: isCI
  ? [
      ["github"],
      ["html", { open: "never" }],
    ]
  : "list",
```

Keep all six existing project definitions, retry behavior, screenshots, traces, and test matching unchanged.

- [ ] **Step 5: Run both browser groups in the existing GitHub job and aggregate failures**

In `.github/workflows/ci.yml`, replace the browser install and first two browser run steps with:

```yaml
      - run: pnpm exec playwright install --with-deps chromium firefox webkit
      - name: Test browser matrix
        run: |
          set +e
          PLAYWRIGHT_HTML_OUTPUT_DIR=playwright-report/primary \
            pnpm test:e2e:ci -- \
            --project=chromium \
            --project=firefox \
            --project=mobile-chromium \
            --project=mobile-firefox \
            --output=test-results/primary
          primary_status=$?
          PLAYWRIGHT_HTML_OUTPUT_DIR=playwright-report/webkit \
            pnpm test:e2e:ci -- \
            --project=webkit \
            --project=mobile-webkit \
            --workers=1 \
            --output=test-results/webkit
          webkit_status=$?
          if (( primary_status != 0 || webkit_status != 0 )); then
            exit 1
          fi
```

In the existing `Test product analytics` step, replace `pnpm exec playwright test` with `pnpm test:e2e:ci --`. Preserve its test paths, `--project=chromium`, grep, environment, rebuild, artifact upload, pull-request condition, timeout, and concurrency settings.

- [ ] **Step 6: Delete the obsolete Docker runner**

Run:

```bash
git rm scripts/test-playwright-webkit-container.mjs
```

- [ ] **Step 7: Run focused verification**

Run:

```bash
pnpm vitest run tests/playwright-ci-workflow.test.ts
pnpm lint
pnpm typecheck
git diff --check
```

Expected: the new test passes, lint and typecheck pass, and `git diff --check` prints nothing.

- [ ] **Step 8: Commit the hosted browser matrix**

Run:

```bash
git add .github/workflows/ci.yml package.json playwright.config.ts tests/playwright-ci-workflow.test.ts
git commit -m "ci: run Playwright browsers on GitHub"
```

Expected: the commit includes the renamed test and deleted Docker script, with no `pnpm-lock.yaml` change.

---

### Task 2: Make current developer guidance match the CI-only policy

**Files:**
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `docs/deployment.md`
- Modify: `docs/testing/discovery-accessibility-checklist.md`
- Modify: `tests/playwright-ci-workflow.test.ts`

**Interfaces:**
- Consumes: `pnpm verify`, `pnpm verify:all`, GitHub Actions `browser` job from Task 1
- Produces: one current, unambiguous verification policy; historical specs and completed plans remain unchanged

- [ ] **Step 1: Add a failing documentation-policy test**

Append this test inside the existing `describe` block in `tests/playwright-ci-workflow.test.ts`:

```ts
  it("documents Playwright as CI-only routine verification", () => {
    const agents = readFileSync("AGENTS.md", "utf8");
    const readme = readFileSync("README.md", "utf8");
    const deployment = readFileSync("docs/deployment.md", "utf8");
    const checklist = readFileSync(
      "docs/testing/discovery-accessibility-checklist.md",
      "utf8",
    );

    expect(agents).toContain("Automated Playwright E2E runs in GitHub Actions only.");
    expect(agents).toContain(
      "`pnpm verify:all` — run core verification and the local processing-stack test.",
    );
    for (const document of [readme, deployment, checklist]) {
      expect(document).toContain("GitHub Actions `browser` job");
      expect(document).not.toContain("PLAYWRIGHT_WEBKIT=1");
    }
    expect(readme).not.toContain("pnpm exec playwright install --with-deps");
    expect(deployment).not.toContain("pnpm exec playwright install --with-deps");
  });
```

- [ ] **Step 2: Run the documentation-policy test and confirm it fails**

Run:

```bash
pnpm vitest run tests/playwright-ci-workflow.test.ts -t "documents Playwright"
```

Expected: FAIL because current guidance still recommends local browser installation and `PLAYWRIGHT_WEBKIT=1`.

- [ ] **Step 3: Update the engineering guide**

In `AGENTS.md`, replace the `verify:all` command description with:

```markdown
- `pnpm verify:all` — run core verification and the local processing-stack test.
```

Add these lines under `## Verification`:

```markdown
- Automated Playwright E2E runs in GitHub Actions only. Do not install or run Playwright browsers locally for routine verification.
- Use local Playwright only for an explicitly requested one-off diagnosis, and remove its generated outputs afterward.
```

- [ ] **Step 4: Replace current local browser instructions with the CI contract**

In `README.md`, keep the description of browser coverage but replace all local browser installation, `test:e2e`, `verify:all` browser, and `PLAYWRIGHT_WEBKIT` examples with:

```markdown
The GitHub Actions `browser` job runs the complete automated Playwright matrix for every pull request:
desktop and mobile Chromium, Firefox, and WebKit. It installs browsers on the hosted runner, keeps WebKit
on one worker, and uploads screenshots, traces, and the HTML report only when the job fails. Routine local
verification is `pnpm verify`; use `pnpm verify:all` only when the local processing-stack test is also needed.
```

In `docs/deployment.md`, change `## Local checks` so its command block contains only:

```bash
pnpm install --frozen-lockfile
pnpm verify
pnpm verify:all
pnpm cloudflare:preview
```

Immediately after it, use:

```markdown
The GitHub Actions `browser` job is the authoritative browser release gate for the exact pull-request SHA.
It runs desktop and mobile Chromium, Firefox, and WebKit; routine local verification does not install or run
Playwright browsers.
```

Remove the outdated host-WebKit exception paragraph. In `docs/testing/discovery-accessibility-checklist.md`, replace the release sentence containing local `pnpm verify:all` browser execution with a sentence that contains exactly `GitHub Actions \`browser\` job` and directs browser coverage there.

Do not rewrite historical files below `docs/superpowers/specs/` or `docs/superpowers/plans/`.

- [ ] **Step 5: Run focused documentation verification**

Run:

```bash
pnpm vitest run tests/playwright-ci-workflow.test.ts
pnpm lint
git diff --check
```

Expected: the four CI contract tests pass, lint passes, and `git diff --check` prints nothing.

- [ ] **Step 6: Commit the policy documentation**

Run:

```bash
git add AGENTS.md README.md docs/deployment.md docs/testing/discovery-accessibility-checklist.md tests/playwright-ci-workflow.test.ts
git commit -m "docs: make browser verification CI-only"
```

---

### Task 3: Verify, publish, protect main, and clean local resources

**Files:**
- Verify only: all tracked files in the implementation branch
- Delete after completion: local `test-results/`, `playwright-report/`, completed temporary worktree
- Preserve: `/home/ubuntu/.cache/ms-playwright`

**Interfaces:**
- Consumes: Task 1 and Task 2 commits, GitHub repository `liorium/hereisit`, CI checks `verify` and `browser`
- Produces: merged CI-only Playwright workflow, protected `main`, no disposable local test resources

- [ ] **Step 1: Run complete browser-free local verification**

Run:

```bash
pnpm verify
pnpm test:processing-stack
git diff --check
git status --short
```

Expected: both commands pass, `git diff --check` prints nothing, and status contains no uncommitted files. Do not run Playwright locally.

- [ ] **Step 2: Inspect the final branch before publication**

Run:

```bash
git diff --stat origin/main...HEAD
git diff --name-status origin/main...HEAD
rg -n "test:e2e:webkit|test-playwright-webkit-container|PLAYWRIGHT_(WEBKIT|CONTAINER)" \
  .github AGENTS.md README.md docs/deployment.md docs/testing package.json playwright.config.ts scripts tests
```

Expected: only the approved spec, plan, CI/config/package/test files, and four current guidance files changed. The final `rg` returns no matches.

- [ ] **Step 3: Publish a pull request**

Run:

```bash
git push -u origin docs/playwright-ci-centralization
gh pr create \
  --repo liorium/hereisit \
  --base main \
  --head docs/playwright-ci-centralization \
  --title "Run Playwright browsers only in GitHub Actions" \
  --body "Centralizes Chromium, Firefox, and WebKit E2E on the hosted runner, removes the local WebKit Docker path, and updates verification guidance."
```

Record the returned PR URL.

- [ ] **Step 4: Wait for the authoritative hosted checks**

Run:

```bash
gh pr checks --repo liorium/hereisit --watch --fail-fast=false
```

Expected: `verify` and `browser` both pass. In the browser log, confirm native installation lists Chromium, Firefox, and WebKit; both browser groups execute; WebKit reports one worker; failure artifacts are skipped on success.

If a check fails, inspect only that run with `gh run view --log-failed`, fix the root cause, rerun focused local non-browser tests, push the fix, and repeat this step. Do not merge a failing or skipped browser job.

- [ ] **Step 5: Require the two CI checks on main**

The repository currently reports `Branch not protected`. After the PR checks exist and pass, run:

```bash
gh api --method PUT repos/liorium/hereisit/branches/main/protection --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["verify", "browser"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "required_conversation_resolution": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": false,
  "required_linear_history": false,
  "lock_branch": false,
  "allow_fork_syncing": true
}
JSON

gh api repos/liorium/hereisit/branches/main/protection \
  --jq '{contexts: .required_status_checks.contexts, strict: .required_status_checks.strict, enforce_admins: .enforce_admins.enabled}'
```

Expected:

```json
{"contexts":["verify","browser"],"strict":true,"enforce_admins":true}
```

- [ ] **Step 6: Merge the verified pull request and verify main**

Run:

```bash
pr_number=$(gh pr view --repo liorium/hereisit --json number --jq .number)
gh pr merge --repo liorium/hereisit --squash --delete-branch
merge_sha=$(gh pr view "$pr_number" --repo liorium/hereisit --json mergeCommit --jq .mergeCommit.oid)
main_run_id=""
for attempt in {1..12}; do
  main_run_id=$(gh run list --repo liorium/hereisit --workflow CI --commit "$merge_sha" \
    --event push --limit 1 --json databaseId --jq '.[0].databaseId // empty')
  [[ -n "$main_run_id" ]] && break
  sleep 5
done
test -n "$main_run_id"
gh run watch "$main_run_id" --repo liorium/hereisit --exit-status
gh run view "$main_run_id" --repo liorium/hereisit --json jobs \
  --jq '.jobs[] | {name, conclusion}'
```

Expected: the PR is merged, the main `verify` job passes, the `browser` job is skipped on the push event by design, and the existing Cloudflare/processing workflows retain their prior behavior.

- [ ] **Step 7: Clean only disposable local resources**

From `/home/ubuntu/workspace/projects/hereisit`, run:

```bash
rm -rf test-results playwright-report
docker ps -a --filter ancestor=mcr.microsoft.com/playwright:v1.62.1-noble \
  --format '{{.ID}} {{.Status}} {{.Names}}'
docker image inspect mcr.microsoft.com/playwright:v1.62.1-noble >/dev/null 2>&1 \
  && docker image rm mcr.microsoft.com/playwright:v1.62.1-noble \
  || true
git worktree remove /tmp/hereisit-playwright-ci-design
git branch -D docs/playwright-ci-centralization 2>/dev/null || true
git worktree prune
```

Expected: no Playwright container or Docker image remains, and the completed temporary worktree and local task branch are gone. Preserve `/home/ubuntu/.cache/ms-playwright` because active Chrome DevTools MCP processes reference that shared cache.

- [ ] **Step 8: Record the closeout evidence**

Run:

```bash
git worktree list
docker image ls --format '{{.Repository}}:{{.Tag}} {{.Size}}' | rg 'playwright' || true
du -sh /home/ubuntu/.cache/ms-playwright
gh api repos/liorium/hereisit/branches/main/protection --jq '.required_status_checks.contexts'
```

Expected: the temporary worktree is absent, no Playwright Docker image is listed, the intentionally preserved shared cache is reported, and GitHub returns `verify` and `browser` as required checks.

## Implementation corrections

Actual package-script invocations omit the literal separator. The corrected primary, WebKit, and analytics
examples are:

```bash
PLAYWRIGHT_HTML_OUTPUT_DIR=playwright-report/primary pnpm test:e2e:ci \
  --project=chromium --project=firefox --project=mobile-chromium --project=mobile-firefox \
  --output=test-results/primary
PLAYWRIGHT_HTML_OUTPUT_DIR=playwright-report/webkit pnpm test:e2e:ci \
  --project=webkit --project=mobile-webkit --workers=1 --output=test-results/webkit
HEREISIT_E2E_PRODUCT_ANALYTICS=1 pnpm test:e2e:ci \
  tests/e2e/product-analytics.spec.ts tests/e2e/image-workbench.spec.ts tests/e2e/pdf-tools.spec.ts \
  --project=chromium --grep analytics
```

Legacy-reference inspection excludes `tests/playwright-ci-workflow.test.ts` because it intentionally contains
negative assertions:

```bash
rg -n 'pnpm test:e2e:ci|PLAYWRIGHT_WEBKIT|pnpm exec playwright test' \
  --glob '!tests/playwright-ci-workflow.test.ts'
```

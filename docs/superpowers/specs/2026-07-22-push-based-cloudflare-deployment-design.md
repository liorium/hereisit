# Push-based Cloudflare deployment

## Goal

Deploy HereIsIt from GitHub without an offline signing ceremony or a separate release-tag workflow.
The Git commit that passes CI is the deployment identity.

## Flow

- Pull requests and non-`main` pushes run CI and preview checks only.
- A successful CI run for a push to `main` automatically starts the processing staging deployment.
- The deploy workflow checks out the exact successful CI commit, builds from the locked repository, and
  deploys the Worker, Container image, and staging Pages tree.
- Any build, validation, deployment, queue-state, or smoke-test failure fails closed. The existing
  cleanup pauses the primary queue after a failed delivery attempt; the DLQ is never resumed.
- Production will reuse this push-triggered pattern when its Cloudflare resources and GitHub
  environment exist, with GitHub environment approval as the only manual gate.

## Security retained

- Cloudflare credentials remain GitHub environment secrets and are never available to pull requests.
- Deployment is repository-, branch-, successful-CI-, and exact-commit-bound.
- Dependencies and GitHub Actions remain pinned; Wrangler deploys from generated staging config.
- Resource validation, immutable container digest resolution, queue checks, and authenticated smoke
  testing remain required before success.

## Removed

- Manual `workflow_dispatch` build/deploy modes.
- Annotated release tags and release-input-only commits.
- Offline Ed25519 signing, finalized GitHub Release candidates, and signature verification.
- Same-run candidate handoff machinery that existed only to bridge the manual signing gap.

## Verification

Repository tests assert the trigger and exact-commit gates, absence of signing requirements, secret
isolation, fail-closed queue cleanup, and staging smoke order. The workflow must pass repository lint,
type checking, unit tests, and GitHub Actions validation before merge.

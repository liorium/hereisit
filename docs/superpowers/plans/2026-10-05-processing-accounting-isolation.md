# Processing Accounting Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 공급자 통계 장애가 이미지 압축을 일괄 차단하지 않게 하되, 기존 자원 제한과 안전 차단을 보존한다.

**Architecture:** 집계 건강 상태를 안전 회로와 분리하고 기존 D1 예약·정산은 재사용한다. 기존 시간별 비용과 이메일 바인딩을 실제 판정·알림에 연결한다. 프로덕션 전환은 활성 릴리스와 안전 증거를 재검증하는 조건부 작업으로 수행한다.

**Tech Stack:** TypeScript, Zod, Cloudflare Workers/D1/R2/Containers, Vitest, GitHub Actions; 새 의존성 없음.

**Spec:** `docs/superpowers/specs/2026-10-05-processing-accounting-isolation-design.md`

## Global Constraints

- 승인된 기준: 문서 커밋 `a81a799`, 운영 코드 기준 `7867a35`. 실행 시작 시 Git 상태·지침을 다시 확인한다.
- 무료 도구·서버 전송 고지·명시적 로컬 선택을 유지한다. PDF·결제·새 엔진·토큰·권한 확대는 제외한다.
- 기존 일일 단위·대기 수·재시도·속도·컨테이너·시간·메모리 한도 수치를 올리지 않는다.
- 유지관리 `5분`, 집계 경고는 대상 시간 종료 후 `1시간`, 장애 재알림 `24시간`.
- 비용 판정: 같은 epoch·릴리스·모델의 연속 확정 `24시간`; 마지막 시간 종료가 현재보다 과거이고 `2시간 이내`.
- 비용 합 `C`, 입장 수 `N`: 월 추정 `C × 30`, 건당 환산 `ceil(C × 1000 / N)`; `N=0`이면 건당 값은 `null`.
- 미확정은 0원·정상이 아니다. 기존 비용 차단은 자동 복구하지 않는다. 월 5달러 청구 보장을 주장하지 않는다.
- 사용자 파일명·내용·토큰·서명 URL·공급자 응답 본문을 로그/메일/산출물에 남기지 않는다.
- Playwright E2E는 GitHub Actions에서만 실행한다. 새 보안 예외나 릴리스 증명 우회는 없다.
- Node 24 및 잠긴 pnpm 의존성을 사용한다. 각 작업은 실패 테스트 → 최소 구현 → 통과 확인 → 범위 한정 커밋 순서다.
- 모든 개발 커밋에 `[CF-Pages-Skip]`을 붙인다. 푸시 전 자동 배포 트리거와 보호 환경을 확인한다.

## Review Focus

- 조회 오류 뒤 도착한 심각한 사고가 최초 사유에 가려지지 않아야 한다: Task 1의 사유 우선순위, Task 5의 전환 경쟁 테스트.
- HTTP 헤더는 왔지만 본문이 끝나지 않는 응답도 제한 시간 안에 종료돼야 한다: Task 2의 stalled-body 테스트.
- 오래된 유지관리 실행이나 epoch 초기화가 최신 경고를 지우면 안 된다: Task 1의 stale-write, Task 5의 epoch 전환 테스트.
- 메일 발송 후 DB 기록 실패는 제한된 중복으로 끝나야 하며 압축을 막으면 안 된다: Task 4의 lease/retry 테스트.
- 비용 표본에 미래 시각·중복 시간·다른 릴리스·0건이 섞이면 정확한 판정으로 표시하면 안 된다: Task 3의 window-validation 테스트.

## File Map

- `apps/api-worker/migrations/0011_accounting_health.sql`: 집계 단일 행, 발송 예약, 전환 검증에 필요한 안전 상태 세대 번호.
- `apps/api-worker/src/accounting-health.ts`: 집계 상태의 검증된 읽기·조건부 갱신. 일반 상태 저장 프레임워크는 만들지 않는다.
- `apps/api-worker/src/provider-usage.ts`, `container-provider-usage.ts`, `cost-accounting-runtime.ts`, `cost-accounting-scheduler.ts`, `hourly-cost-sealer.ts`: 외부 장애 분류와 집계 실행.
- `apps/api-worker/src/circuit-breaker.ts` 및 아래 Task 1의 기존 작성자: 심각한 차단 사유 우선순위.
- `apps/api-worker/src/live-cost-guard.ts`: 순수 24시간 비용 계산과 D1 판정 적용.
- `apps/api-worker/src/accounting-alerts.ts`: 기존 이메일 바인딩을 사용하는 집계 알림.
- `apps/api-worker/src/sweeper.ts`, `cost-history-cleanup.ts`: 필수 안전 검사 순서와 제한된 이력 보존.
- `scripts/verify-processing-admission-state.mjs`, `rotate-staging-accounting-epoch.mjs` 및 기존 배포 workflow: 상태 분리와 조건부 전환.
- 테스트는 각 모듈 옆 `*.test.ts`, D1 동작은 `apps/api-worker/test/*.integration.test.ts`, 운영 스크립트는 `tests/`에 둔다.

작업은 위 경계를 따라 순차 실행한다. 별도 서비스·대시보드·범용 저장소·새 스케줄러는 만들지 않는다.

### Task 1: 집계 상태와 안전 사고를 별도로 보존

**Files:** Create `apps/api-worker/migrations/0011_accounting_health.sql`, `apps/api-worker/src/accounting-health.ts`, `apps/api-worker/test/accounting-health.integration.test.ts`.
Modify `apps/api-worker/src/{circuit-breaker,hourly-cost-sealer,usage-log-importer,usage-log-ledger,usage-log-observer,provider-usage-reconciler,container-provider-usage-reconciler,d1-job-repository}.ts` 및 대응 테스트.
Modify `scripts/verify-processing-admission-state.mjs`, `tests/verify-processing-admission-state.test.ts`의 운영자 차단 작성자.
Explicit migration lists: `apps/api-worker/src/d1-job-repository.test.ts`, `apps/api-worker/test/worker.integration.test.ts` 등 `rg '0010_usage_log_versions|0009_container_activity_identity'`로 찾은 목록만 갱신.

**Interfaces:**
- `AccountingHealth = { epoch: string; status: 'unknown'|'degraded'|'healthy'; reason: AccountingHealthReason|null; evaluatedAt: number; pendingHourKey: number|null; unresolvedSinceHourKey: number|null }`.
- `AccountingHealthReason = 'PROVIDER_UNAVAILABLE'|'PROVIDER_SAMPLED'|'ACCOUNTING_DELAY'|'HISTORICAL_GAP'|'SAFETY_CONFLICT'`.
- `readAccountingHealth(db: D1Database): Promise<AccountingHealth>`; `recordAccountingHealth(db: D1Database, next: AccountingHealth): Promise<'updated'|'stale'>`.
- Migration adds nonnegative `safety_generation` to `rollout_control`; every newly recorded hard safety event advances it. Migration never closes a circuit.

- [ ] Add tests `migration_keeps_open_circuit`, `stale_epoch_or_time_cannot_recover`, `hard_reason_replaces_legacy_incomplete`. Assert `circuit_open === 1` after migration; older writes return `stale`; deletion failure replaces `COST_ACCOUNTING_INCOMPLETE` and advances generation; another hard reason is not replaced by a soft warning.
- [ ] Run `pnpm --filter @hereisit/api-worker test:integration test/accounting-health.integration.test.ts`; observe the intended failure.
- [ ] Implement the singleton with strict SQL/Zod constraints, initialized from current control as `unknown`. Use epoch equality and monotonic evaluation time in conditional updates; equal-time conflicting outcomes must not overwrite. Preserve `unresolvedSinceHourKey` until the corresponding gap is actually verified, including across release changes.
- [ ] Update every hard writer found by `rg 'SET circuit_open|reason = CASE' apps/api-worker/src scripts`: only legacy incomplete may be replaced by a hard reason. Keep transactional writers inside their existing batch; do not add post-transaction writes. Prevent scheduled evaluation without a new signal from advancing generation indefinitely.
- [ ] Repeat focused integration tests and `pnpm exec vitest run apps/api-worker/src/circuit-breaker.test.ts apps/api-worker/src/d1-job-repository.test.ts tests/verify-processing-admission-state.test.ts`; require zero failures. Commit `fix: preserve safety incidents independently of accounting health`.

### Task 2: 외부 통계 장애를 안전 실패와 구분

**Files:** Modify `apps/api-worker/src/{provider-usage,container-provider-usage,cost-accounting-runtime,cost-accounting-scheduler,hourly-cost-sealer,sweeper,cost-history-cleanup}.ts` 및 대응 단위·통합 테스트.
Create `apps/api-worker/test/accounting-isolation.integration.test.ts`.

**Interfaces:**
- Export `ProviderUnavailableError` from `provider-usage.ts`, constructor `(code: 'HTTP'|'TRANSPORT'|'TIMEOUT'|'SAMPLED', httpStatus?: number)`, with readonly fields of those names; no response body/error cause attached.
- Existing provider function signatures and successful return values remain unchanged. `container-provider-usage.ts` reuses that error type.
- Existing schedule result `kind/hourKey` remains; scheduler no longer treats external incompleteness as `conflict`. Runtime records Task 1 state after the schedule finishes.

- [ ] Add provider tests with `expect(error).toMatchObject({code:'HTTP',httpStatus:403})`, valid sampled data yielding `code:'SAMPLED'`, invalid JSON/schema throwing a non-soft error, and a stalled response body timing out after **8,000 ms**. Use fake timers, not real sleeps.
- [ ] Run `pnpm exec vitest run apps/api-worker/src/provider-usage.test.ts apps/api-worker/src/container-provider-usage.test.ts apps/api-worker/src/cost-accounting-scheduler.test.ts`; verify the new expectations fail.
- [ ] Bound fetch **and body reads** using an abort signal and explicit reader cancellation. Classify only network operations and validated sampled envelopes as soft. Do not wrap validation, D1 access, stored configuration or active attestation in the transport catch. HTTP 200 GraphQL errors may be soft only for a validated provider error envelope; malformed/mixed contradictory data stays hard.
- [ ] Remove blanket catches from the runtime. Missing/invalid active attestation or corrupt D1 state opens a hard `ACCOUNTING_STATE_INVALID` circuit (when DB is available) and returns/throws a failure, never normal incompleteness. Distinguish an absent initial import cursor from a malformed stored cursor instead of coercing both to null. Change sealer deadline behavior only for absent/unconfirmed external usage; malformed stored rows and missing required local counters remain hard failures.
- [ ] In scheduled maintenance, run required deletion/queue/result checks before cost queries and ensure they are not skipped if cost work throws. Record `degraded` only at/after the 1-hour deadline; mark `healthy` only when all due hours and retained gaps are verified. Never close the safety circuit from health recovery.
- [ ] Bound cleanup using existing 7-day object-ledger and 35-day cost-history horizons, batches ≤128. Before removing unsealed evidence, persist `HISTORICAL_GAP` and its earliest hour. Limit old-row/object selection, refuse deleting an object spanning retained hours, and never advance `last_sealed_hour_key` due to cleanup. Preserve conflict evidence needed for admission revalidation; if that evidence cannot be retained compactly, stop that cleanup path instead of implying safety.
- [ ] Integration tests: expired 403 → `health.status === 'degraded'`, `circuit_open === 0`, eligible reservation succeeds; the same state plus deletion/verification failure → reservation rejected. Assert missing hours stay unsealed, orphan cleanup still runs, and retention keeps the gap marker. Run `pnpm --filter @hereisit/api-worker test:integration test/accounting-isolation.integration.test.ts test/hourly-cost-sealer.integration.test.ts test/cost-history-cleanup.integration.test.ts` and existing scheduler/sweeper unit tests; commit `fix: isolate provider accounting outages from processing admission`.

### Task 3: 설정돼 있던 비용 상한을 실제 판정에 연결

**Files:** Create `apps/api-worker/src/live-cost-guard.ts`, `apps/api-worker/src/live-cost-guard.test.ts`, `apps/api-worker/test/live-cost-guard.integration.test.ts`. Modify `apps/api-worker/src/sweeper.ts`.

**Interfaces:**
- `evaluateLiveCostWindow(input: { now: number; epoch: string; releaseReportSha256: string; liveCostModelSha256: string; maximumLiveCostPer1000Microusd: number; maximumProjectedMonthlyCostMicrousd: number; rows: readonly LiveCostHour[] }): LiveCostDecision`.
- `LiveCostHour = { hourKey: number; epoch: string; releaseReportSha256: string; liveCostModelSha256: string; complete: boolean; totalCostMicrousd: string; admittedJobs: string }`.
- `LiveCostDecision = {kind:'unavailable'} | {kind:'within-limit'|'breach'; endHourKey:number; costPer1000Microusd:string|null; projectedMonthlyCostMicrousd:string}`.
- `applyLiveCostGuard(db: D1Database, config: OperationalConfig, now: number): Promise<LiveCostDecision>` queries current epoch/window and applies the decision with epoch, hashes and end-hour predicates.

- [ ] Write `complete_window_boundary`, `zero_jobs`, `stale_duplicate_future_or_mixed_window`, `overflow_is_not_zero` tests. For `C=100000`, `N=1000`, assert projected `'3000000'`, per-1000 `'100000'`; equality is within-limit, a ceiling one unit lower is breach. `N=0` gives `null`, not division by zero or unavailable monthly cost.
- [ ] Run `pnpm exec vitest run apps/api-worker/src/live-cost-guard.test.ts`; verify failure before implementation.
- [ ] Implement integer-string validation and BigInt arithmetic with signed 64-bit storage bounds. Require exactly 24 distinct adjacent complete hours and the 2-hour freshness bound. Missing/stale evidence returns unavailable; corrupt/negative/overflowed values throw and take the hard safety path. Never include future hours or combine releases.
- [ ] Apply valid decisions to existing `last_cost_*` fields; breach opens `LIVE_COST_LIMIT_EXCEEDED` with Task 1 priority/generation rules. Duplicate/older windows are no-ops. Missing data keeps the last valid values but must be reported as currently unavailable. A safe decision never closes a prior circuit.
- [ ] Run pure tests plus `pnpm --filter @hereisit/api-worker test:integration test/live-cost-guard.integration.test.ts`; assert repeated window evaluated once, epoch race refused and prior circuit retained. Commit `fix: enforce configured ceilings on verified cost windows`.

### Task 4: 작은 알림 경로와 분리된 운영 보고

**Files:** Create `apps/api-worker/src/accounting-alerts.ts`, `apps/api-worker/src/accounting-alerts.test.ts`, `apps/api-worker/test/accounting-alerts.integration.test.ts`.
Modify Task 1 migration before first deployment to add alert lease/retry fields; modify `apps/api-worker/src/{env,sweeper}.ts`, `scripts/verify-processing-admission-state.mjs`, `tests/verify-processing-admission-state.test.ts` and preflight summaries in `.github/workflows/processing-{staging,production}-preflight.yml`.

**Interfaces:**
- `sendAccountingAlert(input: {db:D1Database; health:AccountingHealth; now:number; environment:'local'|'staging'|'production'; send:(message:{subject:string;text:string})=>Promise<void>}): Promise<'sent'|'not-due'|'failed'>`.
- Operational inspection adds `serviceAvailable:boolean`, `accountingHealthy:boolean`, `accountingReason:string|null`, `alertPending:boolean`. Existing public policy contract is unchanged; unavailable inspection is not serialized as healthy.

- [ ] Add tests `alert_on_degrade_and_recovery`, `daily_reminder`, `lease_excludes_concurrent_sender`, `send_then_record_failure`, `alert_failure_does_not_skip_safety`. Assert one claimed send in parallel; reminder absent at 24h−1ms and due at 24h; failed sends do not update `last_sent_at` or safety circuit.
- [ ] Run `pnpm exec vitest run apps/api-worker/src/accounting-alerts.test.ts`; confirm intended failure.
- [ ] Reuse `operational_alert_state`: a **5-minute** expiring lease, fixed kinds `accounting-degraded`/`accounting-recovered`, and a next-attempt timestamp. Send at most once per maintenance run; failed sends retry no sooner than the next 5-minute tick. On success finalize only the same lease/event; stale send completion cannot acknowledge a newer incident. Recovery is sent only after an actual degraded episode.
- [ ] Wire the existing `ALERT_EMAIL` binding using platform EmailMessage without a new MIME library; fixed UTF-8 text, validated addresses, no user-controlled headers. Before choosing sender configuration, check current official platform docs and the already verified project email setup. Reuse that setup; if no authorized sender exists, expose `alertPending` and report the specific missing setup instead of inventing an address or claiming delivery. No token creation.
- [ ] Serialize only allowlisted metadata into mail and preflight summaries. `serviceAvailable` reflects active release/safety/config eligibility (not a guarantee for every user's quota); `accountingHealthy` requires status `healthy`, matching epoch, no unresolved gap and `now - 15 minutes <= evaluatedAt <= now` (three existing maintenance ticks). Test stale/future timestamps as unhealthy. Keep public readiness monitor's existing meaning explicit.
- [ ] Run alert tests, `pnpm --filter @hereisit/api-worker test:integration test/accounting-alerts.integration.test.ts`, and existing admission-state tests; commit `feat: report accounting degradation without hiding service health`.

### Task 5: 오래된 차단의 안전한 전환과 배포 경로 통합

**Files:** Modify `scripts/{verify-processing-admission-state,rotate-staging-accounting-epoch,processing-admission-rollback-state}.mjs` and corresponding `tests/*.test.ts`.
Modify `.github/workflows/processing-{staging,production,image-admission}.yml` and `tests/processing-image-admission-workflow.test.ts`; keep `scripts/verify-worker-version-chain.mjs` rules, extend tests if evidence shape changes.

**Interfaces:**
- Add `rearmAccountingOnlyCircuitInD1({accountId,databaseId,apiToken,expectedVersionId,expectedReleaseReportSha256,expectedEpoch,expectedSafetyGeneration,now,fetchImpl}): Promise<{rearmed:true}>` in `verify-processing-admission-state.mjs`.
- Existing epoch rotator signatures remain. Rotation preserves safety state and unresolved-gap evidence; opening service is solely the explicit verified rearm/normal canary path, not an epoch reset side effect.

- [ ] Test `epoch_rotation_does_not_clear_safety`, `only_exact_incomplete_can_rearm`, `hard_incident_after_inspection`, `missing_evidence_is_not_safe`, `rollback_keeps_newer_hard_stop`. Assert HASH_MISMATCH/UNATTESTED_VERSION/OPERATOR_DISABLED never pass accounting-only rearm; a changed generation/version/epoch or active job/outbox causes zero changed rows and a failure.
- [ ] Run `pnpm exec vitest run tests/rotate-staging-accounting-epoch.test.ts tests/verify-processing-admission-state.test.ts tests/processing-admission-rollback-state.test.ts`; require expected failures.
- [ ] Remove the epoch rotator's broad `circuit_open=0, reason=NULL` reset. Carry an unresolved gap forward before pruning old epochs. Preserve diagnostics for the old release. Adapt callers rather than supplying fake complete evidence.
- [ ] Implement rearm as a guarded D1 batch while external deployment lock and closed admission are held. Recheck active attestation, exact version/report/epoch/generation, exact legacy reason, idle jobs/outbox, fresh deletion audit, queue timestamps, quota/ledger integrity and retained safety conflict evidence. Inspection artifact alone is not authorization. Missing historical evidence blocks rearm. Successful update touches only the legacy circuit fields and records the transition; it does not rotate epoch, reset counters, clear hard failures or mark health good.
- [ ] Keep production canary at 0% until smoke succeeds; no general-user bypass for a closed circuit. Reuse existing protected environment/concurrency and exact release artifacts. Do not use the rollout-only attestation transition for a Worker code change. Ensure old rollback snapshots cannot overwrite a newer safety generation or new hard reason.
- [ ] Repeat focused tests plus `pnpm exec vitest run tests/processing-image-admission-workflow.test.ts tests/verify-worker-version-chain.test.ts`; inspect all `circuit_open = 0` and `reason = NULL` writers for bypasses. Commit `fix: rearm only verified accounting-only admission blocks`.

### Task 6: 회귀 검증, 검토, 승인된 릴리스 경로로 배포

**Files:** Extend `apps/api-worker/test/accounting-isolation.integration.test.ts`, existing `apps/api-worker/src/{d1-job-repository,queue-consumer,sweeper}.test.ts`, and `packages/server-job/src/resource-estimate.test.ts` only for uncovered regressions. Update the spec's status with verified outcome; no speculative completion notes.

**Interfaces:** Consumes Tasks 1–5; produces test results, reviewed commit SHA, exact deployed Worker/release identity, separate service/accounting state and rollback result if needed.

- [ ] Pin existing protections: race two reservations at the remaining quota; replay/cancel/retry never erases minimum consumption; test UTC day boundary. Run the same cases under degraded health. Assert rejection where expected and unchanged public contract/server-upload notice.
- [ ] Run `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm test:worker`, `pnpm build`, `pnpm verify:export`, then the remaining `pnpm verify` checks. Record actual exit codes; missing native build prerequisites are blockers, not passes. Do not install/run local Playwright browsers.
- [ ] Request a fresh whole-branch code review using `superpowers:requesting-code-review`; fix material findings and rerun affected checks. This is the explicit review delegation step even if native execution was chosen. Preserve unrelated stash/worktrees.
- [ ] Push a `[CF-Pages-Skip]` branch and require GitHub `verify` + `browser` checks; do not bypass branch protection. Before merge, inspect current automatic release triggers and separate code merge from production promotion. Use the existing guarded CI/release path, not ad hoc Worker deployment.
- [ ] Run staging and protected production canary. Record fresh live version, exact image digest, migration state, safety state and provider status. Verify actual upload → compression → download → deletion, admission policy and email send/delivery evidence separately. Missing email setup/delivery proof stays explicitly incomplete.
- [ ] Publicly promote only when Task 5 and all existing release/security gates pass. If blocked by unresolved native security or unavailable safety evidence, leave production closed and state the exact blocker; do not add exceptions, clear history or claim restored service. On failure close admission and execute the existing rollback without clobbering newer safety events.
- [ ] After verified deployment, remove only task-owned temporary branch/worktree/test outputs no longer required for audit. Report deployed identity, tests, service availability, remaining accounting degradation and any unresolved alerts. Do not describe unresolved provider 403 as fixed.

## Self-review and handoff

- Spec coverage: state/priority → Tasks 1–2; quota/resource preservation → Tasks 2/6; cost → Task 3; alerts/reporting → Task 4; migration/canary/rollback → Task 5/6.
- Five Review Focus cases each have an owning test. All new names/signatures are defined above; no new public tool contract or dependency is planned.
- No runtime code, credentials, remote resources or deployments are changed by this document.
- **Recommended execution: Native.** The tasks share D1 state and deployment invariants; one implementer can preserve that context, followed by an independent whole-branch review. Subagent-driven execution remains available if the user prefers per-task independent review.
- Await user review of this plan and execution-method selection before implementation.

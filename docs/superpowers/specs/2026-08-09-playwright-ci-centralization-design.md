# Playwright CI centralization design

**Date:** 2026-08-09
**Status:** Approved for implementation

## 목적

Chromium, Firefox, WebKit 자동 브라우저 테스트를 GitHub Actions 한 곳에서 실행한다. 개발 서버는 앱 개발과
직접 화면 확인에만 사용하고, Playwright 브라우저 설치·실행과 WebKit Docker 컨테이너 비용은 부담하지 않는다.

## 목표

- 자동 Playwright E2E의 실행 위치를 GitHub Actions로 통일한다.
- Chromium, Firefox, WebKit과 모바일 프로젝트를 계속 검증한다.
- WebKit은 한 worker로 실행해 기존 안정성을 유지한다.
- 브라우저 하나가 실패해도 나머지 브라우저 결과까지 확인한다.
- 실패한 실행에서만 진단 자료를 짧게 보관한다.
- 완료 후 로컬 Playwright Docker 자원과 임시 작업물을 정리한다.

## 비목표

- E2E 시나리오, 제품 동작 또는 브라우저 지원 범위 변경
- 별도 테스트 서비스, 자체 runner 또는 새 의존성 도입
- `pnpm verify`에 포함된 단위·통합·빌드·이미지 엔진 검증 변경
- 로컬에서 Playwright 실행을 기술적으로 차단하는 별도 wrapper 개발
- 실제 장애를 조사하기 위한 일회성 로컬 브라우저 진단 금지

## 선택한 구조

GitHub Actions의 기존 `browser` job을 단일 자동 실행 위치로 사용한다. 해당 job의 `ubuntu-24.04` runner에
현재 설치된 Playwright 버전과 일치하는 Chromium, Firefox, WebKit을
`playwright install --with-deps`로 직접 설치한다. WebKit용 Docker 이미지와 컨테이너 실행기는 사용하지 않는다.

일반 Chromium·Firefox 프로젝트와 WebKit 프로젝트는 같은 job에서 순서대로 실행한다. WebKit 명령에는
`--workers=1`을 유지한다. 첫 실행이 실패해도 두 번째 실행을 계속하고, 하나라도 실패하면 job 전체를
실패로 끝낸다. 두 실행은 각각 `test-results/primary`, `test-results/webkit`과
`playwright-report/primary`, `playwright-report/webkit`에 결과를 남겨 뒤 실행이 앞선 실패 증거를 지우지
않게 한다. 내장 GitHub reporter와 HTML reporter를 함께 사용하며 새 의존성은 추가하지 않는다. 이 결과를
얻는 데 필요한 최소한의 셸 상태 집계만 workflow step 안에 둔다.

로컬 서버에서 지원하는 기본 흐름은 다음 두 가지다.

- `pnpm dev`: 개발 서버와 직접 화면 확인
- `pnpm verify`: Playwright를 제외한 기존 저장소 검증

자동 E2E는 CI 전용이라는 운영 원칙을 `AGENTS.md`에 명시한다. 장애 조사자가 명시적으로 필요로 할 때만
일회성 로컬 실행을 허용하며, 일상 검증이나 에이전트 완료 검증에는 사용하지 않는다. 별도 환경 감지 guard는
추가하지 않는다.

## 명령어 구조

패키지의 CI 진입점은 `pnpm test:e2e:ci` 하나로 통일하고 그 안에서는 기존 `playwright test`를 그대로
호출한다. workflow는 이 진입점에 프로젝트 선택 인자를 전달한다.

- 첫 실행: Chromium, Firefox, mobile Chromium, mobile Firefox
- 두 번째 실행: WebKit, mobile WebKit, `--workers=1`

기존 `test:e2e`, `test:e2e:ui`, `test:e2e:webkit` 스크립트는 제거한다. `verify:all`은 Playwright를 제외한
전체 로컬 검증인 `pnpm verify`와 `pnpm test:processing-stack`만 실행하도록 바꾸고, `AGENTS.md`의 명령 설명도
같이 수정한다.

Playwright 설정은 CI에서 WebKit 프로젝트를 포함한다. `PLAYWRIGHT_WEBKIT`과 `PLAYWRIGHT_CONTAINER` 환경
분기, 컨테이너용 `webServer` 명령과 작업 디렉터리는 제거하고 기존 로컬 preview 명령 하나만 유지한다.

## 실행 조건과 결과 처리

`browser` job은 기존처럼 pull request에서 `verify`가 통과한 뒤 실행한다. `main` 병합 뒤 같은 커밋의
브라우저 테스트를 다시 실행하지 않는다. 사용자는 GitHub의 기존 re-run 기능으로 실패하거나 취소된 PR 실행을
다시 시작할 수 있으므로 별도 수동 workflow는 추가하지 않는다.

동일 PR에 새 커밋이 올라오면 기존 `concurrency` 설정이 이전 실행을 취소한다. 모든 브라우저 검증이 끝난 뒤
하나라도 실패하면 `browser` job을 실패로 표시한다. 저장소의 branch protection에서는 이 job을 필수 상태
검사로 사용한다.

실패한 경우에만 기존 `test-results/`와 `playwright-report/`를 업로드하고 7일 뒤 삭제한다. 성공 실행은
브라우저 산출물을 보관하지 않는다. 테스트나 산출물에 실제 사용자 파일, 파일명, presigned URL을 기록하지
않는 기존 원칙을 유지한다.

## 로컬 자원 정리

구현과 CI 검증이 완료되면 다음 순서로 정리한다.

1. WebKit 컨테이너 실행 스크립트와 그 단위 테스트를 저장소에서 삭제한다.
2. 실행 중인 Playwright 컨테이너가 없는지 확인한다.
3. `mcr.microsoft.com/playwright:v1.62.1-noble` 이미지가 다른 작업에 사용되지 않는지 확인한 뒤 삭제한다.
4. `~/.cache/ms-playwright`는 agent-browser 등 다른 도구와 공유하지 않는 파일만 식별해 삭제한다.
5. 테스트 결과, 임시 서버와 완료된 임시 worktree를 제거한다.

다른 Docker 이미지, 공유 브라우저 캐시 또는 재현·감사에 필요한 결과는 삭제하지 않는다.

## 검증

- 정적 테스트에서 workflow가 Chromium, Firefox, WebKit을 직접 설치하고 Docker 실행기를 참조하지 않는지
  확인한다.
- 기존 공급망 정적 테스트에서 CI가 여섯 프로젝트를 선택하고 WebKit에 `--workers=1`을 전달하며,
  Playwright 설정이 단일 preview 명령만 사용하는지 확인한다.
- `pnpm verify`로 lint, typecheck, 단위·통합 테스트와 빌드를 검증한다.
- pull request의 `browser` job에서 데스크톱·모바일 Chromium, Firefox, WebKit 전체 결과를 확인한다.
- 의도적인 최소 실패 검증이나 workflow 구조 검증으로 첫 브라우저 그룹 실패 후 WebKit 실행이 생략되지
  않는지 확인한다.
- 실패 산출물은 실패 시에만 업로드되고 보존 기간이 7일인지 확인한다.

## 완료 기준

- 자동 Playwright E2E가 GitHub Actions에서만 실행된다.
- 지원하는 여섯 브라우저 프로젝트가 모두 검증된다.
- WebKit Docker 스크립트·설정·이미지가 남지 않는다.
- 브라우저별 실패를 한 CI 실행에서 모두 확인할 수 있다.
- `pnpm verify`와 CI 상태 검사가 통과한다.
- 로컬 서버에 Playwright 전용 컨테이너, 이미지, 임시 결과 또는 완료된 작업 worktree가 남지 않는다.

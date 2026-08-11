# HereIsIt 사용자 도메인 전환 설계

## 목표

Cloudflare에서 활성화된 `hereisit.app`을 HereIsIt의 공식 주소로 사용한다. 웹은
`https://hereisit.app`, 이미지 처리 API는 `https://api.hereisit.app`으로 분리한다. 현재
프로덕션 브라우저 canary가 Cloudflare의 공유 `workers.dev` 앞단에서 받는 비계약 429를 제거하고,
브랜드 주소와 프로덕션 처리 주소를 함께 확정한다.

파일 처리 방식, 코덱, 한도, 삭제 정책과 월 예상비용 5달러 차단선은 바꾸지 않는다. 사용자 도메인
전환이 완전히 검증되기 전에는 일반 사용자 서버 처리를 공개하지 않는다.

## 현재 상태와 원인

- `hereisit.app` zone은 같은 Cloudflare 계정에서 `active`, `full`, `paused: false` 상태다.
- 웹은 `hereisit.pages.dev`, 프로덕션 처리 API는
  `hereisit-processing-production.liorium.workers.dev`를 사용한다.
- exact-SHA CI, 여섯 Playwright 프로젝트, 분석 테스트와 스테이징 실제 처리는 통과했다.
- 프로덕션 API는 일반 외부 회선에서 HereIsIt 계약 응답을 반환하지만 GitHub 표준 Ubuntu와 서로 다른
  두 macOS 실행기에서 작업 생성 POST가 Cloudflare 앞단의 비계약 429로 끝났다.
- 앱의 네트워크·세션 Rate Limit 응답은 전용 범위 헤더와 `tool-job@1` JSON을 반환한다. 실패 응답에는
  둘 다 없었고 12회 제한 재시도도 동일해 앱 한도나 특정 실행기 누적으로 보지 않는다.

Cloudflare는 `workers.dev`를 개인·취미용 경로로 설명하고 프로덕션에는 Worker Route 또는 Custom
Domain을 권장한다. GitHub는 표준 실행기의 공유 동적 IP가 외부 평판 시스템에 의해 차단될 수 있으며,
예측 가능한 회선이 필요하면 고정 IP 또는 자체 실행기를 쓰도록 안내한다. 공개 저장소의 자체 실행기는
보안상 사용하지 않는다.

## 검토한 접근

### 1. 웹과 API를 각각 사용자 도메인에 직접 연결 — 선택

Pages에 `hereisit.app`, 프로덕션 Worker에 `api.hereisit.app` Custom Domain을 연결한다. 브라우저와
CI가 `workers.dev`를 직접 호출하지 않으며 추가 프록시나 실행기가 없다. 정적 자산은 계속 Pages가
직접 제공하고 API 요청은 기존 Worker가 그대로 받는다.

### 2. API만 `api.hereisit.app`으로 전환

429 원인은 해결하지만 사용자에게 보이는 주소와 canonical URL은 계속 `pages.dev`다. 도메인을 구매한
목적과 브랜드 전환을 다시 작업해야 하므로 선택하지 않는다.

### 3. Pages Function 프록시 또는 자체 GitHub 실행기

Pages 프록시는 API 요청마다 불필요한 함수 호출과 서비스 경계를 추가한다. 자체 실행기는 공개
저장소 코드를 사용자 서버에서 실행해 보안 위험과 지속적인 디스크 관리를 만든다. 둘 다 Custom
Domain보다 복잡하므로 선택하지 않는다.

## 주소와 호환성

- 공식 웹 origin: `https://hereisit.app`
- 공식 API origin: `https://api.hereisit.app`
- `https://www.hereisit.app/*`: 경로와 쿼리를 보존해 apex로 영구 리디렉션
- 기존 `https://hereisit.pages.dev`: 전환 중 기존 링크와 캐시를 위해 접근 가능하게 유지
- 기존 production `workers.dev`: 이번 전환과 복구 동안만 호환 경로로 유지하되 새 웹 빌드는 사용하지
  않는다. 제거는 실제 전환 안정성이 확인된 뒤 별도 변경으로 판단한다.
- 스테이징의 Pages와 Worker 주소는 변경하지 않는다.

API의 production origin allowlist에는 새 apex와 기존 `pages.dev`만 둔다. `www`는 API를 호출하기 전에
apex로 리디렉션되므로 별도 앱 origin으로 추가하지 않는다. 임의 서브도메인이나 와일드카드는 허용하지
않는다.

## 전환 순서

1. 현재 Worker에 `api.hereisit.app` Custom Domain을 추가하고 인증서가 활성화될 때까지 기다린다.
2. 새 API 주소에서 `/health`와 익명 정책의 계약, CORS, 보안 헤더를 읽기 전용으로 확인한다.
3. Pages에 apex와 `www`를 연결하고 인증서가 활성화된 뒤, apex 정적 페이지와 `www` 리디렉션을 확인한다.
4. 코드의 공개 사이트 URL, canonical, sitemap, CSP/connect-src, 제품 분석 host와 production workflow
   origin을 새 주소로 변경한다. 스테이징 값은 그대로 둔다.
5. production Worker의 정확한 앱 origin allowlist에 새 apex와 기존 Pages origin을 생성한다.
6. 집중 단위·workflow 테스트와 `pnpm verify`, 보호된 여섯 브라우저 행렬 및 분석 테스트를 통과시킨다.
7. exact SHA를 스테이징에 배포해 기존 스테이징 실제 처리를 다시 검증한다.
8. 프로덕션은 큐와 일반 사용자 처리를 닫은 상태로 배포하고, 새 API Custom Domain을 사용하는 분리된
   canary에서 실제 업로드, 코덱 처리, 다운로드, ACK와 삭제를 확인한다.
9. canary가 성공한 경우에만 기존 공개 승격 workflow가 월 예상비용 5달러 경계를 유지한 채 100%를
   적용한다. 익명 실제 처리와 복구 증명을 확인한다.

Custom Domain이나 인증서가 준비되지 않으면 코드 origin을 바꾸지 않는다. 전환 뒤 어떤 검증이든
실패하면 기존 회로차단기와 큐 정지로 일반 사용자를 로컬 처리에 남기며 DNS를 추측해 덮어쓰지 않는다.

## 코드와 설정 범위

기존 상수와 생성기를 재사용하며 새 라우터나 프록시를 만들지 않는다.

- 사이트 identity, canonical URL, sitemap과 정적 검증의 공식 origin
- production Pages/API origin을 사용하는 배포·canary·공개 승격 workflow
- production 앱 origin allowlist와 생성 설정 검증
- CSP와 API origin 정규화 테스트
- Pages custom domain, Worker custom domain과 `www` 리디렉션의 배포 검증
- 운영 문서의 공식 주소와 복구 명령

스테이징 origin, 이미지 계약, 브라우저/서버 코덱, D1/R2/Queue 구조, 사용자 UI와 의존성은 변경하지
않는다.

## 보안·개인정보·비용

- Custom Domain은 동일 Cloudflare 계정의 기존 Pages와 Worker에만 연결한다.
- API는 정확한 HTTPS origin과 기존 CORS 경계를 유지하며 와일드카드를 사용하지 않는다.
- 요청과 응답 body를 프록시하거나 새 로그에 기록하지 않는다.
- 파일 내용, 파일명, 썸네일, 다운로드 URL과 자격 증명을 배포 로그·artifact에 남기지 않는다.
- Custom Domain은 처리 경로에 추가 함수나 유료 의존성을 넣지 않는다.
- 도메인 등록비는 별도 고정 운영비다. 서버 처리의 월 예상비용 5달러 fail-closed 경계와 Cloudflare
  계정 청구 예산은 그대로 유지한다.

## 검증

### 자동 검증

- 새 공식 origin과 legacy allowlist의 정확한 값
- `www` 리디렉션이 HTTPS, apex, 경로와 쿼리를 보존하고 다른 host를 허용하지 않음
- production workflow가 새 custom origins, staging workflow가 기존 staging origins를 사용함
- sitemap, canonical, CSP, 분석 host와 정적 export가 `hereisit.app`으로 일치함
- `pnpm verify`
- GitHub Actions Chromium, Firefox, WebKit과 모바일 프로젝트 및 제품 분석

### 실제 배포 검증

- Cloudflare zone, Pages custom domains, Worker custom domain과 인증서가 모두 active
- apex의 주요 페이지와 정적 자산이 정상이며 `www`가 한 번만 리디렉션됨
- 새 API `/health`, 정책, CORS와 HereIsIt 오류 계약이 정상
- exact-SHA 스테이징 실제 처리 성공
- 프로덕션 관리자 canary의 업로드, 서버 코덱, 다운로드, ACK, 삭제와 고아 작업 없음
- 공개 승격 후 익명 사용자도 같은 실제 경로를 성공하고 rollout 100%, 월 5달러 경계가 증명됨

## 완료 기준

- 공식 사용자 주소와 모든 canonical URL이 `https://hereisit.app`이다.
- 새 웹 빌드는 `https://api.hereisit.app`만 처리 API로 사용한다.
- GitHub 표준 실행기의 프로덕션 실제 처리 canary가 비계약 429 없이 성공한다.
- CI, 브라우저 행렬, 스테이징, 프로덕션 canary와 공개 승격이 exact SHA에서 모두 성공한다.
- 서버 처리는 월 예상비용 5달러 경계와 기존 fail-closed 복구를 유지한다.
- 완료 후 임시 파일, 중지된 실행, 불필요한 Docker 자원, 작업 브랜치와 worktree를 정리한다.

## 제외 범위

- 새 API 프록시, 자체 GitHub 실행기 또는 새 유료 인프라
- 이메일, 사용자 계정, 결제나 구독 기능
- 이미지 엔진, 압축 품질, 파일 한도 또는 UI 변경
- 스테이징용 사용자 도메인
- 기존 `workers.dev` 호환 주소의 즉시 비활성화

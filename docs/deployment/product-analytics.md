# 제품 분석 운영

HereIsIt은 파일 정보나 사용자 식별자를 기록하지 않고 페이지·성능 통계와 도구 실행 흐름만 집계한다.

## 읽기 전용 토큰

Cloudflare의 별도 토큰을 다음 범위로 만든다.

- 권한: `Account > Account Analytics > Read`
- 리소스: HereIsIt이 속한 계정 하나
- 이름 예시: `hereisit-analytics-read`
- 가능하면 IP 제한과 만료일 설정

이 토큰은 배포 토큰과 분리한다. Pages/Worker 환경 변수, GitHub 배포 secret, Git 저장소, 셸 명령
인자나 셸 기록에 넣지 않는다. 로컬의 Git 외부 파일에 저장한다면 권한을 `0600`으로 제한한다.

Web Analytics 사이트 설정은 Cloudflare 대시보드에서 확인하며 배포 토큰 권한을 넓힐 필요가 없다.

## 실행

토큰 값을 화면이나 명령 기록에 남기지 않는 셸에서 환경 변수로 읽힌 뒤 실행한다.

```bash
test -n "$CLOUDFLARE_ACCOUNT_ID"
test -n "$CLOUDFLARE_ANALYTICS_READ_TOKEN"
pnpm analytics:report --environment production --days 7
```

`--environment`는 `staging` 또는 `production`, `--days`는 `1`부터 `90`까지다. 명령은
Cloudflare 응답을 256KiB로 제한하고 다음 집계만 JSON으로 출력한다.

- 예상 페이지 조회·방문 수와 상위 경로·유입 호스트·국가·기기·브라우저
- LCP·INP·CLS p75
- 도구별 시작·성공·실패·다운로드 요청 수와 전환 비율
- 처리 시간 구간과 실패 분류

Web Analytics 값은 `sampleInterval`을 반영한 추정치다. 차단 도구와 네트워크 실패 때문에 도구 이벤트도
완전한 전체 건수가 아닐 수 있다. Analytics Engine 이벤트는 3개월, Web Analytics는 이전 6개월까지
조회할 수 있다.

## 분석 브라우저 검증 정책

GitHub Actions `browser` job의 `Test product analytics` 단계가 명시적인 분석 fixture를 빌드하고
개인정보·장애 격리 브라우저 검사를 실행한다. 일상적인 로컬 검증에서는 이 fixture를 빌드하거나
Playwright를 실행하지 않는다. 실패 시 개인정보 안전 CI artifact만 7일 동안 보존한다.

## 활성화와 배포 확인

Cloudflare에서 **Workers & Pages → hereisit → Metrics → Web Analytics → Enable**을 선택한다. 수동 beacon
코드는 붙이지 않는다. 다음 Pages 배포부터 Cloudflare가 자동으로 주입한다.

Pages 배포의 beacon은 `https://cloudflareinsights.com/cdn-cgi/rum`으로 전송되므로 생성 CSP의
`connect-src`에는 이 정확한 수집 origin만 허용한다.

스테이징은 기존 GitHub 배포 경로의 `processing-staging` 브랜치를 사용한다.

```bash
curl -fsS https://processing-staging.hereisit.pages.dev/privacy >/dev/null
curl -fsS https://processing-staging.hereisit.pages.dev/ | rg -F 'https://static.cloudflareinsights.com/beacon.min.js'
```

스테이징 처리 서버 스모크는 등록 호스트가 다른 이 제3자 수집 요청만 204로 대체한다. 실제 분석 수집은
운영 호스트에서 확인하고, 허용된 네 이벤트와 고정된 집계 차원만 점검한다.

```bash
curl -fsS https://hereisit.app/privacy >/dev/null
curl -fsS https://hereisit.app/ | rg -F 'https://static.cloudflareinsights.com/beacon.min.js'
pnpm analytics:report --environment production --days 1
```

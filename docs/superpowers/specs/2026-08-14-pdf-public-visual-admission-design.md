# PDF 서버 공개 시각 검증 설계

**상태:** 2026-08-14 사용자 일괄 승인

## 목표

현재 관리자 전용인 `pdf.optimize@1` 서버 처리를 공개할 수 있는 실제 시각 품질 증거를 만든다.
공개는 자동 목표가 아니다. 정확한 릴리스에서 구조·페이지·픽셀 품질, 삭제, 비용, 롤백이 모두
검증된 경우에만 익명 사용자에게 허용하고, 하나라도 없거나 불일치하면 현재처럼 로컬 처리와
관리자 전용 서버 canary만 유지한다.

월 예상비용 상한은 기존 `5,000,000µUSD`(5달러)를 유지한다. 이미지 처리의 공개 상태, 큐,
컨테이너와 비용 경계는 변경하지 않는다.

## 현재 상태

PDF 서버 엔진, 명시적 업로드 UI, 브라우저 결과 검증 Worker, 분리된 Queue/DLQ/Container,
immutable 배포와 복구 경로는 이미 있다. 구조형 코퍼스의 실제 qpdf 벤치마크도 통과했다.

하지만 현재 증거의 `visualProfilesMeasured`는 `0`이고 `publicAdmissionReady`는 `false`다. 기존
코퍼스에서 qpdf가 선택한 결과가 모두 구조 최적화였기 때문에, 임베디드 이미지 품질을 바꾸는
`image-optimized` 결과가 실제 브라우저 렌더링 검증을 통과했다는 근거가 없다. 따라서 익명 PDF
서버 처리는 계속 차단되는 것이 맞다.

또한 배포 권한은 exact-main SHA의 진짜 hosted 검토 보고서만 허용한다. 필요한 여섯 보고서가
없을 때 가짜 통과 자료를 만들지 않고 배포를 중단하는 현재 fail-closed 경계를 유지한다.

## 검토한 접근

### 1. 실제 image-optimized 결과를 브라우저 행렬에서 검증 — 선택

저작권 문제가 없는 결정적 이미지 중심 PDF를 기존 코퍼스 생성기에 추가한다. 실제 pinned qpdf
엔진이 세 번 모두 `image-optimized` 결과를 선택해야 하며, 그 결과를 기존 PDF 검증 경로로
Chromium, Firefox, WebKit에서 렌더링한다. 구조, 페이지 수와 결정적 표본 페이지의 픽셀 오차가
기존 허용치 안에 있을 때만 시각 증거를 통과시킨다.

실제 사용자 경로와 같은 엔진·브라우저 검증기를 사용하므로 공개 판단의 누락된 근거를 직접
채운다. 새 압축 엔진이나 제품 UI가 필요 없다.

### 2. 구조 최적화만 공개

이미 측정된 경로라 구현은 작지만, 서버가 로컬보다 실질적으로 나은 PDF 종류가 제한된다. 기존
설계의 이미지 최적화 품질 약속도 검증하지 못한다. 선택하지 않는다.

### 3. 새 PDF 이미지 재작성 엔진 추가

더 강한 압축 가능성은 있지만 라이선스, 공급망, 메모리, 보안과 품질 검증 면적이 크게 늘어난다.
현재 qpdf 경로의 공개 자격을 먼저 증명하는 작업과 무관하므로 제외한다.

## 시각 검증 코퍼스

기존 결정적 코퍼스와 생성기를 확장한다. 새 fixture는 저장된 제3자 PDF나 사진을 사용하지 않고,
코드가 만드는 반복 가능한 페이지와 repository-owned 이미지 바이트만 사용한다.

fixture는 다음 조건을 만족해야 한다.

- qpdf의 `image-optimized` 후보가 원본 및 구조 후보보다 작다.
- 세 번의 독립 실행에서 모두 같은 프로필이 선택된다.
- 원본과 결과의 페이지 수, 페이지 상자, 회전, 텍스트·주석·연산자 의미가 유지된다.
- 기존 PDF.js 검증기가 최대 다섯 결정적 페이지를 96 DPI로 렌더링한다.
- 기존 고정 픽셀 오차 한도를 세 브라우저 프로젝트에서 모두 통과한다.
- 결과가 1% 이상 작고 50MiB, 100페이지, 캔버스·시간·메모리 한도를 넘지 않는다.

압축 효과를 보이기 위해 검증 기준이나 JPEG 품질을 바꾸지 않는다. fixture가 실제 엔진에서
안정적으로 `image-optimized`를 선택하지 못하면 품질 증거가 실패한 것으로 처리한다.

## 증거와 공개 게이트

기존 benchmark/report/gate 계약을 최소 확장한다. 별도 증명 체계를 만들지 않는다.

1. pinned PDF 엔진을 exact main SHA에서 빌드한다.
2. 코퍼스 전체를 세 번 실행하고 기존 구조·적대 입력 게이트를 다시 통과한다.
3. image-optimized 결과를 Chromium, Firefox, WebKit의 기존 검증기로 검사한다.
4. 원본·결과 파일, 렌더 이미지, 파일명과 URL은 버리고, 고정 열거값·크기·digest·프로젝트별
   통과 여부만 sanitized artifact로 남긴다.
5. benchmark, browser receipt, source SHA, Worker artifact와 두 엔진 digest를 동일한 signed `@2`
   release authority에 묶는다.
6. staging 관리자 canary, 결과 삭제 확인, 비용 검증, 실제 롤백 검증을 순서대로 실행한다.
7. 모든 receipt가 동일 release-report SHA와 일치할 때만 PDF public admission 상태를 활성화한다.
8. 익명 정책과 실제 업로드·처리·검증·다운로드·확인 삭제 smoke를 통과한 뒤 공개 상태를 확정한다.

`visualProfilesMeasured > 0`만으로 공개하지 않는다. 현재 admission 계약이 요구하는 삭제, 비용,
롤백과 exact report 결속을 모두 유지한다. genuine hosted 검토 보고서가 준비되지 않았으면 새 시각
증거가 통과해도 release authority 생성과 배포는 중단한다.

## 실패와 복구

- 코퍼스, 엔진 선택, 브라우저 렌더 또는 픽셀 검증 실패: 증거를 통과시키지 않고 관리자 전용 유지.
- SHA, digest, schema 또는 receipt 불일치: 배포 전 중단.
- staging/canary/삭제/비용/롤백 실패 또는 취소: PDF Queue와 DLQ를 안전 상태로 복구하고 공개하지 않음.
- 익명 smoke 실패: 공개 admission을 비활성화하고 Worker, 두 엔진, D1 정책과 네 Queue를 검증된 이전
  상태로 복구.
- 복구가 완전히 검증되지 않음: 회로를 열고 PDF Queue를 정지한 채 실패로 종료.

이미지 처리의 Worker, 엔진, 공개 정책과 Queue 상태는 PDF 복구의 대상이 아니며, 공용 릴리스 복구가
필요한 경우에도 저장된 정확한 이전 상태로만 되돌린다.

## 구현 경계

재사용 대상은 기존 코퍼스 생성기, PDF benchmark/parser, 브라우저 검증 Worker, Playwright CI 설정,
release authority와 public admission 스크립트다. 새 최적화 엔진, 새 런타임 의존성, 새 API, 새 화면과
새 사용자 설정은 추가하지 않는다.

로컬에서는 순수 단위·계약·schema·benchmark 테스트와 `pnpm verify`만 실행한다. Playwright 브라우저는
저장소 정책대로 GitHub Actions에서만 실행한다. 브라우저 증거 workflow는 실패와 취소에서도 원본 및
렌더 산출물을 업로드하지 않고 제거한다.

## 검증

- RED: image-optimized 3회 선택, 시각 receipt 결속, 프로젝트 누락·중복·실패·digest 변조를 거부하는
  테스트를 먼저 추가한다.
- GREEN: 기존 benchmark/schema/admission 도구를 최소 변경해 새 증거를 strict parse한다.
- 회귀: 기존 17개 구조·적대 strata, 이미지 처리, 관리자 PDF canary와 현재 공개 차단을 유지한다.
- 로컬: 집중 테스트, 관련 타입체크·lint·diff check, 전체 `pnpm verify`.
- hosted: Chromium/Firefox/WebKit 검증, exact-SHA release authority, staging, 관리자 canary, 삭제·비용·
  롤백, 익명 production smoke.
- 완료 뒤 코퍼스, 렌더, 다운로드, Docker container/network, 임시 image와 worktree를 정리한다.

## 완료 기준

- 실제 pinned qpdf가 새 fixture에서 세 번 모두 `image-optimized`를 선택한다.
- Chromium, Firefox, WebKit이 기존 의미·픽셀 검증을 모두 통과한다.
- signed evidence에서 `visualProfilesMeasured > 0`이고 모든 receipt가 exact release-report SHA에 묶인다.
- 예상 월비용이 5달러 이하이며 삭제와 롤백이 실제 환경에서 검증된다.
- 익명 PDF 정책은 모든 게이트가 성공한 경우에만 서버 처리를 반환한다.
- 실패·취소·증거 부재 시 공개가 차단되고 이미지 기능은 정상 유지된다.
- 파일 내용, 파일명, 렌더 이미지, 썸네일, presigned URL이 로그나 artifact에 남지 않는다.

## 제외 범위

- 로그인, 결제, 유료 기능과 사용자별 과금
- 새 PDF 코덱, OCR, 비밀번호 처리, PDF/A 또는 이미지 다운샘플러 개발
- 시각 품질 임계값이나 JPEG 품질 변경
- 자동 업로드 또는 명시적 서버 처리 고지 변경
- 브라우저 행렬이 없는 수동 추정 공개
- 진짜 hosted 검토 증거가 없는 release authority 우회

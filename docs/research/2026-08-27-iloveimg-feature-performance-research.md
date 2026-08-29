# iLoveIMG 기능·성능 기준 조사

**조사일:** 2026-08-27 (UTC)

**범위:** iLoveIMG/iLoveAPI 공식 사이트와 공식 도움말에 공개된 이미지 도구, 작업 한도,
가격, 성능·운영 관련 설명. 제3자 리뷰나 iLoveIMG의 내부 구현 추정은 제외했다.

## 결론

iLoveIMG의 현재 공개 이미지 도구는 홈페이지 기준 13개 기능이다. 핵심 일괄 도구는 압축,
크기 조절, 자르기, JPG 변환, JPG에서 변환, 사진 편집, 업스케일, 배경 제거, 워터마크,
밈 생성, 회전, HTML-to-image, 얼굴 흐림이다. 공식 가격표의 `Convert IMAGE`는 홈페이지의
`Convert to JPG`와 `Convert from JPG`를 묶은 분류명으로 보이며, 별도의 공개 작업 화면으로
세지 않았다. [iLoveIMG 홈페이지](https://www.iloveimg.com/),
[Premium 도구 목록](https://www.iloveimg.com/user/premium)

현재 HereIsIt은 위 13개 이미지 작업 화면을 모두 제공한다. 다만 iLoveIMG와 입력 형식,
AI 복원 품질, 서버·브라우저 실행 방식은 다르므로 기능 이름이 같다는 이유로 동등한 품질을
주장하지 않는다. 각 도구는 버전 계약·입력 한도·출력 검증·속도 지표를 기준으로 관리한다.

공식 자료는 iLoveIMG의 정확한 P50/P95 처리 시간, 압축률, 장치별 처리 속도를 공개하지 않는다.
따라서 “iLoveIMG만큼 빠르다/압축된다”는 주장은 현재 자료만으로 검증할 수 없다. iLoveIMG가
공개한 것은 서버가 고속 처리된다는 제품 설명, 사용자의 네트워크와 파일 크기가 속도에 영향을
준다는 안내, iLoveAPI의 99.9%+ 운영 설명과 하루 2,000만 이미지·PDF 처리 규모다.
[iLoveIMG 기능 안내](https://www.iloveimg.com/features),
[iLoveIMG 도움말](https://www.iloveimg.com/help/documentation),
[iLoveAPI 기능](https://www.iloveapi.com/features),
[iLoveAPI 개요](https://www.iloveapi.com/)

## 공식 기능 인벤토리

| iLoveIMG 기능 | 공식 입력·동작 | HereIsIt 현재 대응 |
| --- | --- | --- |
| Compress IMAGE | JPG, PNG, SVG, GIF를 일괄 압축. 품질과 파일 크기의 균형을 자동 선택하며 사용자가 압축 레벨을 직접 고르지 않는다. | **부분 대응.** JPG/PNG/WebP 서버 압축이 있으며 SVG/GIF는 현재 계약에 없다. [압축 화면](https://www.iloveimg.com/compress-image), [FAQ](https://www.iloveimg.com/help/faq) |
| Resize IMAGE | JPG, PNG, SVG, GIF를 픽셀 또는 백분율로 일괄 조절. 비율 유지, 최대 크기, 작은 이미지를 확대하지 않기 옵션이 있다. | **대응.** 브라우저 기반 픽셀·백분율 크기 조절, 비율·프리셋, 작은 이미지 확대 금지 옵션을 제공한다. SVG/GIF는 현재 계약에 없다. [리사이즈 화면](https://www.iloveimg.com/resize-image) |
| Crop IMAGE | JPG, PNG, GIF를 픽셀 직사각형으로 자른다. 도움말에는 일괄 자르기 비율 3:2, 4:3, 5:4, 1:1, 4:5, 3:4, 2:3이 설명되어 있다. | **대응.** `image.crop@1` 전용 화면에서 JPG/PNG/WebP를 7개 비율·초점 위치 또는 미리보기의 자유 사각형으로 자른다. [자르기 화면](https://www.iloveimg.com/crop-image), [도움말](https://www.iloveimg.com/help/documentation) |
| Convert to JPG | PNG, GIF, TIF, PSD, SVG, WEBP, HEIC, RAW를 JPG로 변환. 추천 품질과 Premium 고품질(원본 픽셀 크기 유지) 옵션이 있다. | **부분 대응.** 브라우저 JPEG/PNG/WebP/HEIC 계열 변환은 있으나 현재 입력·출력 목록에 GIF/TIF/PSD/SVG/RAW가 없다. [변환 화면](https://www.iloveimg.com/convert-to-jpg) |
| Convert from JPG | JPG를 PNG 또는 GIF로 변환. GIF는 정적 또는 애니메이션이며 프레임당 시간과 반복 여부를 설정한다. | **1차 대응.** JPG→PNG와 다중 JPG→애니메이션 GIF, 프레임 간격·반복 재생을 브라우저에서 제공한다. 브라우저가 읽을 수 있는 JPG만 받는다. [JPG 변환 화면](https://www.iloveimg.com/jpg-to-image), [도움말](https://www.iloveimg.com/help/documentation) |
| Photo editor | 텍스트, 스티커, 효과, 필터를 추가하는 단일 이미지 편집기. | **1차 대응.** 밝기·대비·채도·회색조, 필터·프레임·스티커·문구를 로컬 캔버스에서 제공한다. [사진 편집 화면](https://www.iloveimg.com/photo-editor) |
| Upscale image | JPG/PNG를 6MP 미만으로 받아 2x 또는 4x 확대한다. 공식 화면은 Premium 기능으로 표시한다. | **1차 대응.** 2배·4배 고품질 픽셀 보간과 25MP 메모리 상한을 제공하며 AI 복원은 아니다. [업스케일 화면](https://www.iloveimg.com/upscale-image) |
| Remove background | JPG/PNG의 배경을 자동으로 제거한다. | **1차 대응.** 가장자리 표본과 연결 영역을 기준으로 투명 PNG를 만들며 의미 기반 AI 누끼는 아니다. [배경 제거 화면](https://www.iloveimg.com/remove-background) |
| Watermark IMAGE | JPG, PNG, GIF에 이미지 또는 텍스트를 일괄 삽입한다. 화면에는 글꼴·투명도·색상·그림자 등 설정과 품질 경고가 보인다. API 문서의 이미지 워터마크는 PNG/JPG, 1MB 이하로 제한한다. | **부분 대응.** 텍스트·JPG/PNG/WebP 로고·9개 앵커를 브라우저에서 제공한다. GIF와 iLoveIMG의 편집 옵션 전체는 별도 범위다. [워터마크 화면](https://www.iloveimg.com/watermark-image), [API 워터마크 가이드](https://www.iloveapi.com/docs/image-guides/watermark) |
| Meme generator | JPG/GIF/PNG 또는 템플릿으로 밈을 만들고, 텍스트를 이미지 안/밖에 배치하며 이미지·텍스트를 추가한다. | **1차 대응.** JPG/PNG/WebP에 위·아래 문구를 넣어 로컬에서 생성한다. 템플릿·추가 이미지 레이어는 제공하지 않는다. [밈 생성기](https://www.iloveimg.com/meme-generator) |
| Rotate IMAGE | JPG, PNG, GIF를 일괄 회전하고 전체·세로·가로 방향만 선택할 수 있다. API는 0/90/180/270도를 지원한다. | **대응.** `image.rotate@1` 전용 화면에서 JPG/PNG/WebP를 0/90/180/270도로 회전하고 전체·세로·가로 방향을 고를 수 있다. GIF는 아직 계약에 없다. [회전 화면](https://www.iloveimg.com/rotate-image), [API 회전 가이드](https://www.iloveapi.com/docs/image-guides/rotate) |
| HTML to IMAGE | 웹페이지 URL을 JPG 또는 SVG로 변환하고, 미리보기 전에 URL 콘텐츠를 스캔한다. | **1차 대응.** 붙여 넣은 HTML/CSS만 정제해 로컬 PNG로 렌더링하며 외부 URL을 가져오지 않는다. [HTML 변환 화면](https://www.iloveimg.com/html-to-image) |
| Blur face | 얼굴 자동 탐지 또는 사용자 지정 영역을 흐림 처리한다. 낮음/높음 탐지, 특정 얼굴 포함·제외, 사용자 지정 blur 영역이 화면에 있다. | **1차 대응.** 지원 브라우저의 FaceDetector 자동 탐지와 수동 드래그 영역을 제공하며 전용 AI 모델은 사용하지 않는다. [얼굴 흐림 화면](https://www.iloveimg.com/blur-face) |

### 기능 수를 해석할 때의 주의점

- iLoveIMG 홈페이지는 위 13개 작업 화면을 직접 노출한다. 가격표와 로그인/가입 페이지에는
  `Convert IMAGE`라는 묶음 행이 추가되어 14개처럼 보일 수 있다. [홈페이지](https://www.iloveimg.com/),
  [가격표](https://www.iloveimg.com/pricing), [가입 페이지](https://www.iloveimg.com/register)
- iLoveAPI의 공식 이미지 API 목록은 resize, crop, compress, upscale, remove background,
  convert, watermark, repair, rotate다. 소비자 웹 화면의 사진 편집기·밈 생성기·얼굴 흐림 기능이
  API 목록에 없다는 점은 “웹 기능 전부를 같은 API로 자동화할 수 있다”는 뜻이 아님을 보여준다.
  [API Reference](https://www.iloveapi.com/docs/api-reference)

## 공식 한도와 가격 스냅샷

아래 숫자는 2026-08-27에 확인한 iLoveIMG 가격표의 `Batch processing` 및 `Filesize per task`
표기다. `per task`는 파일 하나의 한도가 아니라 작업 전체에 대한 표기이므로 HereIsIt의
`maxFileBytes`와 그대로 비교하면 안 된다.

| 기능 | Basic 파일 수 / 작업 | Premium·Business 파일 수 / 작업 | Basic 작업 크기 | Premium·Business 작업 크기 |
| --- | ---: | ---: | ---: | ---: |
| Compress IMAGE | 30 | 120 | 200 MB | 4 GB |
| Resize IMAGE | 30 | 120 | 200 MB | 4 GB |
| Crop IMAGE | 1 | 1 | 90 MB | 4 GB |
| Convert to JPG | 30 | 120 | 200 MB | 4 GB |
| Convert from JPG | 30 | 120 | 200 MB | 4 GB |
| Rotate IMAGE | 30 | 120 | 200 MB | 4 GB |
| Watermark IMAGE | 30 | 120 | 200 MB | 4 GB |
| Photo editor | 1 | 1 | 50 MB | 50 MB |
| Meme generator | 1 | 1 | 200 MB | 4 GB |
| Upscale image | 1 | 3 | 6 MB | 6 MB |
| Blur face | 10 | 120 | 100 MB | 4 GB |
| Remove background | 3 | 3 | 6 MB | 6 MB |

출처: [iLoveIMG 가격표](https://www.iloveimg.com/pricing) (`Batch processing`, `Filesize per task` 표).
HTML-to-image의 동일한 표 수치는 가격표에 별도로 노출되지 않는다.

가격 정책은 Basic 무료(필수 도구와 제한된 문서 처리), Premium 월 $5 또는 연 $60(최대 25명
선택 화면, 모든 도구·무제한 문서 처리·AI 도구·광고 제거·2,000 AI 크레딧 등), Business
맞춤형이다. 가격은 변경될 수 있으므로 제품 가격을 복사해 고정하지 않는다.
[iLoveIMG 가격표](https://www.iloveimg.com/pricing)

API를 별도 비용 기준으로 사용할 경우 공식 API 가격표는 가입 시 월 2,500 무료 크레딧을
제시하고, 일반 이미지 압축·변환·자르기·크기 조절·회전·워터마크·HTML-to-image는 파일당
2크레딧, 업스케일은 20크레딧, 배경 제거는 10크레딧으로 표시한다. 이는 iLoveIMG 웹 Premium
가격과 다른 상품이므로 HereIsIt의 원가로 직접 대입하지 않는다.
[iLoveAPI 가격표](https://www.iloveapi.com/pricing)

## 성능·운영에 관한 공식 사실

- iLoveIMG는 서버의 업로드·처리·다운로드가 고속이라고 설명하지만, 느린 인터넷과 큰 파일은
  업로드·처리 시간을 늘릴 수 있다고 안내한다. 따라서 사용자가 체감하는 총 시간은 엔진만의
  속도가 아니다. [기능 안내](https://www.iloveimg.com/features), [도움말](https://www.iloveimg.com/help/documentation)
- iLoveAPI는 이미지·PDF를 하루 2,000만 건 처리한다고 소개하며, 기능 페이지는 시스템이
  99.9%+ 가동률로 운영된다고 설명한다. API 가격/FAQ는 99.95% 초과 가동률 보장을 별도로
  적는다. 이것은 규모·가용성 지표이지 특정 파일의 지연시간이나 압축률 보장이 아니다.
  [iLoveAPI 개요](https://www.iloveapi.com/), [기능](https://www.iloveapi.com/features),
  [가격·FAQ](https://www.iloveapi.com/pricing)
- API는 로컬 드라이브 또는 URL 업로드, 청크 업로드, 처리 전 파일 편집, webhook 기반 비동기
  완료 알림을 제공한다. 이는 대용량·긴 작업에서 필요한 운영 패턴의 참고점이다.
  [API Reference](https://www.iloveapi.com/docs/api-reference)
- 처리된 파일은 다운로드를 위해 잠시 서버에 남고, 공식 도움말·개인정보 정책은 처리 후
  2시간 이내 자동 삭제와 다운로드 화면에서의 수동 삭제를 설명한다. [도움말](https://www.iloveimg.com/help/documentation),
  [개인정보 정책](https://www.iloveimg.com/help/privacy), [보안 안내](https://www.iloveimg.com/help/security)
- 압축 FAQ는 압축 레벨 선택을 제공하지 않고 품질을 낮추지 않는 선에서 가장 작게 만든다고
  설명한다. 압축 결과의 정확한 퍼센트나 이미지별 품질 알고리즘은 공개하지 않는다.
  [FAQ](https://www.iloveimg.com/help/faq)

### HereIsIt 기준 측정

기존 저장소의 PR 이미지 벤치마크를 현재 코퍼스 20개에 실행했다. 20건 중 10건은 다운로드
결과, 9건은 원본 유지, 1건은 안전한 거부였다. 다운로드 결과의 중앙 크기 비율은 원본의
71.5%, 처리시간 P95는 1,766ms, 측정된 최대 RSS는 141.7MB였다. 이 실행의 엔진 이미지
다이제스트는 `sha256:9c4d87448d29475e741cb10f9f883374f1fb6c110b215d3fa719555bcdc9a30d`,
벤치마크 JSON SHA-256은 `ac279e83c40d9c3b540fb4611d9335dbef87f943249ef7c49851fa4e0856bd79`다.
이는 로컬 Docker·고정 코퍼스 기준선이며, iLoveIMG와 같은 입력·품질·네트워크 조건으로
측정한 비교값이 아니므로 서비스 간 우열을 뜻하지 않는다.

## HereIsIt과의 고수준 비교

| 항목 | iLoveIMG 공개 기준 | HereIsIt 현재 기준 | 판단 |
| --- | --- | --- | --- |
| 핵심 이미지 도구 | 13개 공개 화면, 일괄 작업 중심 | 13개 이미지 도구 화면과 PDF/JSON 도구 | 화면 수는 대응하지만 세부 입력·품질 정책은 다름 |
| 압축 | JPG/PNG/SVG/GIF, 자동 품질·크기 균형, 서버 처리 | JPG/PNG/WebP, 공개된 네이티브 서버 엔진, 더 작아질 때만 결과 제공 | 서버 엔진은 운영 중이나 SVG/GIF 및 비교 corpus가 필요 |
| 크기 조절 | 픽셀/%·비율 유지·최대 크기·확대 금지·일괄 | 브라우저 픽셀/% 처리, WebP 중심 추천 프리셋과 원본 형식/품질 정책 | SVG/GIF 입력과 외부 서비스의 압축률은 별도 비교 필요 |
| 자르기·회전 | 전용 화면 및 일괄 방향/비율 동작 | `image.crop@1` 가운데 기준 비율 자르기, `image.rotate@1` 90도 단위 회전과 방향 필터 | GIF 입력은 후속 계약으로 분리 |
| 변환 | JPG↔PNG/GIF, JPG 대상 TIF/PSD/SVG/WEBP/HEIC/RAW | JPG↔PNG와 다중 JPG→GIF, 브라우저 기본 디코더 범위 | 미지원 디코더는 라이선스·품질 검증 후 별도 계약 |
| AI/편집 | 업스케일·배경 제거·얼굴 흐림·사진 편집·밈 | 로컬 픽셀 보간·연결 배경 제거·FaceDetector·편집기·밈 1차 대응 | AI 모델·서버 비용이 필요한 고급 품질은 별도 제품 범위 |
| 일괄 한도 | Basic도 일반 작업 30개·200MB, Premium 120개·4GB 표기 | 압축 20개·파일당 30MiB·총 600MiB, 일반 이미지 파이프라인 100개·파일당 50MiB·총 250MiB | 숫자만 키우지 말고 실제 메모리·비용·큐 용량으로 정해야 함 |
| 개인정보 | 서버 처리와 2시간 삭제, HTTPS/암호화·GDPR 설명 | 기본 이미지 압축은 공개된 서버 처리, UI에서 처리 경계와 삭제 정책 고지 | HereIsIt의 공개 서버 기본값은 유지하되, 로컬 옵션도 정직하게 표시 |
| 속도 근거 | 대규모 처리·가용성 설명은 있으나 공개 P50/P95/압축률 없음 | CI/카나리와 엔진 테스트는 있으나 iLoveIMG와 동일 corpus의 외부 비교는 없음 | “동급” 대신 동일 corpus·네트워크 조건의 내부 목표를 수립해야 함 |

HereIsIt의 현재 지원 범위와 한도는 [README의 Current limits](../../README.md#current-limits),
[도구 카탈로그](../../packages/tool-registry/src/tool-catalog.ts),
[이미지 구현 설정](../../apps/web/src/lib/tool-implementations.ts)에 근거한다.

## 권장 다음 순서

1. **현재 계약을 유지한다.** crop의 7개 비율·초점 위치·자유 사각형, rotate의
   0/90/180/270도, JPG→GIF의 프레임 간격·반복 재생을 기존 Worker·검증·다운로드 흐름으로
   계속 회귀 검증한다. 추가 디코더는 별도 계약으로 분리한다.
2. **변환 확장은 검증 후에만 한다.** TIF/PSD/RAW/SVG/HEIC 입력은 브라우저 지원을 추측하지
   말고 디코더의 라이선스·메모리·품질을 확인한 뒤 추가한다. GIF 인코더를 새로 도입하지 않고
   현재의 제한된 로컬 구현을 유지한다.
3. **압축 성능을 수치화한다.** JPEG/PNG/WebP의 원본 크기·픽셀 수·메타데이터·이미지 복잡도를
   섞은 라이선스 보유 corpus를 고정하고, iLoveIMG와 비교할 때는 동일 입력·동일 출력 형식·동일
   품질 허용오차·동일 네트워크 조건을 기록한다. 최소 기록값은 결과 크기, SSIM/시각 허용오차,
   업로드·대기·처리·다운로드 시간, P50/P95, peak RSS, 실패율이다. iLoveIMG의 공개 마케팅
   설명만으로 목표값을 만들지는 않는다.
4. **AI 기능은 수익화/쿼터 뒤에 둔다.** 업스케일·배경 제거·얼굴 흐림은 무료 무제한으로
   공개하면 비용과 악용 위험이 크다. 로그인·익명 세션 rate limit·작업별 비용·결과 검증·
   서버 공개 고지를 갖춘 뒤 하나씩 도입한다.
5. **URL HTML 캡처와 AI 품질은 별도 제품 범위다.** 현재 HTML-to-image는 외부 URL을 읽지
   않고, 업스케일·배경 제거·얼굴 흐림도 로컬 휴리스틱/브라우저 API 범위다. 서버 모델을
   추가할 때는 로그인·쿼터·결과 검증·처리 고지를 먼저 갖춘다.

이 순서라면 iLoveIMG의 기능을 무작정 복제하는 대신 HereIsIt의 기존 local-first/서버 계약
경계를 보존하면서, 사용자 가치가 큰 기본 이미지 작업부터 성능 증거와 함께 확장할 수 있다.

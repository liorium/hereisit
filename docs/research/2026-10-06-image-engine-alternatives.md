# 이미지 엔진 대안 조사 — 2026-10-06

## 결론

**Sharp를 버리고 사이트를 다시 만들 근거는 확인되지 않았다.** 최신 기술 후보는 있지만, 현재의 공개 압축 차단을 해결하는 것과 압축기의 성능을 높이는 것은 별개 작업이다. 우선 기존 처리 흐름을 복구하고, Sharp/OxiPNG 업데이트 및 이미 준비된 jpegli 비교만 제한적으로 진행하는 것이 저비용·저관리 운영 목표에 맞는다. 이는 아래 소스와 코드에 근거한 엔지니어링 판단이며 성능 실측 결과가 아니다.

조사 범위: 공식 문서·공식 GitHub 릴리스 API와 저장소 코드. 기준일은 한국 시간 2026-10-06. 설치, 압축 벤치마크, 배포 또는 정책 변경은 하지 않았다. 문서의 버전은 확인 시점의 upstream 상태이며 실제 운영 컨테이너의 버전을 증명하지 않는다.

## 현재 구성: Sharp 하나가 아니다

- [package.json](../../apps/image-engine/package.json): Sharp 0.35.4.
- [native/sources.lock.json](../../apps/image-engine/native/sources.lock.json): libvips 8.18.7, MozJPEG 4.1.1, OxiPNG 10.1.1, Quantizr 1.4.3, libwebp 1.6.0. jpegli는 `production: false`인 비교 후보다.
- [pipeline/plan.ts](../../apps/image-engine/src/pipeline/plan.ts): JPEG는 MozJPEG, PNG는 OxiPNG 또는 Quantizr+OxiPNG, WebP는 libwebp로 분기한다. 후보는 최대 3개다.
- [codecs/jpeg.ts](../../apps/image-engine/src/codecs/jpeg.ts): JPEG 압축은 `cjpeg` 또는 무손실용 `jpegtran` 실행이다. [normalize.ts](../../apps/image-engine/src/pipeline/normalize.ts)는 Sharp를 이용한다. 따라서 Sharp 교체와 JPEG 압축기 교체는 같은 변경이 아니다.
- [Dockerfile](../../apps/image-engine/Dockerfile): 자체 libvips와 Sharp native addon을 빌드하고 사전 빌드 `@img/sharp-*` 패키지를 배제한다. 일반 npm Sharp로 바꾸면 관리가 줄 수 있지만, 현재 포맷 제한·배포 정책·라이선스 목록도 함께 달라질 수 있어 동등 대체로 단정할 수 없다.

## 지금 쓸 만한 새 버전과 대안

| 선택지 | 확인한 사실 | HereIsIt 판단 |
| --- | --- | --- |
| Sharp 유지·0.35.5 업데이트 | 공식 최신은 2026-09-27의 0.35.5. 배열 길이 경계 검사, WASM 실패 처리, gain map 처리 등의 수정이다. [변경 내역](https://sharp.pixelplumbing.com/changelog/v0.35.5/) | 현재보다 한 패치 새 버전이다. 유지보수 후보이며, 압축률을 획기적으로 바꾸는 교체 근거는 아니다. |
| libvips 8.18.7 | 공식 최신 릴리스와 저장소 고정 버전이 같다. [릴리스](https://github.com/libvips/libvips/releases/tag/v8.18.7) | 기본 처리 기술이 오래되어 생긴 문제라는 근거는 없다. |
| OxiPNG 10.2.1 | 저장소는 10.1.1. 10.2.0은 필터·감축 성능, 레벨 설정, 팔레트 및 인터레이스 최적화를 개선했다. 10.2.1은 매뉴얼 생성 메타데이터 수정이다. [10.2.0](https://github.com/oxipng/oxipng/releases/tag/v10.2.0), [10.2.1](https://github.com/oxipng/oxipng/releases/tag/v10.2.1) | 가장 작은 PNG 개선 후보. 동일 픽셀·투명도·메타데이터 정책을 확인하고 CPU 시간과 크기를 비교한 뒤 업데이트한다. 개선 폭은 미측정이다. |
| jpegli | Google의 JPEG 호환 인코더. Google은 2024년 발표에서 고품질 설정의 압축률 개선을 보고했다. 이미 저장소의 비교 후보다. 확인한 공식 GitHub Releases 페이지에는 릴리스가 없고 최신 릴리스 API도 404다. [공식 소개](https://opensource.googleblog.com/2024/04/introducing-jpegli-new-jpeg-coding-library.html), [소스](https://github.com/google/jpegli), [릴리스 현황](https://github.com/google/jpegli/releases) | JPEG만 개선할 첫 비교 후보. Google의 특정 조건 결과를 우리 서비스 전체의 절감률로 옮겨 쓰면 안 된다. 고정 commit·색상·배포 검증이 필요하다. |
| MozJPEG / libjpeg-turbo | MozJPEG 공식 최신은 현재와 같은 4.1.1. libjpeg-turbo 최신은 3.2.0이며 SIMD 기반 JPEG 처리에 집중한다. [MozJPEG 릴리스](https://github.com/mozilla/mozjpeg/releases/tag/v4.1.1), [turbo 릴리스](https://github.com/libjpeg-turbo/libjpeg-turbo/releases/tag/3.2.0), [turbo 설명](https://github.com/libjpeg-turbo/libjpeg-turbo) | turbo는 처리시간·CPU 비용 비교 후보이지 더 작은 파일을 보장하는 후속 제품이 아니다. 기존 MozJPEG를 제거하기 전에 같은 화질로 비교해야 한다. |
| Quantizr / pngquant | Quantizr 최신 1.4.3은 현재와 같다. pngquant는 손실 팔레트 PNG 압축기이며 공식 페이지는 GPL 또는 상용 라이선스를 안내한다. [Quantizr 릴리스](https://github.com/DarthSim/quantizr/releases/tag/v1.4.3), [Quantizr](https://github.com/DarthSim/quantizr), [pngquant](https://pngquant.org/) | pngquant는 새로 나온 범용 Sharp 대체가 아니다. Quantizr 대비 실제 이득이 없으면 의존성을 늘리지 않는다. 라이선스 표기는 도입 조건 확인용이며 법률 판단은 아니다. |
| zenjpeg 0.8.4 | jpegli 아이디어에서 출발한 새 Rust JPEG 구현. 공식 문서는 메모리 제한, 스트리밍, 지각 최적화를 설명하지만 decoder API를 prerelease로 명시한다. AGPL 또는 상용 이중 라이선스다. [공식 저장소](https://github.com/imazen/zenjpeg), [릴리스](https://github.com/imazen/zenjpeg/releases/tag/v0.8.4) | 새로운 유망 후보는 존재한다. 다만 저관리 서비스의 즉시 교체 대상으로 권하지 않는다. 작성자의 자체 성능 주장은 우리 입력에 대한 검증이 아니다. |
| Imageflow | Node 바인딩과 독립 실행 도구를 제공한다. 공식 최신 릴리스 API는 이름에 `rc`가 있는 `v2.3.1-rc01`을 반환한다. AGPL 라이선스와 상용 예외 안내가 있다. [저장소](https://github.com/imazen/imageflow), [릴리스](https://github.com/imazen/imageflow/releases/tag/v2.3.1-rc01) | 전체 파이프라인 교체 비용이 크다. 공식 사이트의 ImageMagick 대비 속도 주장은 현재 HereIsIt 대비 우월성 증거가 아니다. |
| imgproxy 4.0.17 | libvips 기반 독립 이미지 처리 서버. URL 서명·이미지 크기 제한 등을 제공하며 Apache-2.0이다. [저장소](https://github.com/imgproxy/imgproxy), [릴리스](https://github.com/imgproxy/imgproxy/releases/tag/v4.0.17) | 서버 래퍼를 줄일 목적이면 후보지만 기반 코덱의 혁신은 아니다. 업로드·작업 상태·다운로드·삭제·예산 제어를 자동으로 대체해 주지 않는다. 지금 도입할 우선순위는 낮다. |
| ImageMagick | 광범위한 포맷·편집 기능의 범용 도구이며 공식 설명도 환경에 맞는 보안 정책을 권한다. [공식 저장소](https://github.com/ImageMagick/ImageMagick) | JPEG/PNG/WebP 압축 문제를 해결하기 위해 더 넓은 기능과 설정을 들일 이유는 현재 없다. |
| jSquash WASM | 브라우저·Web Worker 중심 코덱 묶음이다. 프로젝트 스스로 Node 지원이 제한적이며 Node용으로 Sharp 등을 안내한다. [공식 저장소](https://github.com/jamsinclair/jSquash) | 로컬 처리 품질을 높일 별도 후보. 서버 Sharp의 더 좋은 대체라는 주장은 부적절하다. 다운로드 크기·모바일 메모리·처리시간을 실제 기기에서 확인해야 한다. |

AVIF/JPEG XL은 JPEG/PNG/WebP 파일을 같은 형식으로 줄이는 작업과 다른 **출력 형식 변경**이다. Sharp 자체에 AVIF 출력이 있으며, JXL 출력은 공식 문서상 실험적이고 일반 사전 빌드에 포함되지 않는다. 포맷 확대를 엔진 교체 이유로 삼지 않는다. 이 조사에서는 최신 브라우저 지원률을 측정하지 않았다. [Sharp 출력 문서](https://sharp.pixelplumbing.com/api-output/)

## 현재 비교 코드에서 빠진 것

[benchmark-jpeg-encoders.mjs](../../scripts/benchmark-jpeg-encoders.mjs)는 MozJPEG와 jpegli 양쪽에 `quality: 82`를 넣고 파일 크기·시간·해시를 받는다. 품질·메모리 합격 값은 항상 `false`이며, CLI 직접 실행은 기본 보고서를 출력한다. 즉, 비교 골격은 있지만 이 파일 자체가 동등 화질 비교나 운영 승격을 끝내 주지는 않는다.

`quality=82`라는 숫자를 맞추는 것만으로 서로 다른 인코더의 화질이 같아지지는 않는다. 같은 입력·크기·색공간·투명도·메타데이터 정책을 유지하고 기존 [benchmark-image-engine.mjs](../../scripts/benchmark-image-engine.mjs)의 SSIMULACRA2/Butteraugli 측정을 재사용해 유사 화질의 크기를 비교해야 한다. 사진, 작은 글씨, 화면 캡처, 그라데이션, 이미 압축된 JPEG를 포함하고 처리시간의 상위 지연·최대 메모리도 함께 본다. 무손실 경로는 지각 점수 대신 기존 정확성 검증을 유지한다.

권고하는 비교는 현행 구성, 기본 Sharp 구성, jpegli JPEG 경로의 세 가지까지만이다. 기본 Sharp 비교에서도 JPEG 무손실 경로처럼 API 하나로 동일 계약을 만족하지 못하는 기능은 별도로 표시해야 한다. 후보를 계속 추가하지 말고, 최소 기능 보장과 비용 한도를 먼저 정한 뒤 가장 단순하게 통과하는 구성을 고른다.

## 실행 순서

1. 공개 압축의 차단 원인을 해소하고 업로드 → 압축 → 다운로드 → 삭제를 확인한다. 코덱 교체로 작업 허용·비용 집계의 문제를 해결하려 하지 않는다.
2. Sharp 0.35.5와 OxiPNG 10.2.1을 별도 작은 변경으로 검증한다. 현재 Dockerfile의 버전 고정·도구 체인·SBOM·정확성 검증도 함께 맞춘다. 업데이트가 압축률 개선 또는 운영 복구를 보장한다고 말하지 않는다.
3. 엔진 성능 개선이 여전히 필요하면 기존 jpegli 비교 골격에 품질·메모리 측정을 연결한다. 최대 압축률뿐 아니라 사용자가 기다리는 시간과 작업당 비용을 판단 기준으로 둔다.
4. 기본 구성과 비교해서 이득이 작은 커스텀 경로만 제거한다. 입력 제한, 취소·시간 제한, 투명도·색상 보장, 더 커진 결과의 반환 방지, 파일 삭제는 유지한다.

이 문서는 최신 후보와 코드 구조를 확인한 조사다. 실제 업로드 이미지로 경쟁 벤치마크를 실행하지 않았으므로 어느 후보가 HereIsIt에서 몇 퍼센트 더 작거나 빠른지는 아직 알 수 없다.

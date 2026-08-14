---
name: HereIsIt
description: 빠르고 정직한 로컬 우선 파일 작업대
colors:
  paper: "#f7f7f2"
  ink: "#17191f"
  muted: "#6b6f7a"
  line: "#dadde3"
  action-blue: "#3d5afe"
  action-blue-dark: "#263dcc"
  highlighter-yellow: "#ffd84d"
  safe-green: "#16845b"
  warning-red: "#c83b3b"
  panel: "#ffffff"
typography:
  display:
    fontFamily: "Pretendard, Apple SD Gothic Neo, Noto Sans KR, Inter, system-ui, sans-serif"
    fontSize: "clamp(54px, 7vw, 92px)"
    fontWeight: 900
    lineHeight: 0.95
    letterSpacing: "-0.07em"
  headline:
    fontFamily: "Pretendard, Apple SD Gothic Neo, Noto Sans KR, Inter, system-ui, sans-serif"
    fontSize: "clamp(32px, 4vw, 52px)"
    fontWeight: 800
    lineHeight: 1.06
    letterSpacing: "-0.055em"
  title:
    fontFamily: "Pretendard, Apple SD Gothic Neo, Noto Sans KR, Inter, system-ui, sans-serif"
    fontSize: "clamp(18px, 2vw, 23px)"
    fontWeight: 850
    lineHeight: 1.25
    letterSpacing: "-0.035em"
  body:
    fontFamily: "Pretendard, Apple SD Gothic Neo, Noto Sans KR, Inter, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.7
    letterSpacing: "-0.02em"
  label:
    fontFamily: "Pretendard, Apple SD Gothic Neo, Noto Sans KR, Inter, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 800
    lineHeight: 1.4
    letterSpacing: "0.08em"
rounded:
  focus: "4px"
  control-sm: "8px"
  control: "10px"
  card: "16px"
  panel: "18px"
  dropzone: "20px"
  pill: "999px"
spacing:
  xxs: "4px"
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "24px"
  xl: "32px"
  xxl: "48px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0 18px"
    height: "48px"
  button-primary-hover:
    backgroundColor: "{colors.action-blue-dark}"
    textColor: "{colors.panel}"
  button-secondary:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0 14px"
    height: "44px"
  input-search:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 14px"
    height: "46px"
  card-tool:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "24px"
  chip-privacy:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "0 14px"
    height: "36px"
---

# Design System: HereIsIt

## Overview

**Creative North Star: "친절한 편집 작업대"**

HereIsIt은 종이 위에 필요한 도구만 정갈하게 펼쳐 놓은 편집 작업대처럼 보여야 한다. 따뜻한 종이색 바탕과 먹색 글자, 굵은 편집형 제목이 사용자를 바로 작업으로 이끌고, 액션 블루와 형광 노랑이 선택과 반응을 짧고 분명하게 표시한다.

분위기는 차분하고 유능하며 정직하다. 화면은 장식보다 도구의 목적, 처리 위치, 현재 상태와 다음 행동을 우선한다. 흔한 SaaS 대시보드, 글래스모피즘과 과한 그라데이션은 사용하지 않는다.

**Key Characteristics:**

- 따뜻한 종이 바탕과 선명한 먹색 대비
- 크고 압축적인 한국어 제목과 읽기 편한 본문
- 평면을 기본으로 하고 상호작용에서만 드러나는 노란 오프셋 그림자
- 한 화면의 주요 행동 하나와 최소 44px 터치 영역
- 로컬 처리, 서버 전송과 상태를 숨기지 않는 시각 언어

## Colors

팔레트는 종이와 먹색의 차분한 중립 위에 액션 블루, 형광 노랑과 의미 기반 상태색을 제한적으로 올린다.

### Primary

- **액션 블루:** 링크, 선택 테두리, 포커스와 안내처럼 사용자가 행동할 지점에 사용한다.
- **깊은 액션 블루:** 주요 버튼의 호버와 작은 텍스트 링크처럼 더 강한 대비가 필요한 상태에 사용한다.

### Secondary

- **형광 노랑:** 제목의 밑줄, 선택된 즐겨찾기와 카드 호버 그림자처럼 짧은 강조에만 사용한다.

### Tertiary

- **안전 그린:** 로컬 실행, 준비 완료와 성공 상태를 표시한다.
- **경고 레드:** 오류, 잘못된 입력과 주의가 필요한 경계를 표시한다.

### Neutral

- **종이:** 모든 페이지의 따뜻한 기본 배경이다.
- **먹색:** 본문보다 강한 제목, 주요 버튼과 핵심 구조선에 사용한다.
- **절제된 회색:** 설명, 보조 정보와 비활성 상태에 사용한다.
- **구분선:** 카드, 필드와 섹션을 가볍게 나누는 1px 경계다.
- **패널 화이트:** 입력, 카드와 떠 있는 메뉴의 선명한 작업 표면이다.

### Named Rules

**The Highlighter Rule.** 형광 노랑은 정보 배경이 아니라 한 번의 선택이나 움직임을 강조할 때만 사용한다.

**The Honest State Rule.** 그린과 레드는 실제 성공·실패 상태에만 사용하며 장식용으로 소비하지 않는다.

## Typography

**Display Font:** Pretendard와 한국어 시스템 산세리프 대체 글꼴

**Body Font:** Pretendard와 한국어 시스템 산세리프 대체 글꼴

**Character:** 하나의 산세리프 계열 안에서 굵기, 크기와 자간 대비로 편집물 같은 위계를 만든다. 제목은 짧고 단단하며 본문은 여유 있는 행간으로 작업 조건을 정확히 설명한다.

### Hierarchy

- **Display:** 가장 큰 페이지 약속과 홈 히어로에만 사용한다. 매우 굵고 촘촘하며 줄바꿈을 최소화한다.
- **Headline:** 섹션의 시작과 파일 작업 단계의 큰 제목에 사용한다.
- **Title:** 도구 카드, 결과 그룹과 컴포넌트 제목에 사용한다.
- **Body:** 설명과 처리 조건에 사용하며 긴 문장은 약 68ch 이내로 유지한다.
- **Label:** 탐색, 버튼, 상태 라벨과 짧은 영문 눈썹 문구에 사용한다. 영문 눈썹만 대문자와 넓은 자간을 허용한다.

### Named Rules

**The Korean First Rule.** 한국어는 억지로 쪼개지 않으며 `word-break: keep-all`과 균형 잡힌 줄바꿈을 우선한다.

**The One Promise Rule.** 한 화면에서 가장 큰 제목은 사용자가 지금 끝낼 수 있는 작업 하나만 약속한다.

## Layout

기본 콘텐츠는 최대 1280px, 사이트 헤더와 푸터는 최대 1440px 안에 놓고 데스크톱에서 좌우 24px 여백을 둔다. 도구 상세의 핵심 설명은 760px 안으로 좁혀 읽기 흐름을 유지하고, 카드 영역만 더 넓게 펼친다.

레이아웃은 24px을 중심 리듬으로 사용하고 내부 제어에는 8px, 12px, 16px 간격을 반복한다. 데스크톱의 3열 도구 그리드는 중간 화면에서 2열, 작은 화면에서 1열로 단순화한다. 1040px은 복잡한 카탈로그 전환, 800px은 주요 모바일 재배치, 600px은 밀도 축소, 420px은 좁은 카드 보정 기준이다.

모바일에서는 페이지 좌우 여백을 12px까지 줄이되 상호작용 대상은 최소 44px을 유지한다. 주요 버튼은 필요할 때 전체 너비가 되고, 부가 설명과 카드 내용은 세로로 쌓인다.

## Elevation & Depth

기본 표면은 평면이며 1px 테두리와 종이·패널의 색 차이로 깊이를 만든다. 도구 카드가 호버될 때만 형광 노랑의 단단한 오프셋 그림자가 나타나고, 검색 목록과 메가 메뉴처럼 실제로 떠 있는 레이어에만 부드러운 주변 그림자를 사용한다.

### Shadow Vocabulary

- **작업 반응:** 노란 5px 오프셋 그림자는 일반 도구 카드의 호버에 사용한다.
- **큰 작업 반응:** 노란 7px 오프셋 그림자는 홈의 큰 도구 카드처럼 더 넓은 표면에 사용한다.
- **떠 있는 레이어:** 부드러운 18px–64px 주변 그림자는 검색 결과, 메뉴와 오버레이에만 사용한다.

### Named Rules

**The Flat by Default Rule.** 정지 상태의 카드에는 그림자를 두지 않고, 그림자는 상호작용 또는 실제 레이어 관계를 설명할 때만 나타낸다.

## Shapes

컨트롤은 8–10px의 완만한 모서리, 카드는 16px, 큰 패널은 18px, 파일 드롭존은 20px을 사용한다. 상태 칩과 원형 버튼은 완전한 필 형태를 사용한다. 대부분의 표면은 1px 구분선으로 닫고, 드롭존만 2px 점선 경계로 입력 가능 영역을 알린다.

브랜드 마크와 일부 파일 미리보기는 한쪽 모서리만 더 작게 만들어 종이를 접거나 표시한 듯한 비대칭을 허용한다. 이 비대칭은 서명 요소에만 사용하고 모든 카드에 반복하지 않는다.

## Components

컴포넌트는 도구 중심이며 주요 행동 하나, 큰 터치 영역, 분명한 상태와 최소한의 장식으로 구성한다.

### Buttons

- **Shape:** 주요 컨트롤은 단단하고 완만한 10px 모서리와 최소 44px 높이를 가진다.
- **Primary:** 먹색 바탕과 종이색 글자를 사용하며 실행 버튼은 보통 48px 높이다.
- **Hover / Focus:** 호버에서 깊은 액션 블루로 바뀌고, 키보드 포커스는 3px 액션 블루 링과 명확한 오프셋을 사용한다.
- **Secondary:** 패널 화이트, 먹색 글자와 구분선 테두리를 사용한다.
- **Disabled:** 구분선 색의 배경과 절제된 회색 글자로 상태를 즉시 구분하며 포인터 상호작용을 암시하지 않는다.

### Chips

- **Style:** 필 형태의 얇은 테두리 안에 짧은 상태 문구를 넣는다.
- **State:** 개인정보 보호 칩은 작은 안전 그린 점과 옅은 링으로 로컬 상태를 표시하고, 선택 칩은 형광 노랑을 제한적으로 사용한다.

### Cards / Containers

- **Corner Style:** 일반 도구 카드는 16px 모서리를 사용한다.
- **Background:** 패널 화이트 또는 종이색이 살짝 섞인 패널을 사용한다.
- **Shadow Strategy:** 정지 상태에는 그림자가 없고 호버 가능한 카드만 노란 오프셋 그림자를 가진다.
- **Border:** 기본은 1px 구분선이며 호버에서 먹색으로 선명해진다.
- **Internal Padding:** 보통 24px, 작은 카드와 모바일에서는 18px까지 줄인다.

### Inputs / Fields

- **Style:** 패널 화이트 바탕, 1px 구분선, 10px 모서리와 최소 46px 높이를 사용한다.
- **Focus:** 테두리를 액션 블루로 바꾸고 옅은 3px 링을 추가한다.
- **Error / Disabled:** 오류는 경고 레드와 행동 가능한 한국어 설명을 함께 제공하고, 비활성은 회색만으로 숨기지 않고 실제 `disabled` 상태를 사용한다.

### Navigation

데스크톱 탐색은 42px 높이의 작고 굵은 라벨을 사용한다. 기본 상태는 절제된 회색이며 호버, 펼침과 현재 위치에서 패널 화이트와 먹색으로 전환한다. 모바일은 44px 메뉴 버튼과 세로 드로어로 바꾸되 검색과 핵심 도구 접근을 유지한다.

### File Dropzone

큰 20px 모서리와 2px 점선 액션 블루 경계로 파일 선택 영역을 분명히 한다. 드래그 중에는 실선과 옅은 블루 표면으로 즉시 반응하며, 파일이 업로드되는지 로컬에서 확인되는지 가까운 문구로 설명한다.

## Do's and Don'ts

### Do:

- **Do** 한 화면에서 사용자가 선택할 주요 행동을 하나만 가장 강하게 표시한다.
- **Do** 종이 배경, 패널, 테두리와 상태색으로 위계를 설명하고 장식보다 상태를 우선한다.
- **Do** 최소 44px 터치 영역, 3px 키보드 포커스와 축소 동작 설정을 유지한다.
- **Do** 모바일에서 내용을 세로로 쌓고 한국어 문장을 자연스럽게 줄바꿈한다.
- **Do** 로컬 처리와 서버 전송 여부를 행동 전에 가까운 문구로 명시한다.

### Don't:

- **Don't** 흔한 SaaS 대시보드, 글래스모피즘 또는 과한 그라데이션을 도입한다.
- **Don't** 모든 카드에 그림자나 형광 노랑을 사용해 강조의 위계를 없앤다.
- **Don't** 한 화면에 동등하게 강한 주요 버튼을 여러 개 배치한다.
- **Don't** 개인정보 보호, 진행 상태 또는 오류를 아이콘과 색상만으로 설명한다.
- **Don't** 미래의 로그인·유료 기능을 현재 사용할 수 있는 기능처럼 시각적으로 약속한다.

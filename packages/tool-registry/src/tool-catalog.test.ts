import {
  IMAGE_TOOL_ID,
  IMAGE_TOOL_VERSION,
  IMAGE_WATERMARK_TOOL_ID,
  IMAGE_WATERMARK_TOOL_VERSION,
  JSON_FORMAT_TOOL_ID,
  JSON_FORMAT_TOOL_VERSION,
} from "@hereisit/tool-contracts";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type AvailableToolId,
  availableToolEntries,
  defineToolCatalog,
  domainDefinitions,
  domainFilterDefinitions,
  findAvailableToolById,
  findToolById,
  getAvailableToolById,
  getRelatedAvailableTools,
  plannedToolEntries,
  purposeDefinitions,
  toolCatalog,
} from "./tool-catalog";

type ExpectedAvailableToolId =
  | "data.json-format"
  | "image.blur-face"
  | "image.compress"
  | "image.convert"
  | "image.convert-from-jpg"
  | "image.convert-to-jpg"
  | "image.crop"
  | "image.editor"
  | "image.html-to-image"
  | "image.meme"
  | "image.remove-background"
  | "image.resize"
  | "image.rotate"
  | "image.upscale"
  | "image.watermark";

const expectedAliases = {
  "data.json-format": ["json 정리", "json 포맷", "json 검사", "json 축소"],
  "image.blur-face": ["얼굴 흐리기", "모자이크", "번호판 흐리기", "개인정보 가리기"],
  "image.compress": ["사진 압축", "이미지 최적화", "용량 줄이기", "jpg 압축", "png 압축"],
  "image.resize": ["사진 크기", "리사이즈", "해상도 변경", "정사각형 자르기"],
  "image.crop": ["사진 자르기", "이미지 자르기", "크롭", "비율 자르기"],
  "image.convert": ["이미지 변환", "jpg 변환", "png 변환", "webp 변환", "heic 변환"],
  "image.convert-from-jpg": ["jpg에서 변환", "jpg png", "jpg gif", "움짤 만들기"],
  "image.convert-to-jpg": ["jpg 변환", "jpeg 변환", "사진 jpg"],
  "image.editor": ["사진 편집", "이미지 편집", "필터", "사진 효과"],
  "image.html-to-image": ["html 이미지", "웹페이지 이미지", "스크린샷 만들기"],
  "image.meme": ["밈 만들기", "밈 생성기", "짤 만들기", "meme"],
  "image.remove-background": ["배경 지우기", "누끼 따기", "배경 제거"],
  "image.rotate": ["사진 회전", "이미지 회전", "90도 회전"],
  "image.upscale": ["이미지 확대", "사진 화질 개선", "업스케일"],
  "image.watermark": ["사진 워터마크", "로고 넣기", "문구 넣기"],
} as const satisfies Record<ExpectedAvailableToolId, readonly string[]>;

const expectedRelatedToolIds = {
  "data.json-format": ["image.convert", "image.html-to-image", "image.editor"],
  "image.blur-face": ["image.remove-background", "image.watermark", "image.editor"],
  "image.compress": ["image.resize", "image.convert", "image.watermark"],
  "image.resize": ["image.compress", "image.convert", "image.watermark"],
  "image.crop": ["image.resize", "image.rotate", "image.compress"],
  "image.convert": ["image.compress", "image.resize", "image.watermark"],
  "image.convert-from-jpg": ["image.convert-to-jpg", "image.convert", "image.editor"],
  "image.convert-to-jpg": ["image.convert", "image.compress", "image.resize"],
  "image.editor": ["image.meme", "image.watermark", "image.crop"],
  "image.html-to-image": ["image.editor", "image.convert", "data.json-format"],
  "image.meme": ["image.editor", "image.watermark", "image.convert"],
  "image.remove-background": ["image.upscale", "image.editor", "image.convert"],
  "image.rotate": ["image.crop", "image.resize", "image.convert"],
  "image.upscale": ["image.compress", "image.resize", "image.editor"],
  "image.watermark": ["image.compress", "image.resize", "image.editor"],
} as const satisfies Record<ExpectedAvailableToolId, readonly [string, string, string]>;

const expectedContracts = {
  "data.json-format": [JSON_FORMAT_TOOL_ID, JSON_FORMAT_TOOL_VERSION],
  "image.blur-face": ["image.blur-face", 1],
  "image.compress": ["image.optimize", 1],
  "image.resize": [IMAGE_TOOL_ID, IMAGE_TOOL_VERSION],
  "image.crop": [IMAGE_TOOL_ID, IMAGE_TOOL_VERSION],
  "image.convert": [IMAGE_TOOL_ID, IMAGE_TOOL_VERSION],
  "image.convert-from-jpg": ["image.convert-from-jpg", 1],
  "image.convert-to-jpg": ["image.convert-to-jpg", 1],
  "image.editor": ["image.editor", 1],
  "image.html-to-image": ["image.html-to-image", 1],
  "image.meme": ["image.meme", 1],
  "image.remove-background": ["image.remove-background", 1],
  "image.rotate": [IMAGE_TOOL_ID, IMAGE_TOOL_VERSION],
  "image.upscale": ["image.upscale", 1],
  "image.watermark": [IMAGE_WATERMARK_TOOL_ID, IMAGE_WATERMARK_TOOL_VERSION],
} as const satisfies Record<AvailableToolId, readonly [string, number]>;

const expectedCopy = {
  "data.json-format": {
    name: "JSON 정리·검사",
    shortDescription:
      "JSON 문법을 검사하고 읽기 좋게 정리하거나 공백을 줄이세요. 내용은 브라우저 밖으로 나가지 않습니다.",
  },
  "image.compress": {
    name: "이미지 용량 줄이기",
    shortDescription:
      "JPG, PNG, WebP 이미지를 원본 형식 그대로 압축하세요. 처리 전에 로컬 또는 임시 서버 처리 여부를 명확히 알려드려요.",
  },
  "image.blur-face": {
    name: "얼굴·개인정보 흐리기",
    shortDescription:
      "사진에서 얼굴·번호판처럼 가릴 영역을 자동으로 찾거나 직접 지정해 브라우저에서 흐리게 처리하세요.",
  },
  "image.resize": {
    name: "이미지 크기 조절",
    shortDescription:
      "사진의 가로·세로 크기를 빠르게 바꾸세요. 업로드 없이 긴 변 축소와 정사각형 자르기를 한 번에 처리합니다.",
  },
  "image.crop": {
    name: "이미지 자르기",
    shortDescription:
      "원하는 비율로 이미지의 필요한 부분만 잘라내세요. 파일은 서버로 전송되지 않습니다.",
  },
  "image.convert": {
    name: "이미지 형식 변환",
    shortDescription:
      "JPG, PNG, WebP, GIF, HEIC 이미지를 원하는 형식으로 변환하세요. 파일은 서버로 전송되지 않습니다.",
  },
  "image.convert-from-jpg": {
    name: "JPG에서 변환",
    shortDescription:
      "JPG 이미지를 PNG로 바꾸거나 여러 장을 움직이는 GIF로 만드세요. 파일은 내 기기에서 처리합니다.",
  },
  "image.convert-to-jpg": {
    name: "JPG로 변환",
    shortDescription:
      "PNG, GIF, WebP, SVG 등 이미지를 JPG로 바꾸세요. 여러 파일도 내 기기에서 한 번에 처리합니다.",
  },
  "image.rotate": {
    name: "이미지 회전",
    shortDescription: "이미지를 90도 단위로 빠르게 회전하세요. 파일은 서버로 전송되지 않습니다.",
  },
  "image.editor": {
    name: "사진 편집",
    shortDescription:
      "밝기·대비·채도·필터·프레임·스티커와 문구를 조절해 사진을 내 기기에서 편집하세요.",
  },
  "image.html-to-image": {
    name: "HTML을 이미지로",
    shortDescription: "HTML과 CSS를 붙여 넣어 외부 업로드 없이 PNG 이미지로 렌더링하세요.",
  },
  "image.meme": {
    name: "밈 만들기",
    shortDescription: "사진 위아래에 문구를 넣어 밈 이미지를 빠르게 만들어 다운로드하세요.",
  },
  "image.remove-background": {
    name: "배경 지우기",
    shortDescription: "사진 가장자리와 연결된 배경색을 자동으로 지워 투명 PNG로 저장하세요.",
  },
  "image.upscale": {
    name: "이미지 확대",
    shortDescription: "JPG·PNG 이미지를 2배 또는 4배로 확대해 더 큰 크기로 저장하세요.",
  },
  "image.watermark": {
    name: "이미지에 워터마크 넣기",
    shortDescription: "사진과 이미지에 문구 또는 로고를 넣으세요. 파일은 서버로 전송되지 않습니다.",
  },
} as const satisfies Record<ExpectedAvailableToolId, { name: string; shortDescription: string }>;

function expectInvalidCatalog(
  mutate: (entries: Array<Record<string, unknown>>) => void,
  message: RegExp,
): void {
  const broken = structuredClone(toolCatalog) as unknown as Array<Record<string, unknown>>;
  mutate(broken);
  expect(() => defineToolCatalog(broken as never)).toThrow(message);
}

describe("tool catalog", () => {
  it("publishes 15 real tools and one honest roadmap card", () => {
    expect(availableToolEntries).toHaveLength(15);
    expect(plannedToolEntries.map((tool) => tool.id)).toEqual(["media.video-compress"]);
    expect(getAvailableToolById("image.compress")).toMatchObject({
      route: "/image/compress",
      launcherInput: {
        kinds: ["image/jpeg", "image/png", "image/webp"],
        maxFiles: 20,
      },
      contract: { id: "image.optimize", version: 1 },
      experience: "file",
      execution: "server",
    });
    expect(getAvailableToolById("data.json-format")).toMatchObject({
      route: "/data/json",
      launcherInput: null,
      outputKinds: ["application/json", "value/text"],
      contract: { id: "json.format", version: 1 },
      experience: "quick",
      execution: "browser",
    });
  });

  it("keeps IDs, routes, aliases, and intentional relations valid", () => {
    expect(new Set(toolCatalog.map((tool) => tool.id)).size).toBe(toolCatalog.length);
    expect(new Set(availableToolEntries.map((tool) => tool.route)).size).toBe(15);
    expect(getRelatedAvailableTools("image.compress").map((tool) => tool.id)).toEqual([
      "image.resize",
      "image.convert",
      "image.watermark",
    ]);
    expect(
      Object.fromEntries(availableToolEntries.map((tool) => [tool.id, tool.searchAliases])),
    ).toEqual(expectedAliases);
    expect(
      Object.fromEntries(availableToolEntries.map((tool) => [tool.id, tool.relatedToolIds])),
    ).toEqual(expectedRelatedToolIds);
  });

  it("rejects executable fields on a planned entry", () => {
    expect(() =>
      defineToolCatalog([
        {
          id: "media.fake",
          name: "가짜 도구",
          shortDescription: "경계 검증용 도구",
          domains: ["media"],
          purposes: ["convert"],
          searchAliases: [],
          rank: 1,
          availability: "planned",
          route: "/fake",
        },
      ] as never),
    ).toThrow(/planned/i);
  });

  it("rejects missing, planned, duplicate, or self-related tools", () => {
    const broken = structuredClone(availableToolEntries) as unknown as Array<
      Record<string, unknown>
    >;
    broken[0] = {
      ...broken[0],
      relatedToolIds: ["image.compress", "missing.tool", "media.video-compress"],
    };
    expect(() => defineToolCatalog(broken as never)).toThrow(/related/i);

    expectInvalidCatalog((entries) => {
      entries[0] = { ...entries[0], relatedToolIds: ["image.resize", "image.resize"] };
    }, /related count/i);
    expectInvalidCatalog((entries) => {
      entries[0] = {
        ...entries[0],
        relatedToolIds: ["image.compress", "image.convert", "image.watermark"],
      };
    }, /self-related/i);
    expectInvalidCatalog((entries) => {
      entries[0] = {
        ...entries[0],
        relatedToolIds: ["missing.tool", "image.convert", "image.watermark"],
      };
    }, /related missing\.tool/i);
    expectInvalidCatalog((entries) => {
      entries[0] = {
        ...entries[0],
        relatedToolIds: ["media.video-compress", "image.convert", "image.watermark"],
      };
    }, /related media\.video-compress/i);
  });

  it("publishes the exact taxonomy and current site copy", () => {
    expect(domainDefinitions).toEqual([
      { id: "image", label: "이미지", description: "사진과 이미지 작업 도구를 모았어요." },
      {
        id: "media",
        label: "영상·오디오",
        description: "영상과 오디오 작업 도구를 모았어요.",
      },
      {
        id: "data",
        label: "데이터·변환",
        description: "데이터와 형식 변환 도구를 모았어요.",
      },
      {
        id: "text-ai",
        label: "텍스트·AI",
        description: "텍스트와 명시적으로 안내된 AI 도구를 모았어요.",
      },
      {
        id: "web-dev",
        label: "웹·개발",
        description: "웹과 개발 작업 도구를 모았어요.",
      },
      {
        id: "everyday",
        label: "생활·계산",
        description: "생활에 필요한 계산 도구를 모았어요.",
      },
    ]);
    expect(domainFilterDefinitions).toEqual([
      {
        id: "all",
        label: "전체·추천",
        description: "최근 사용한 도구와 추천 도구를 모았어요.",
      },
      ...domainDefinitions,
    ]);
    expect(purposeDefinitions).toEqual([
      { id: "optimize", label: "압축·최적화" },
      { id: "convert", label: "변환" },
      { id: "edit", label: "편집" },
      { id: "create", label: "만들기" },
      { id: "extract", label: "추출·분석" },
      { id: "protect", label: "보안·표시" },
    ]);
    expect(
      Object.fromEntries(
        availableToolEntries.map(({ id, name, shortDescription }) => [
          id,
          { name, shortDescription },
        ]),
      ),
    ).toEqual(expectedCopy);
  });

  it("publishes the approved order, launch limits, and output kinds", () => {
    expect(availableToolEntries.map((tool) => tool.id)).toEqual([
      "image.compress",
      "image.resize",
      "image.crop",
      "image.convert",
      "image.rotate",
      "image.watermark",
      "image.convert-to-jpg",
      "image.convert-from-jpg",
      "image.editor",
      "image.meme",
      "image.html-to-image",
      "image.upscale",
      "image.blur-face",
      "image.remove-background",
      "data.json-format",
    ]);

    const imageKinds = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
    const animatedImageKinds = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
      "image/heic",
      "image/heif",
    ];
    const extraImageKinds = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
      "image/tiff",
      "image/svg+xml",
      "image/heic",
      "image/heif",
    ];
    const expectedExecution = {
      "image.compress": [
        ["image/jpeg", "image/png", "image/webp"],
        1,
        20,
        true,
        ["image/jpeg", "image/png", "image/webp"],
      ],
      "image.resize": [
        animatedImageKinds,
        1,
        100,
        true,
        ["image/jpeg", "image/png", "image/webp", "image/gif"],
      ],
      "image.crop": [
        ["image/jpeg", "image/png", "image/webp", "image/gif"],
        1,
        100,
        true,
        ["image/jpeg", "image/png", "image/webp", "image/gif"],
      ],
      "image.convert": [
        animatedImageKinds,
        1,
        100,
        true,
        ["image/jpeg", "image/png", "image/webp", "image/gif"],
      ],
      "image.rotate": [
        ["image/jpeg", "image/png", "image/webp", "image/gif"],
        1,
        100,
        true,
        ["image/jpeg", "image/png", "image/webp", "image/gif"],
      ],
      "image.watermark": [imageKinds, 1, 100, true, ["image/jpeg", "image/png", "image/webp"]],
      "image.convert-to-jpg": [extraImageKinds, 1, 100, true, ["image/jpeg", "application/zip"]],
      "image.convert-from-jpg": [
        ["image/jpeg"],
        1,
        20,
        false,
        ["image/png", "image/gif", "application/zip"],
      ],
      "image.editor": [
        ["image/jpeg", "image/png", "image/webp"],
        1,
        1,
        false,
        ["image/jpeg", "image/png"],
      ],
      "image.meme": [
        ["image/jpeg", "image/png", "image/webp"],
        1,
        1,
        false,
        ["image/jpeg", "image/png"],
      ],
      "image.html-to-image": [undefined, undefined, undefined, undefined, ["image/png"]],
      "image.upscale": [["image/jpeg", "image/png"], 1, 20, true, ["image/jpeg", "image/png"]],
      "image.blur-face": [
        ["image/jpeg", "image/png", "image/webp"],
        1,
        1,
        false,
        ["image/jpeg", "image/png"],
      ],
      "image.remove-background": [
        ["image/jpeg", "image/png", "image/webp"],
        1,
        20,
        true,
        ["image/png"],
      ],
      "data.json-format": [
        undefined,
        undefined,
        undefined,
        undefined,
        ["application/json", "value/text"],
      ],
    } as const;

    expect(
      Object.fromEntries(
        availableToolEntries.map((tool) => [
          tool.id,
          [
            tool.launcherInput?.kinds,
            tool.launcherInput?.minFiles,
            tool.launcherInput?.maxFiles,
            tool.launcherInput?.allowMixedKinds,
            tool.outputKinds,
          ],
        ]),
      ),
    ).toEqual(expectedExecution);
  });

  it("derives exact available IDs and keeps lookups availability-aware", () => {
    expectTypeOf<AvailableToolId>().toEqualTypeOf<ExpectedAvailableToolId>();
    expect(findToolById("media.video-compress")).toBe(plannedToolEntries[0]);
    expect(findAvailableToolById("media.video-compress")).toBeUndefined();
    expect(findToolById("missing.tool")).toBeUndefined();
    expect(findAvailableToolById("missing.tool")).toBeUndefined();
    expect(getRelatedAvailableTools("image.convert").map((tool) => tool.id)).toEqual([
      "image.compress",
      "image.resize",
      "image.watermark",
    ]);
  });

  it("keeps the roadmap record non-clickable and non-executable", () => {
    expect(plannedToolEntries).toEqual([
      {
        id: "media.video-compress",
        name: "동영상 용량 줄이기",
        shortDescription: "브라우저에서 동영상 용량을 줄이는 기능을 준비하고 있어요.",
        domains: ["media"],
        purposes: ["optimize"],
        searchAliases: ["영상 압축", "동영상 압축", "mp4 압축"],
        rank: 10,
        availability: "planned",
      },
    ]);
    for (const key of [
      "route",
      "contract",
      "execution",
      "experience",
      "launcherInput",
      "relatedToolIds",
    ]) {
      expect(plannedToolEntries[0]).not.toHaveProperty(key);
    }
  });

  it("matches every catalog contract to its processor constant", () => {
    for (const tool of availableToolEntries) {
      const [id, version] = expectedContracts[tool.id];
      expect(tool.contract).toEqual({ id, version });
    }
  });

  it("clones and freezes validated catalog arrays and entries", () => {
    const source = structuredClone(toolCatalog);
    const validated = defineToolCatalog(source);

    expect(validated).not.toBe(source);
    expect(validated[0]).not.toBe(source[0]);
    expect(Object.isFrozen(validated)).toBe(true);
    expect(validated.every(Object.isFrozen)).toBe(true);
  });

  it("rejects duplicate IDs and routes", () => {
    expectInvalidCatalog((entries) => {
      entries[1] = { ...entries[1], id: entries[0]?.id };
    }, /duplicate ID/i);
    expectInvalidCatalog((entries) => {
      entries[1] = { ...entries[1], route: entries[0]?.route };
    }, /duplicate route/i);
  });

  it("rejects unknown or duplicate taxonomy values", () => {
    for (const [key, value, message] of [
      ["domains", ["unknown"], /domain/i],
      ["domains", ["image", "image"], /duplicate domain/i],
      ["purposes", ["unknown"], /purpose/i],
      ["purposes", ["optimize", "optimize"], /duplicate purpose/i],
    ] as const) {
      expectInvalidCatalog((entries) => {
        entries[0] = { ...entries[0], [key]: value };
      }, message);
    }
  });

  it("rejects empty, unnormalized, trimmed, or duplicate aliases", () => {
    for (const [aliases, message] of [
      [[""], /alias normalization/i],
      [[" 앞 공백"], /alias normalization/i],
      [["e\u0301"], /alias normalization/i],
      [["PDF", "pdf"], /duplicate alias/i],
    ] as const) {
      expectInvalidCatalog((entries) => {
        entries[0] = { ...entries[0], searchAliases: aliases };
      }, message);
    }
  });

  it("rejects non-finite ranks, invalid launcher limits, and invalid contracts", () => {
    expectInvalidCatalog((entries) => {
      entries[0] = { ...entries[0], rank: Number.POSITIVE_INFINITY };
    }, /rank/i);
    expectInvalidCatalog((entries) => {
      const launcherInput = entries[0]?.launcherInput as Record<string, unknown>;
      entries[0] = { ...entries[0], launcherInput: { ...launcherInput, minFiles: 1.5 } };
    }, /launcher integers/i);
    expectInvalidCatalog((entries) => {
      const launcherInput = entries[0]?.launcherInput as Record<string, unknown>;
      entries[0] = { ...entries[0], launcherInput: { ...launcherInput, maxFiles: 0 } };
    }, /launcher range/i);
    expectInvalidCatalog((entries) => {
      entries[0] = { ...entries[0], contract: { id: " ", version: 1 } };
    }, /contract/i);
    expectInvalidCatalog((entries) => {
      entries[0] = { ...entries[0], contract: { id: "image.pipeline", version: 0 } };
    }, /contract/i);
    expectInvalidCatalog((entries) => {
      entries[0] = { ...entries[0], contract: { id: "image.pipeline", version: 1.5 } };
    }, /contract/i);
  });
});

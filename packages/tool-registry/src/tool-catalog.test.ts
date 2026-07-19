import {
  IMAGE_TOOL_ID,
  IMAGE_TOOL_VERSION,
  IMAGE_WATERMARK_TOOL_ID,
  IMAGE_WATERMARK_TOOL_VERSION,
  PDF_COMPRESS_SCANNED_TOOL_ID,
  PDF_COMPRESS_SCANNED_TOOL_VERSION,
  PDF_IMAGES_TO_PDF_TOOL_ID,
  PDF_MERGE_TOOL_ID,
  PDF_ORGANIZE_TOOL_ID,
  PDF_SPLIT_TOOL_ID,
  PDF_TO_IMAGES_TOOL_ID,
  PDF_TO_IMAGES_TOOL_VERSION,
  PDF_TOOL_VERSION,
  PDF_WATERMARK_TOOL_ID,
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
  | "image.compress"
  | "image.convert"
  | "image.resize"
  | "image.watermark"
  | "pdf.compress-scanned"
  | "pdf.image-to-pdf"
  | "pdf.merge"
  | "pdf.organize"
  | "pdf.split"
  | "pdf.to-image"
  | "pdf.watermark";

const expectedAliases = {
  "image.compress": ["사진 압축", "이미지 최적화", "용량 줄이기", "jpg 압축", "png 압축"],
  "image.resize": ["사진 크기", "리사이즈", "해상도 변경", "정사각형 자르기"],
  "image.convert": ["이미지 변환", "jpg 변환", "png 변환", "webp 변환", "heic 변환"],
  "image.watermark": ["사진 워터마크", "로고 넣기", "문구 넣기"],
  "pdf.merge": ["pdf 병합", "pdf 합치기", "문서 합치기"],
  "pdf.split": ["pdf 나누기", "페이지 추출", "pdf 분할"],
  "pdf.organize": ["페이지 순서", "pdf 회전", "페이지 삭제"],
  "pdf.watermark": ["문서 워터마크", "pdf 문구", "대외비"],
  "pdf.to-image": ["pdf jpg", "pdf png", "pdf 이미지 변환"],
  "pdf.image-to-pdf": ["jpg pdf", "png pdf", "사진 pdf"],
  "pdf.compress-scanned": ["pdf 압축", "스캔 pdf", "pdf 용량 줄이기"],
} as const satisfies Record<ExpectedAvailableToolId, readonly string[]>;

const expectedRelatedToolIds = {
  "image.compress": ["image.resize", "image.convert", "image.watermark"],
  "image.resize": ["image.compress", "image.convert", "image.watermark"],
  "image.convert": ["image.compress", "image.resize", "pdf.image-to-pdf"],
  "image.watermark": ["image.compress", "image.resize", "pdf.watermark"],
  "pdf.merge": ["pdf.split", "pdf.organize", "pdf.image-to-pdf"],
  "pdf.split": ["pdf.merge", "pdf.organize", "pdf.to-image"],
  "pdf.organize": ["pdf.merge", "pdf.split", "pdf.watermark"],
  "pdf.watermark": ["pdf.organize", "pdf.merge", "image.watermark"],
  "pdf.to-image": ["pdf.image-to-pdf", "pdf.split", "image.convert"],
  "pdf.image-to-pdf": ["pdf.to-image", "pdf.merge", "image.convert"],
  "pdf.compress-scanned": ["pdf.merge", "pdf.split", "pdf.to-image"],
} as const satisfies Record<ExpectedAvailableToolId, readonly [string, string, string]>;

const expectedContracts = {
  "image.compress": ["image.optimize", 1],
  "image.resize": [IMAGE_TOOL_ID, IMAGE_TOOL_VERSION],
  "image.convert": [IMAGE_TOOL_ID, IMAGE_TOOL_VERSION],
  "image.watermark": [IMAGE_WATERMARK_TOOL_ID, IMAGE_WATERMARK_TOOL_VERSION],
  "pdf.merge": [PDF_MERGE_TOOL_ID, PDF_TOOL_VERSION],
  "pdf.split": [PDF_SPLIT_TOOL_ID, PDF_TOOL_VERSION],
  "pdf.organize": [PDF_ORGANIZE_TOOL_ID, PDF_TOOL_VERSION],
  "pdf.watermark": [PDF_WATERMARK_TOOL_ID, PDF_TOOL_VERSION],
  "pdf.to-image": [PDF_TO_IMAGES_TOOL_ID, PDF_TO_IMAGES_TOOL_VERSION],
  "pdf.image-to-pdf": [PDF_IMAGES_TO_PDF_TOOL_ID, PDF_TOOL_VERSION],
  "pdf.compress-scanned": [PDF_COMPRESS_SCANNED_TOOL_ID, PDF_COMPRESS_SCANNED_TOOL_VERSION],
} as const satisfies Record<AvailableToolId, readonly [string, number]>;

const expectedCopy = {
  "image.compress": {
    name: "이미지 용량 줄이기",
    shortDescription:
      "JPG, PNG, WebP 이미지를 원본 형식 그대로 압축하세요. 처리 전에 로컬 또는 임시 서버 처리 여부를 명확히 알려드려요.",
  },
  "image.resize": {
    name: "이미지 크기 조절",
    shortDescription:
      "사진의 가로·세로 크기를 빠르게 바꾸세요. 업로드 없이 긴 변 축소와 정사각형 자르기를 한 번에 처리합니다.",
  },
  "image.convert": {
    name: "이미지 형식 변환",
    shortDescription:
      "JPG, PNG, WebP, HEIC 이미지를 원하는 형식으로 변환하세요. 파일은 서버로 전송되지 않습니다.",
  },
  "image.watermark": {
    name: "이미지에 워터마크 넣기",
    shortDescription: "사진과 이미지에 문구 또는 로고를 넣으세요. 파일은 서버로 전송되지 않습니다.",
  },
  "pdf.merge": {
    name: "PDF 합치기",
    shortDescription:
      "여러 PDF 파일을 원하는 순서대로 하나로 합치세요. 파일을 서버에 올리지 않고 브라우저에서 바로 처리합니다.",
  },
  "pdf.split": {
    name: "PDF 페이지 분할",
    shortDescription:
      "PDF를 페이지별로 나누거나 필요한 페이지만 추출하세요. 파일은 기기 안에서만 처리됩니다.",
  },
  "pdf.organize": {
    name: "PDF 페이지 정리",
    shortDescription:
      "PDF 페이지 순서를 바꾸고 90도씩 회전하거나 필요 없는 페이지를 빼세요. 파일은 기기 안에서만 처리됩니다.",
  },
  "pdf.watermark": {
    name: "PDF 워터마크 넣기",
    shortDescription:
      "PDF 모든 페이지 또는 지정한 페이지에 원하는 문구의 워터마크를 넣으세요. 업로드 없이 브라우저에서 처리합니다.",
  },
  "pdf.to-image": {
    name: "PDF를 JPG·PNG로 변환",
    shortDescription:
      "PDF 페이지를 JPG 또는 PNG 이미지로 변환하세요. 업로드 없이 브라우저에서 처리합니다.",
  },
  "pdf.image-to-pdf": {
    name: "이미지를 PDF로 변환",
    shortDescription:
      "JPG와 PNG 이미지를 원하는 순서대로 한 PDF로 만드세요. 업로드 없이 내 기기에서 처리합니다.",
  },
  "pdf.compress-scanned": {
    name: "스캔 PDF 용량 줄이기",
    shortDescription:
      "스캔한 PDF 페이지를 가볍게 다시 만들어 용량을 줄이세요. 파일은 서버로 전송되지 않습니다.",
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
  it("publishes 11 real tools and one honest roadmap card", () => {
    expect(availableToolEntries).toHaveLength(11);
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
    expect(getAvailableToolById("pdf.organize").experience).toBe("workspace");
  });

  it("keeps IDs, routes, aliases, and intentional relations valid", () => {
    expect(new Set(toolCatalog.map((tool) => tool.id)).size).toBe(toolCatalog.length);
    expect(new Set(availableToolEntries.map((tool) => tool.route)).size).toBe(11);
    expect(getRelatedAvailableTools("pdf.merge").map((tool) => tool.id)).toEqual([
      "pdf.split",
      "pdf.organize",
      "pdf.image-to-pdf",
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
        id: "document",
        label: "PDF·문서",
        description: "PDF와 문서 작업 도구를 모았어요.",
      },
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
      "pdf.merge",
      "image.resize",
      "pdf.compress-scanned",
      "image.convert",
      "pdf.split",
      "image.watermark",
      "pdf.organize",
      "pdf.to-image",
      "pdf.image-to-pdf",
      "pdf.watermark",
    ]);

    const imageKinds = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
    const expectedExecution = {
      "image.compress": [
        ["image/jpeg", "image/png", "image/webp"],
        1,
        20,
        true,
        ["image/jpeg", "image/png", "image/webp"],
      ],
      "pdf.merge": [["application/pdf"], 2, 20, false, ["application/pdf"]],
      "image.resize": [imageKinds, 1, 100, true, ["image/jpeg", "image/png", "image/webp"]],
      "pdf.compress-scanned": [["application/pdf"], 1, 1, false, ["application/pdf"]],
      "image.convert": [imageKinds, 1, 100, true, ["image/jpeg", "image/png", "image/webp"]],
      "pdf.split": [["application/pdf"], 1, 1, false, ["application/pdf", "application/zip"]],
      "image.watermark": [imageKinds, 1, 100, true, ["image/jpeg", "image/png", "image/webp"]],
      "pdf.organize": [["application/pdf"], 1, 1, false, ["application/pdf"]],
      "pdf.to-image": [
        ["application/pdf"],
        1,
        1,
        false,
        ["image/jpeg", "image/png", "application/zip"],
      ],
      "pdf.image-to-pdf": [["image/jpeg", "image/png"], 1, 100, true, ["application/pdf"]],
      "pdf.watermark": [["application/pdf"], 1, 1, false, ["application/pdf"]],
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
      "pdf.image-to-pdf",
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

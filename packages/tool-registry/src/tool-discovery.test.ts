import { describe, expect, it, vi } from "vitest";
import {
  type AvailableToolEntry,
  availableToolEntries,
  domainDefinitions,
  plannedToolEntries,
  purposeDefinitions,
} from "./tool-catalog";
import {
  groupDetectedKinds,
  normalizeCatalogSearch,
  parseCatalogUrlState,
  recommendAvailableTools,
  searchAvailableTools,
  selectAvailableTools,
  selectHomeTools,
  selectPlannedTools,
  serializeCatalogUrlState,
} from "./tool-discovery";

function availableIds(query: string): string[] {
  return searchAvailableTools(query).map((tool) => tool.id);
}

async function withMockedCatalog(
  overrides: Readonly<Record<string, unknown>>,
  assertDiscovery: (discovery: typeof import("./tool-discovery")) => void | Promise<void>,
): Promise<void> {
  vi.resetModules();
  vi.doMock("./tool-catalog", async () => ({
    ...(await vi.importActual<typeof import("./tool-catalog")>("./tool-catalog")),
    ...overrides,
  }));
  try {
    await assertDiscovery(await import("./tool-discovery"));
  } finally {
    vi.doUnmock("./tool-catalog");
    vi.resetModules();
  }
}

describe("catalog search and filters", () => {
  it("normalizes NFC text, whitespace, and Latin case deterministically", () => {
    expect(normalizeCatalogSearch("  E\u0301   PNG\n파일  ")).toBe("é png 파일");
    expect(normalizeCatalogSearch("\tPDF\t합치기\r\n")).toBe("pdf 합치기");
  });

  it("prioritizes exact names and finds alias substrings", () => {
    expect(searchAvailableTools("PDF 합치기")[0]?.id).toBe("pdf.merge");
    expect(searchAvailableTools("병합")[0]?.id).toBe("pdf.merge");
  });

  it("orders name prefixes before lower-tier alias substrings", () => {
    expect(availableIds("이미지")).toEqual([
      "image.compress",
      "image.resize",
      "image.crop",
      "image.convert",
      "image.rotate",
      "image.watermark",
      "pdf.image-to-pdf",
      "pdf.to-image",
    ]);
  });

  it("orders exact aliases before alias substrings", () => {
    expect(availableIds("이미지 변환")).toEqual(["image.convert", "pdf.to-image"]);
  });

  it("orders alias prefixes before name and alias substrings", () => {
    expect(availableIds("JPG")).toEqual([
      "image.compress",
      "image.convert",
      "pdf.image-to-pdf",
      "pdf.to-image",
    ]);
  });

  it("orders name and alias substrings before purpose metadata", () => {
    expect(availableIds("추출")).toEqual(["pdf.split", "pdf.to-image"]);
  });

  it("searches purpose labels and IDs, then ranks matches", () => {
    expect(availableIds("extract")).toEqual(["pdf.split", "pdf.to-image"]);
    expect(availableIds("추출·분석")).toEqual(["pdf.split", "pdf.to-image"]);
  });

  it("searches domain labels and IDs, then ranks matches", () => {
    const expected = ["data.json-format", "image.convert", "pdf.to-image", "pdf.image-to-pdf"];
    expect(availableIds("data")).toEqual(expected);
    expect(availableIds("데이터")).toEqual(expected);
  });

  it("suppresses duplicate matches and returns a newly frozen ranked array", () => {
    expect(availableIds("변환")).toEqual([
      "image.convert",
      "pdf.to-image",
      "pdf.image-to-pdf",
      "data.json-format",
    ]);

    const first = searchAvailableTools("");
    const second = searchAvailableTools("");
    expect(first.map((tool) => tool.id)).toEqual([
      "data.json-format",
      "image.compress",
      "pdf.merge",
      "image.resize",
      "image.crop",
      "pdf.compress-scanned",
      "image.convert",
      "image.rotate",
      "pdf.split",
      "image.watermark",
      "pdf.organize",
      "pdf.to-image",
      "pdf.image-to-pdf",
      "pdf.watermark",
    ]);
    expect(new Set(availableIds("변환")).size).toBe(availableIds("변환").length);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first).not.toBe(second);
  });

  it("combines query, domain, and purpose with AND semantics", () => {
    const selected = selectAvailableTools({
      query: "변환",
      domain: "image",
      purpose: "convert",
    });
    expect(selected.map((tool) => tool.id)).toEqual([
      "image.convert",
      "pdf.to-image",
      "pdf.image-to-pdf",
    ]);
    expect(selectAvailableTools({ query: "병합", domain: "image", purpose: "convert" })).toEqual(
      [],
    );
    expect(Object.isFrozen(selected)).toBe(true);
  });

  it("applies every search tier before rank", async () => {
    const source = availableToolEntries.find((tool) => tool.id === "image.compress");
    expect(source).toBeDefined();
    const makeTool = (entry: Partial<AvailableToolEntry>): AvailableToolEntry =>
      ({
        ...source,
        id: "test.default",
        name: "unrelated",
        searchAliases: ["other"],
        domains: ["image"],
        purposes: ["convert"],
        featured: false,
        ...entry,
      }) as AvailableToolEntry;
    const tiered = [
      makeTool({ id: "test.exact-name", name: "Needle", rank: 70 }),
      makeTool({ id: "test.name-prefix", name: "Needle prefix", rank: 60 }),
      makeTool({ id: "test.exact-alias", searchAliases: ["needle"], rank: 50 }),
      makeTool({ id: "test.alias-prefix", searchAliases: ["needle prefix"], rank: 40 }),
      makeTool({ id: "test.substring", name: "contains needle value", rank: 30 }),
      makeTool({ id: "test.purpose", purposes: ["optimize"], rank: 20 }),
      makeTool({ id: "test.domain", domains: ["media"], rank: 10 }),
    ];

    await withMockedCatalog(
      {
        availableToolEntries: Object.freeze(tiered),
        purposeDefinitions: Object.freeze(
          purposeDefinitions.map((definition) =>
            definition.id === "optimize" ? { ...definition, label: "Needle purpose" } : definition,
          ),
        ),
        domainDefinitions: Object.freeze(
          domainDefinitions.map((definition) =>
            definition.id === "media" ? { ...definition, label: "Needle domain" } : definition,
          ),
        ),
      },
      (tieredDiscovery) => {
        expect(tieredDiscovery.searchAvailableTools("needle").map((tool) => tool.id)).toEqual([
          "test.exact-name",
          "test.name-prefix",
          "test.exact-alias",
          "test.alias-prefix",
          "test.substring",
          "test.purpose",
          "test.domain",
        ]);
      },
    );
  });

  it("uses stable ID ties and rejects supported mixed kinds when disabled", async () => {
    const source = availableToolEntries.find((tool) => tool.id === "image.compress");
    expect(source).toBeDefined();
    const zeta = { ...source, id: "test.zeta", rank: 500 } as AvailableToolEntry;
    const alpha = { ...source, id: "test.alpha", rank: 500 } as AvailableToolEntry;
    const strict = {
      ...source,
      id: "test.strict",
      rank: 600,
      launcherInput: {
        role: "source",
        kinds: ["image/jpeg", "image/png"],
        minFiles: 1,
        maxFiles: 100,
        allowMixedKinds: false,
      },
    } as AvailableToolEntry;
    const launcherless = {
      ...source,
      id: "test.launcherless",
      rank: 700,
      launcherInput: null,
    } as AvailableToolEntry;

    await withMockedCatalog(
      { availableToolEntries: Object.freeze([zeta, alpha, strict, launcherless]) },
      (tiedDiscovery) => {
        expect(tiedDiscovery.searchAvailableTools("").map((tool) => tool.id)).toEqual([
          "test.alpha",
          "test.zeta",
          "test.strict",
          "test.launcherless",
        ]);
        expect(
          tiedDiscovery
            .recommendAvailableTools([{ index: 0, kind: "image/jpeg" }])
            .map(({ tool }) => tool.id),
        ).toEqual(["test.strict", "test.alpha", "test.zeta"]);
        expect(
          tiedDiscovery
            .recommendAvailableTools([
              { index: 0, kind: "image/jpeg" },
              { index: 1, kind: "image/png" },
            ])
            .map(({ tool }) => tool.id),
        ).toEqual(["test.alpha", "test.zeta"]);
      },
    );
  });
});

describe("available and planned separation", () => {
  it("returns planned tools only from the enabled planned selector", () => {
    const state = {
      query: "동영상",
      domain: "media",
      purpose: "optimize",
      includePlanned: true,
    } as const;

    expect(searchAvailableTools("동영상")).toEqual([]);
    expect(selectAvailableTools({ query: "", domain: "media", purpose: "all" })).toEqual([]);
    expect(selectPlannedTools(state).map((tool) => tool.id)).toEqual(["media.video-compress"]);
    expect(selectPlannedTools(state).every((tool) => tool.availability === "planned")).toBe(true);
    expect(plannedToolEntries).toHaveLength(1);
  });

  it("returns a new frozen empty planned list when planned results are disabled", () => {
    const state = {
      query: "",
      domain: "all",
      purpose: "all",
      includePlanned: false,
    } as const;
    const first = selectPlannedTools(state);
    const second = selectPlannedTools(state);
    expect(first).toEqual([]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first).not.toBe(second);
  });

  it("applies query, domain, and purpose to planned results", () => {
    const base = { query: "압축", includePlanned: true } as const;
    expect(
      selectPlannedTools({ ...base, domain: "all", purpose: "optimize" }).map((tool) => tool.id),
    ).toEqual(["media.video-compress"]);
    expect(selectPlannedTools({ ...base, domain: "image", purpose: "optimize" })).toEqual([]);
    expect(selectPlannedTools({ ...base, domain: "all", purpose: "convert" })).toEqual([]);
  });
});

describe("catalog URL state", () => {
  it("recovers invalid query state while preserving valid fields", () => {
    expect(
      parseCatalogUrlState(
        new URLSearchParams("q=%20PNG%20&domain=bogus&purpose=convert&planned=1"),
      ),
    ).toEqual({ query: "PNG", domain: "all", purpose: "convert", includePlanned: true });
  });

  it("cleans query text without lowercasing URL display state", () => {
    expect(
      parseCatalogUrlState(
        new URLSearchParams("q=%20E%CC%81%20%20PDF%20&domain=image&purpose=bogus&planned=true"),
      ),
    ).toEqual({ query: "É PDF", domain: "image", purpose: "all", includePlanned: false });
  });

  it("uses stable defaults when URL fields are absent", () => {
    expect(parseCatalogUrlState(new URLSearchParams())).toEqual({
      query: "",
      domain: "all",
      purpose: "all",
      includePlanned: false,
    });
  });

  it("serializes non-default fields in q, domain, purpose, planned order", () => {
    expect(
      serializeCatalogUrlState({
        query: " PNG ",
        domain: "image",
        purpose: "convert",
        includePlanned: true,
      }),
    ).toBe("q=PNG&domain=image&purpose=convert&planned=1");
  });

  it("omits defaults and normalizes serialized query text", () => {
    expect(
      serializeCatalogUrlState({
        query: "  ",
        domain: "all",
        purpose: "all",
        includePlanned: false,
      }),
    ).toBe("");
    const encoded = serializeCatalogUrlState({
      query: " E\u0301   PDF ",
      domain: "all",
      purpose: "all",
      includePlanned: false,
    });
    expect(encoded).toBe("q=%C3%89+PDF");
    expect(parseCatalogUrlState(new URLSearchParams(encoded)).query).toBe("É PDF");
  });
});

describe("home tool selection", () => {
  it("deduplicates recent tools and places them first", () => {
    const selected = selectHomeTools({
      domain: "all",
      recentToolIds: ["pdf.merge", "pdf.merge"],
      limit: 12,
    });
    expect(selected[0]?.id).toBe("pdf.merge");
    expect(selected.filter((tool) => tool.id === "pdf.merge")).toHaveLength(1);
    expect(Object.isFrozen(selected)).toBe(true);
  });

  it("places at most four valid recent tools in the all-tools view", () => {
    const selected = selectHomeTools({
      domain: "all",
      recentToolIds: [
        "pdf.watermark",
        "pdf.image-to-pdf",
        "pdf.to-image",
        "pdf.organize",
        "pdf.split",
      ],
      limit: 12,
    });
    expect(selected.slice(0, 4).map((tool) => tool.id)).toEqual([
      "pdf.watermark",
      "pdf.image-to-pdf",
      "pdf.to-image",
      "pdf.organize",
    ]);
    expect(selected.findIndex((tool) => tool.id === "pdf.split")).toBe(-1);
    expect(selected).toHaveLength(12);
  });

  it("ignores unknown and planned recent IDs", () => {
    const selected = selectHomeTools({
      domain: "all",
      recentToolIds: ["missing.tool", "media.video-compress", "pdf.merge"],
    });
    expect(selected[0]?.id).toBe("pdf.merge");
    expect(selected.some((tool) => tool.id === "media.video-compress")).toBe(false);
  });

  it("builds available-only domain panels in rank order", () => {
    expect(
      selectHomeTools({ domain: "image", recentToolIds: ["pdf.merge"] }).map((tool) => tool.id),
    ).toEqual([
      "image.compress",
      "image.resize",
      "image.crop",
      "image.convert",
      "image.rotate",
      "image.watermark",
      "pdf.to-image",
      "pdf.image-to-pdf",
    ]);
    expect(selectHomeTools({ domain: "media", recentToolIds: [] })).toEqual([]);
  });

  it("clamps home limits to the zero-to-twelve range", () => {
    const empty = selectHomeTools({ domain: "all", recentToolIds: [], limit: -2 });
    expect(empty).toEqual([]);
    expect(Object.isFrozen(empty)).toBe(true);
    expect(
      selectHomeTools({ domain: "all", recentToolIds: [], limit: 99 }).length,
    ).toBeLessThanOrEqual(12);
  });

  it("caps a catalog larger than the all-tools panel at twelve cards", async () => {
    const source = availableToolEntries.find((tool) => tool.id === "image.compress");
    expect(source).toBeDefined();
    const thirteenTools = Array.from(
      { length: 13 },
      (_, index) =>
        ({
          ...source,
          id: `test.tool-${String(index).padStart(2, "0")}`,
          rank: index,
          featured: false,
        }) as AvailableToolEntry,
    );

    await withMockedCatalog(
      { availableToolEntries: Object.freeze(thirteenTools) },
      (largerDiscovery) => {
        const selected = largerDiscovery.selectHomeTools({
          domain: "all",
          recentToolIds: [],
          limit: 99,
        });
        expect(selected).toHaveLength(12);
        expect(selected.map((tool) => tool.id)).toEqual(
          thirteenTools.slice(0, 12).map((tool) => tool.id),
        );
      },
    );
  });
});

describe("file capability recommendations", () => {
  it("marks a single PDF as needing one more file for merge", () => {
    const recommendations = recommendAvailableTools([{ index: 0, kind: "application/pdf" }]);
    expect(recommendations.find(({ tool }) => tool.id === "pdf.merge")).toMatchObject({
      readiness: "needs-more",
      missingFiles: 1,
      maximumFiles: 20,
      matchedIndexes: [0],
    });
    expect(recommendations.map(({ tool }) => tool.id)).toEqual([
      "pdf.compress-scanned",
      "pdf.split",
      "pdf.organize",
      "pdf.to-image",
      "pdf.watermark",
      "pdf.merge",
    ]);
  });

  it("prefers the most exact detected-kind capability before rank", () => {
    const recommendations = recommendAvailableTools([
      { index: 0, kind: "image/jpeg" },
      { index: 1, kind: "image/png" },
    ]);
    expect(recommendations.map(({ tool }) => tool.id)).toEqual([
      "pdf.image-to-pdf",
      "image.compress",
      "image.crop",
      "image.rotate",
      "image.resize",
      "image.convert",
      "image.watermark",
    ]);
    expect(recommendations.find(({ tool }) => tool.id === "image.convert")).toMatchObject({
      readiness: "ready",
      missingFiles: 0,
      maximumFiles: 100,
      matchedIndexes: [0, 1],
    });
  });

  it("orders ready tools before too-many matches", () => {
    const recommendations = recommendAvailableTools([
      { index: 3, kind: "application/pdf" },
      { index: 8, kind: "application/pdf" },
    ]);
    expect(recommendations.map(({ tool }) => tool.id)).toEqual([
      "pdf.merge",
      "pdf.compress-scanned",
      "pdf.split",
      "pdf.organize",
      "pdf.to-image",
      "pdf.watermark",
    ]);
    expect(recommendations.find(({ tool }) => tool.id === "pdf.compress-scanned")).toMatchObject({
      readiness: "too-many",
      missingFiles: 0,
      maximumFiles: 1,
      matchedIndexes: [3, 8],
    });
  });

  it("honors compatible kinds and mixed-kind launcher metadata", () => {
    expect(
      recommendAvailableTools([
        { index: 0, kind: "application/pdf" },
        { index: 1, kind: "image/jpeg" },
      ]),
    ).toEqual([]);
    expect(
      recommendAvailableTools([
        { index: 0, kind: "application/pdf" },
        { index: 1, kind: "application/pdf" },
      ]).find(({ tool }) => tool.id === "pdf.merge")?.readiness,
    ).toBe("ready");
  });

  it("excludes planned and launcher-less tools", () => {
    const recommendations = recommendAvailableTools([{ index: 0, kind: "video/mp4" }]);
    expect(recommendations).toEqual([]);
    expect(recommendations.every(({ tool }) => tool.availability === "available")).toBe(true);
  });

  it("returns a newly frozen empty recommendation list for no files", () => {
    const first = recommendAvailableTools([]);
    const second = recommendAvailableTools([]);
    expect(first).toEqual([]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first).not.toBe(second);
  });

  it("groups fallback kinds in first-seen order and preserves source indexes", () => {
    const items = [
      { index: 7, kind: "application/pdf" },
      { index: 3, kind: "image/jpeg" },
      { index: 9, kind: "application/pdf" },
      { index: 4, kind: "image/png" },
    ] as const;
    expect(recommendAvailableTools(items)).toEqual([]);

    const groups = groupDetectedKinds(items);
    expect(groups).toEqual([
      { kind: "application/pdf", indexes: [7, 9] },
      { kind: "image/jpeg", indexes: [3] },
      { kind: "image/png", indexes: [4] },
    ]);
    expect(Object.isFrozen(groups)).toBe(true);
    expect(groups.every((group) => Object.isFrozen(group.indexes))).toBe(true);

    const pdfItems = items.filter((item) => item.kind === groups[0]?.kind);
    expect(
      recommendAvailableTools(pdfItems).find(({ tool }) => tool.id === "pdf.merge"),
    ).toMatchObject({ readiness: "ready", matchedIndexes: [7, 9] });
    const jpegItems = items.filter((item) => item.kind === groups[1]?.kind);
    expect(recommendAvailableTools(jpegItems)[0]).toMatchObject({ matchedIndexes: [3] });
  });

  it("returns a new frozen empty group list for no files", () => {
    const first = groupDetectedKinds([]);
    const second = groupDetectedKinds([]);
    expect(first).toEqual([]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first).not.toBe(second);
  });
});

export type ToolId = `${string}.${string}`;
export type DomainId = "image" | "document" | "media" | "data" | "text-ai" | "web-dev" | "everyday";
export type DiscoveryDomainId = "all" | DomainId;
export type PurposeId = "optimize" | "convert" | "edit" | "create" | "extract" | "protect";
export type PurposeFilter = "all" | PurposeId;
export type Experience = "quick" | "file" | "workspace";
export type Execution = "browser" | "server";
export type FileKind =
  | "image/jpeg"
  | "image/png"
  | "image/webp"
  | "image/heic"
  | "image/heif"
  | "application/pdf"
  | "text/plain"
  | "application/json"
  | "application/zip"
  | `video/${string}`
  | `audio/${string}`;
export type ResultKind = FileKind | "value/text" | "value/number";

export interface DomainDefinition {
  id: DomainId;
  label: string;
  description: string;
}

export interface DomainFilterDefinition {
  id: DiscoveryDomainId;
  label: string;
  description: string;
}

export interface PurposeDefinition {
  id: PurposeId;
  label: string;
}

interface CatalogBase {
  id: ToolId;
  name: string;
  shortDescription: string;
  domains: readonly [DomainId, ...DomainId[]];
  purposes: readonly [PurposeId, ...PurposeId[]];
  searchAliases: readonly string[];
  rank: number;
}

export interface LauncherInput {
  role: "source";
  kinds: readonly [FileKind, ...FileKind[]];
  minFiles: number;
  maxFiles: number;
  allowMixedKinds: boolean;
}

export type AvailableToolEntry = CatalogBase & {
  availability: "available";
  route: `/${string}`;
  launcherInput: LauncherInput | null;
  outputKinds: readonly ResultKind[];
  experience: Experience;
  execution: Execution;
  contract: { id: string; version: number };
  featured: boolean;
  newUntil?: `${number}-${number}-${number}`;
  relatedToolIds: readonly [ToolId, ToolId, ToolId];
};

export type PlannedToolEntry = CatalogBase & {
  availability: "planned";
  route?: never;
  launcherInput?: never;
  outputKinds?: never;
  experience?: never;
  execution?: never;
  contract?: never;
  featured?: never;
  newUntil?: never;
  relatedToolIds?: never;
};

export type ToolCatalogEntry = AvailableToolEntry | PlannedToolEntry;

export const domainDefinitions: readonly DomainDefinition[] = Object.freeze([
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

export const domainFilterDefinitions: readonly DomainFilterDefinition[] = Object.freeze([
  {
    id: "all",
    label: "전체·추천",
    description: "최근 사용한 도구와 추천 도구를 모았어요.",
  },
  ...domainDefinitions,
]);

export const purposeDefinitions: readonly PurposeDefinition[] = Object.freeze([
  { id: "optimize", label: "압축·최적화" },
  { id: "convert", label: "변환" },
  { id: "edit", label: "편집" },
  { id: "create", label: "만들기" },
  { id: "extract", label: "추출·분석" },
  { id: "protect", label: "보안·표시" },
]);

const domainIds = new Set(domainDefinitions.map(({ id }) => id));
const purposeIds = new Set(purposeDefinitions.map(({ id }) => id));
const experienceIds = new Set<Experience>(["quick", "file", "workspace"]);
const executionIds = new Set<Execution>(["browser", "server"]);
const concreteFileKinds = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
  "text/plain",
  "application/json",
  "application/zip",
]);

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid tool catalog: ${message}`);
}

function isKnownFileKind(value: unknown): value is FileKind {
  return (
    typeof value === "string" &&
    (concreteFileKinds.has(value) || value.startsWith("video/") || value.startsWith("audio/"))
  );
}

function isKnownResultKind(value: unknown): value is ResultKind {
  return value === "value/text" || value === "value/number" || isKnownFileKind(value);
}

export function defineToolCatalog<const T extends readonly ToolCatalogEntry[]>(entries: T): T {
  const ids = new Set<string>();
  const routes = new Set<string>();
  const cloned = entries.map((entry) => {
    invariant(typeof entry.id === "string" && /^[^.]+\.[^.]+/.test(entry.id), "tool ID");
    invariant(!ids.has(entry.id), `duplicate ID ${entry.id}`);
    ids.add(entry.id);
    invariant(entry.name.trim() !== "" && entry.shortDescription.trim() !== "", `${entry.id} copy`);
    invariant(
      entry.availability === "available" || entry.availability === "planned",
      `${entry.id} availability`,
    );
    invariant(
      entry.domains.length > 0 && entry.domains.every((id) => domainIds.has(id)),
      `${entry.id} domain`,
    );
    invariant(new Set(entry.domains).size === entry.domains.length, `${entry.id} duplicate domain`);
    invariant(
      entry.purposes.length > 0 && entry.purposes.every((id) => purposeIds.has(id)),
      `${entry.id} purpose`,
    );
    invariant(
      new Set(entry.purposes).size === entry.purposes.length,
      `${entry.id} duplicate purpose`,
    );
    invariant(Number.isFinite(entry.rank), `${entry.id} rank`);
    const normalizedAliases = entry.searchAliases.map((alias) => alias.normalize("NFC").trim());
    invariant(
      normalizedAliases.every(
        (alias, index) => alias !== "" && alias === entry.searchAliases[index],
      ),
      `${entry.id} alias normalization`,
    );
    invariant(
      new Set(normalizedAliases.map((alias) => alias.toLocaleLowerCase("ko-KR"))).size ===
        normalizedAliases.length,
      `${entry.id} duplicate alias`,
    );

    if (entry.availability === "planned") {
      for (const key of [
        "route",
        "launcherInput",
        "outputKinds",
        "experience",
        "execution",
        "contract",
        "featured",
        "newUntil",
        "relatedToolIds",
      ] as const) {
        invariant(!(key in entry), `${entry.id} planned field ${key}`);
      }
      return Object.freeze({ ...entry });
    }

    invariant(entry.route.startsWith("/") && entry.route.length > 1, `${entry.id} route`);
    invariant(!routes.has(entry.route), `duplicate route ${entry.route}`);
    routes.add(entry.route);
    invariant(experienceIds.has(entry.experience), `${entry.id} experience`);
    invariant(executionIds.has(entry.execution), `${entry.id} execution`);
    invariant(typeof entry.featured === "boolean", `${entry.id} featured`);
    invariant(
      entry.newUntil === undefined || /^\d{4}-\d{2}-\d{2}$/.test(entry.newUntil),
      `${entry.id} newUntil`,
    );
    invariant(
      entry.contract.id.trim() !== "" &&
        Number.isInteger(entry.contract.version) &&
        entry.contract.version > 0,
      `${entry.id} contract`,
    );
    invariant(
      entry.outputKinds.length > 0 && entry.outputKinds.every(isKnownResultKind),
      `${entry.id} output kind`,
    );
    invariant(
      new Set(entry.outputKinds).size === entry.outputKinds.length,
      `${entry.id} duplicate output kind`,
    );
    if (entry.launcherInput !== null) {
      const input = entry.launcherInput;
      invariant(
        input.role === "source" && input.kinds.length > 0 && input.kinds.every(isKnownFileKind),
        `${entry.id} launcher kind`,
      );
      invariant(
        new Set(input.kinds).size === input.kinds.length,
        `${entry.id} duplicate launcher kind`,
      );
      invariant(
        Number.isInteger(input.minFiles) && Number.isInteger(input.maxFiles),
        `${entry.id} launcher integers`,
      );
      invariant(
        input.minFiles > 0 && input.minFiles <= input.maxFiles,
        `${entry.id} launcher range`,
      );
      invariant(typeof input.allowMixedKinds === "boolean", `${entry.id} mixed-kind flag`);
    }
    invariant(
      entry.relatedToolIds.length === 3 && new Set(entry.relatedToolIds).size === 3,
      `${entry.id} related count`,
    );
    return Object.freeze({ ...entry });
  });

  const byId = new Map(cloned.map((entry) => [entry.id, entry]));
  for (const entry of cloned) {
    if (entry.availability !== "available") continue;
    for (const relatedId of entry.relatedToolIds) {
      invariant(relatedId !== entry.id, `${entry.id} self-related`);
      invariant(
        byId.get(relatedId)?.availability === "available",
        `${entry.id} related ${relatedId}`,
      );
    }
  }
  return Object.freeze(cloned) as unknown as T;
}

const aliases = {
  "image.compress": ["사진 압축", "이미지 최적화", "용량 줄이기", "jpg 압축", "png 압축"],
  "image.resize": ["사진 크기", "리사이즈", "해상도 변경", "정사각형 자르기"],
  "image.crop": ["사진 자르기", "이미지 자르기", "크롭", "비율 자르기"],
  "image.convert": ["이미지 변환", "jpg 변환", "png 변환", "webp 변환", "heic 변환"],
  "image.rotate": ["사진 회전", "이미지 회전", "90도 회전"],
  "image.watermark": ["사진 워터마크", "로고 넣기", "문구 넣기"],
  "pdf.merge": ["pdf 병합", "pdf 합치기", "문서 합치기"],
  "pdf.split": ["pdf 나누기", "페이지 추출", "pdf 분할"],
  "pdf.organize": ["페이지 순서", "pdf 회전", "페이지 삭제"],
  "pdf.watermark": ["문서 워터마크", "pdf 문구", "대외비"],
  "pdf.to-image": ["pdf jpg", "pdf png", "pdf 이미지 변환"],
  "pdf.image-to-pdf": ["jpg pdf", "png pdf", "사진 pdf"],
  "pdf.compress-scanned": ["pdf 압축", "스캔 pdf", "pdf 용량 줄이기"],
} as const;

export const toolCatalog = defineToolCatalog([
  {
    id: "image.compress",
    name: "이미지 용량 줄이기",
    shortDescription:
      "JPG, PNG, WebP 이미지를 원본 형식 그대로 압축하세요. 처리 전에 로컬 또는 임시 서버 처리 여부를 명확히 알려드려요.",
    domains: ["image"],
    purposes: ["optimize"],
    searchAliases: aliases["image.compress"],
    rank: 10,
    availability: "available",
    route: "/image/compress",
    launcherInput: {
      role: "source",
      kinds: ["image/jpeg", "image/png", "image/webp"],
      minFiles: 1,
      maxFiles: 20,
      allowMixedKinds: true,
    },
    outputKinds: ["image/jpeg", "image/png", "image/webp"],
    experience: "file",
    execution: "server",
    contract: { id: "image.optimize", version: 1 },
    featured: true,
    relatedToolIds: ["image.resize", "image.convert", "image.watermark"],
  },
  {
    id: "pdf.merge",
    name: "PDF 합치기",
    shortDescription:
      "여러 PDF 파일을 원하는 순서대로 하나로 합치세요. 파일을 서버에 올리지 않고 브라우저에서 바로 처리합니다.",
    domains: ["document"],
    purposes: ["create", "edit"],
    searchAliases: aliases["pdf.merge"],
    rank: 20,
    availability: "available",
    route: "/pdf/merge",
    launcherInput: {
      role: "source",
      kinds: ["application/pdf"],
      minFiles: 2,
      maxFiles: 20,
      allowMixedKinds: false,
    },
    outputKinds: ["application/pdf"],
    experience: "file",
    execution: "browser",
    contract: { id: "pdf.merge", version: 1 },
    featured: true,
    relatedToolIds: ["pdf.split", "pdf.organize", "pdf.image-to-pdf"],
  },
  {
    id: "image.resize",
    name: "이미지 크기 조절",
    shortDescription:
      "사진의 가로·세로 크기를 빠르게 바꾸세요. 업로드 없이 긴 변 축소와 정사각형 자르기를 한 번에 처리합니다.",
    domains: ["image"],
    purposes: ["edit", "optimize"],
    searchAliases: aliases["image.resize"],
    rank: 30,
    availability: "available",
    route: "/image/resize",
    launcherInput: {
      role: "source",
      kinds: ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"],
      minFiles: 1,
      maxFiles: 100,
      allowMixedKinds: true,
    },
    outputKinds: ["image/jpeg", "image/png", "image/webp"],
    experience: "file",
    execution: "browser",
    contract: { id: "image.pipeline", version: 2 },
    featured: true,
    relatedToolIds: ["image.compress", "image.convert", "image.watermark"],
  },
  {
    id: "image.crop",
    name: "이미지 자르기",
    shortDescription:
      "원하는 비율로 이미지의 필요한 부분만 잘라내세요. 파일은 서버로 전송되지 않습니다.",
    domains: ["image"],
    purposes: ["edit"],
    searchAliases: aliases["image.crop"],
    rank: 35,
    availability: "available",
    route: "/image/crop",
    launcherInput: {
      role: "source",
      kinds: ["image/jpeg", "image/png", "image/webp"],
      minFiles: 1,
      maxFiles: 100,
      allowMixedKinds: true,
    },
    outputKinds: ["image/jpeg", "image/png", "image/webp"],
    experience: "file",
    execution: "browser",
    contract: { id: "image.pipeline", version: 2 },
    featured: true,
    relatedToolIds: ["image.resize", "image.rotate", "image.compress"],
  },
  {
    id: "pdf.compress-scanned",
    name: "PDF 용량 줄이기",
    shortDescription:
      "텍스트와 링크를 유지하며 PDF 용량을 줄이세요. 기본은 임시 서버에서 처리하며 완료 후 자동 삭제합니다.",
    domains: ["document"],
    purposes: ["optimize"],
    searchAliases: aliases["pdf.compress-scanned"],
    rank: 40,
    availability: "available",
    route: "/pdf/compress",
    launcherInput: {
      role: "source",
      kinds: ["application/pdf"],
      minFiles: 1,
      maxFiles: 1,
      allowMixedKinds: false,
    },
    outputKinds: ["application/pdf"],
    experience: "file",
    execution: "server",
    contract: { id: "pdf.compress-scanned", version: 2 },
    featured: true,
    relatedToolIds: ["pdf.merge", "pdf.split", "pdf.to-image"],
  },
  {
    id: "image.convert",
    name: "이미지 형식 변환",
    shortDescription:
      "JPG, PNG, WebP, HEIC 이미지를 원하는 형식으로 변환하세요. 파일은 서버로 전송되지 않습니다.",
    domains: ["image", "data"],
    purposes: ["convert"],
    searchAliases: aliases["image.convert"],
    rank: 50,
    availability: "available",
    route: "/image/convert",
    launcherInput: {
      role: "source",
      kinds: ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"],
      minFiles: 1,
      maxFiles: 100,
      allowMixedKinds: true,
    },
    outputKinds: ["image/jpeg", "image/png", "image/webp"],
    experience: "file",
    execution: "browser",
    contract: { id: "image.pipeline", version: 2 },
    featured: true,
    relatedToolIds: ["image.compress", "image.resize", "pdf.image-to-pdf"],
  },
  {
    id: "image.rotate",
    name: "이미지 회전",
    shortDescription: "이미지를 90도 단위로 빠르게 회전하세요. 파일은 서버로 전송되지 않습니다.",
    domains: ["image"],
    purposes: ["edit"],
    searchAliases: aliases["image.rotate"],
    rank: 55,
    availability: "available",
    route: "/image/rotate",
    launcherInput: {
      role: "source",
      kinds: ["image/jpeg", "image/png", "image/webp"],
      minFiles: 1,
      maxFiles: 100,
      allowMixedKinds: true,
    },
    outputKinds: ["image/jpeg", "image/png", "image/webp"],
    experience: "file",
    execution: "browser",
    contract: { id: "image.pipeline", version: 2 },
    featured: true,
    relatedToolIds: ["image.crop", "image.resize", "image.convert"],
  },
  {
    id: "pdf.split",
    name: "PDF 페이지 분할",
    shortDescription:
      "PDF를 페이지별로 나누거나 필요한 페이지만 추출하세요. 파일은 기기 안에서만 처리됩니다.",
    domains: ["document"],
    purposes: ["extract", "edit"],
    searchAliases: aliases["pdf.split"],
    rank: 60,
    availability: "available",
    route: "/pdf/split",
    launcherInput: {
      role: "source",
      kinds: ["application/pdf"],
      minFiles: 1,
      maxFiles: 1,
      allowMixedKinds: false,
    },
    outputKinds: ["application/pdf", "application/zip"],
    experience: "file",
    execution: "browser",
    contract: { id: "pdf.split", version: 1 },
    featured: false,
    relatedToolIds: ["pdf.merge", "pdf.organize", "pdf.to-image"],
  },
  {
    id: "image.watermark",
    name: "이미지에 워터마크 넣기",
    shortDescription: "사진과 이미지에 문구 또는 로고를 넣으세요. 파일은 서버로 전송되지 않습니다.",
    domains: ["image"],
    purposes: ["edit", "protect"],
    searchAliases: aliases["image.watermark"],
    rank: 70,
    availability: "available",
    route: "/image/watermark",
    launcherInput: {
      role: "source",
      kinds: ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"],
      minFiles: 1,
      maxFiles: 100,
      allowMixedKinds: true,
    },
    outputKinds: ["image/jpeg", "image/png", "image/webp"],
    experience: "file",
    execution: "browser",
    contract: { id: "image.watermark", version: 1 },
    featured: false,
    relatedToolIds: ["image.compress", "image.resize", "pdf.watermark"],
  },
  {
    id: "pdf.organize",
    name: "PDF 페이지 정리",
    shortDescription:
      "PDF 페이지 순서를 바꾸고 90도씩 회전하거나 필요 없는 페이지를 빼세요. 파일은 기기 안에서만 처리됩니다.",
    domains: ["document"],
    purposes: ["edit"],
    searchAliases: aliases["pdf.organize"],
    rank: 80,
    availability: "available",
    route: "/pdf/organize",
    launcherInput: {
      role: "source",
      kinds: ["application/pdf"],
      minFiles: 1,
      maxFiles: 1,
      allowMixedKinds: false,
    },
    outputKinds: ["application/pdf"],
    experience: "workspace",
    execution: "browser",
    contract: { id: "pdf.organize", version: 1 },
    featured: false,
    relatedToolIds: ["pdf.merge", "pdf.split", "pdf.watermark"],
  },
  {
    id: "pdf.to-image",
    name: "PDF를 JPG·PNG로 변환",
    shortDescription:
      "PDF 페이지를 JPG 또는 PNG 이미지로 변환하세요. 업로드 없이 브라우저에서 처리합니다.",
    domains: ["document", "image", "data"],
    purposes: ["convert", "extract"],
    searchAliases: aliases["pdf.to-image"],
    rank: 90,
    availability: "available",
    route: "/pdf/to-image",
    launcherInput: {
      role: "source",
      kinds: ["application/pdf"],
      minFiles: 1,
      maxFiles: 1,
      allowMixedKinds: false,
    },
    outputKinds: ["image/jpeg", "image/png", "application/zip"],
    experience: "file",
    execution: "browser",
    contract: { id: "pdf.to-images", version: 1 },
    featured: false,
    relatedToolIds: ["pdf.image-to-pdf", "pdf.split", "image.convert"],
  },
  {
    id: "pdf.image-to-pdf",
    name: "이미지를 PDF로 변환",
    shortDescription:
      "JPG와 PNG 이미지를 원하는 순서대로 한 PDF로 만드세요. 업로드 없이 내 기기에서 처리합니다.",
    domains: ["image", "document", "data"],
    purposes: ["convert", "create"],
    searchAliases: aliases["pdf.image-to-pdf"],
    rank: 100,
    availability: "available",
    route: "/pdf/image-to-pdf",
    launcherInput: {
      role: "source",
      kinds: ["image/jpeg", "image/png"],
      minFiles: 1,
      maxFiles: 100,
      allowMixedKinds: true,
    },
    outputKinds: ["application/pdf"],
    experience: "file",
    execution: "browser",
    contract: { id: "pdf.images-to-pdf", version: 1 },
    featured: false,
    relatedToolIds: ["pdf.to-image", "pdf.merge", "image.convert"],
  },
  {
    id: "pdf.watermark",
    name: "PDF 워터마크 넣기",
    shortDescription:
      "PDF 모든 페이지 또는 지정한 페이지에 원하는 문구의 워터마크를 넣으세요. 업로드 없이 브라우저에서 처리합니다.",
    domains: ["document"],
    purposes: ["edit", "protect"],
    searchAliases: aliases["pdf.watermark"],
    rank: 110,
    availability: "available",
    route: "/pdf/watermark",
    launcherInput: {
      role: "source",
      kinds: ["application/pdf"],
      minFiles: 1,
      maxFiles: 1,
      allowMixedKinds: false,
    },
    outputKinds: ["application/pdf"],
    experience: "file",
    execution: "browser",
    contract: { id: "pdf.watermark", version: 1 },
    featured: false,
    relatedToolIds: ["pdf.organize", "pdf.merge", "image.watermark"],
  },
  {
    id: "data.json-format",
    name: "JSON 정리·검사",
    shortDescription:
      "JSON 문법을 검사하고 읽기 좋게 정리하거나 공백을 줄이세요. 내용은 브라우저 밖으로 나가지 않습니다.",
    domains: ["data", "web-dev"],
    purposes: ["edit", "convert"],
    searchAliases: ["json 정리", "json 포맷", "json 검사", "json 축소"],
    rank: 10,
    availability: "available",
    route: "/data/json",
    launcherInput: null,
    outputKinds: ["application/json", "value/text"],
    experience: "quick",
    execution: "browser",
    contract: { id: "json.format", version: 1 },
    featured: false,
    relatedToolIds: ["image.convert", "pdf.to-image", "pdf.image-to-pdf"],
  },
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
] as const);

export type AvailableToolId = Extract<
  (typeof toolCatalog)[number],
  { availability: "available" }
>["id"];

export const availableToolEntries = Object.freeze(
  toolCatalog.filter(
    (tool): tool is Extract<(typeof toolCatalog)[number], { availability: "available" }> =>
      tool.availability === "available",
  ),
);

export const plannedToolEntries = Object.freeze(
  toolCatalog.filter(
    (tool): tool is Extract<(typeof toolCatalog)[number], { availability: "planned" }> =>
      tool.availability === "planned",
  ),
);

export function findToolById(id: string): ToolCatalogEntry | undefined {
  return toolCatalog.find((tool) => tool.id === id);
}

export function findAvailableToolById(id: string): AvailableToolEntry | undefined {
  const tool = findToolById(id);
  return tool?.availability === "available" ? tool : undefined;
}

export function getAvailableToolById(id: AvailableToolId): AvailableToolEntry {
  const tool = findAvailableToolById(id);
  if (tool === undefined) throw new Error(`Missing available tool: ${id}`);
  return tool;
}

export function getRelatedAvailableTools(
  id: AvailableToolId,
): readonly [AvailableToolEntry, AvailableToolEntry, AvailableToolEntry] {
  const related = getAvailableToolById(id).relatedToolIds.map((relatedId) => {
    const tool = findAvailableToolById(relatedId);
    if (tool === undefined) throw new Error(`Missing related tool: ${relatedId}`);
    return tool;
  });
  return related as [AvailableToolEntry, AvailableToolEntry, AvailableToolEntry];
}

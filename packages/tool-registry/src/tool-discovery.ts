import {
  type AvailableToolEntry,
  availableToolEntries,
  type DiscoveryDomainId,
  domainDefinitions,
  domainFilterDefinitions,
  type FileKind,
  findAvailableToolById,
  type PlannedToolEntry,
  type PurposeFilter,
  type PurposeId,
  plannedToolEntries,
  purposeDefinitions,
  type ToolCatalogEntry,
} from "./tool-catalog";

const availableTools: readonly AvailableToolEntry[] = availableToolEntries;
const plannedTools: readonly PlannedToolEntry[] = plannedToolEntries;

export interface CatalogFilters {
  query: string;
  domain: DiscoveryDomainId;
  purpose: PurposeFilter;
}

export interface CatalogUrlState extends CatalogFilters {
  includePlanned: boolean;
}

export interface HomeToolSelection {
  domain: DiscoveryDomainId;
  recentToolIds: readonly string[];
  limit?: number;
}

export interface DetectedKindItem {
  index: number;
  kind: FileKind;
}

export interface DetectedKindGroup {
  kind: FileKind;
  indexes: readonly number[];
}

export type RecommendationReadiness = "ready" | "needs-more" | "too-many";

export interface ToolRecommendation {
  tool: AvailableToolEntry;
  readiness: RecommendationReadiness;
  missingFiles: number;
  maximumFiles: number;
  matchedIndexes: readonly number[];
}

function compareRank(left: ToolCatalogEntry, right: ToolCatalogEntry): number {
  return left.rank - right.rank || left.id.localeCompare(right.id);
}

function searchScore(tool: ToolCatalogEntry, normalizedQuery: string): number {
  if (normalizedQuery === "") return 0;
  const name = normalizeCatalogSearch(tool.name);
  const aliases = tool.searchAliases.map(normalizeCatalogSearch);
  if (name === normalizedQuery) return 0;
  if (name.startsWith(normalizedQuery)) return 1;
  if (aliases.includes(normalizedQuery)) return 2;
  if (aliases.some((alias) => alias.startsWith(normalizedQuery))) return 3;
  if (name.includes(normalizedQuery) || aliases.some((alias) => alias.includes(normalizedQuery))) {
    return 4;
  }
  if (
    tool.purposes.some((id) => {
      const label = purposeDefinitions.find((item) => item.id === id)?.label ?? "";
      return normalizeCatalogSearch(`${id} ${label}`).includes(normalizedQuery);
    })
  ) {
    return 5;
  }
  if (
    tool.domains.some((id) => {
      const label = domainDefinitions.find((item) => item.id === id)?.label ?? "";
      return normalizeCatalogSearch(`${id} ${label}`).includes(normalizedQuery);
    })
  ) {
    return 6;
  }
  return Number.POSITIVE_INFINITY;
}

export function normalizeCatalogSearch(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("ko-KR");
}

export function searchAvailableTools(query: string): readonly AvailableToolEntry[] {
  const normalizedQuery = normalizeCatalogSearch(query);
  return Object.freeze(
    availableTools
      .map((tool) => ({ tool, score: searchScore(tool, normalizedQuery) }))
      .filter(({ score }) => Number.isFinite(score))
      .sort((left, right) => left.score - right.score || compareRank(left.tool, right.tool))
      .map(({ tool }) => tool),
  );
}

export function selectAvailableTools(filters: CatalogFilters): readonly AvailableToolEntry[] {
  const eligible = searchAvailableTools(filters.query).filter(
    (tool) =>
      (filters.domain === "all" || tool.domains.includes(filters.domain)) &&
      (filters.purpose === "all" || tool.purposes.includes(filters.purpose)),
  );
  return Object.freeze(eligible);
}

export function selectPlannedTools(state: CatalogUrlState): readonly PlannedToolEntry[] {
  if (!state.includePlanned) return Object.freeze([]);
  const normalizedQuery = normalizeCatalogSearch(state.query);
  return Object.freeze(
    plannedTools
      .filter((tool) => state.domain === "all" || tool.domains.includes(state.domain))
      .filter((tool) => state.purpose === "all" || tool.purposes.includes(state.purpose))
      .map((tool) => ({ tool, score: searchScore(tool, normalizedQuery) }))
      .filter(({ score }) => Number.isFinite(score))
      .sort((left, right) => left.score - right.score || compareRank(left.tool, right.tool))
      .map(({ tool }) => tool),
  );
}

function cleanQuery(value: string | null): string {
  return (value ?? "").normalize("NFC").trim().replace(/\s+/g, " ");
}

export function parseCatalogUrlState(params: Pick<URLSearchParams, "get">): CatalogUrlState {
  const domain = params.get("domain");
  const purpose = params.get("purpose");
  return {
    query: cleanQuery(params.get("q")),
    domain: domainFilterDefinitions.some((item) => item.id === domain)
      ? (domain as DiscoveryDomainId)
      : "all",
    purpose: purposeDefinitions.some((item) => item.id === purpose)
      ? (purpose as PurposeId)
      : "all",
    includePlanned: params.get("planned") === "1",
  };
}

export function serializeCatalogUrlState(state: CatalogUrlState): string {
  const params = new URLSearchParams();
  const query = cleanQuery(state.query);
  if (query !== "") params.set("q", query);
  if (state.domain !== "all") params.set("domain", state.domain);
  if (state.purpose !== "all") params.set("purpose", state.purpose);
  if (state.includePlanned) params.set("planned", "1");
  return params.toString();
}

export function selectHomeTools(input: HomeToolSelection): readonly AvailableToolEntry[] {
  const limit = Math.max(0, Math.min(12, input.limit ?? 12));
  const ranked = [...availableTools].sort(compareRank);
  if (input.domain !== "all") {
    const domain = input.domain;
    return Object.freeze(ranked.filter((tool) => tool.domains.includes(domain)).slice(0, limit));
  }
  const recent = [...new Set(input.recentToolIds)]
    .map(findAvailableToolById)
    .filter((tool): tool is AvailableToolEntry => tool !== undefined)
    .slice(0, 4);
  const ordered = [...recent, ...ranked.filter((tool) => tool.featured), ...ranked];
  return Object.freeze(
    [...new Map(ordered.map((tool) => [tool.id, tool])).values()].slice(0, limit),
  );
}

export function recommendAvailableTools(
  items: readonly DetectedKindItem[],
): readonly ToolRecommendation[] {
  if (items.length === 0) return Object.freeze([]);
  const distinctKinds = new Set(items.map((item) => item.kind));
  const recommendations = availableTools.flatMap((tool) => {
    const input = tool.launcherInput;
    if (input === null) return [];
    if (items.some((item) => !input.kinds.includes(item.kind))) return [];
    if (!input.allowMixedKinds && distinctKinds.size > 1) return [];
    const readiness: RecommendationReadiness =
      items.length < input.minFiles
        ? "needs-more"
        : items.length > input.maxFiles
          ? "too-many"
          : "ready";
    return [
      {
        tool,
        readiness,
        missingFiles: Math.max(0, input.minFiles - items.length),
        maximumFiles: input.maxFiles,
        matchedIndexes: items.map((item) => item.index),
        specificity: input.kinds.length,
      },
    ];
  });
  const readinessOrder = { ready: 0, "needs-more": 1, "too-many": 2 } as const;
  return Object.freeze(
    recommendations
      .sort(
        (left, right) =>
          readinessOrder[left.readiness] - readinessOrder[right.readiness] ||
          left.specificity - right.specificity ||
          compareRank(left.tool, right.tool),
      )
      .map(({ specificity: _specificity, ...recommendation }) => recommendation),
  );
}

export function groupDetectedKinds(
  items: readonly DetectedKindItem[],
): readonly DetectedKindGroup[] {
  const groups = new Map<FileKind, number[]>();
  for (const item of items) {
    groups.set(item.kind, [...(groups.get(item.kind) ?? []), item.index]);
  }
  return Object.freeze(
    [...groups].map(([kind, indexes]) => ({ kind, indexes: Object.freeze(indexes) })),
  );
}

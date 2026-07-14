export const CATALOG_PAGE_SIZE = 24;

export interface ResolvedCatalogPage<T> {
  items: readonly T[];
  total: number;
  hasMore: boolean;
}

export function resolveCatalogPage<T>(
  resolveTools: () => readonly T[],
  visibleCount: number,
): ResolvedCatalogPage<T> {
  const tools = resolveTools();
  const boundedCount = Math.min(tools.length, Math.max(0, Math.floor(visibleCount)));
  return Object.freeze({
    items: Object.freeze(tools.slice(0, boundedCount)),
    total: tools.length,
    hasMore: boundedCount < tools.length,
  });
}

export function resolveNextCatalogVisibleCount<T>(
  resolveTools: () => readonly T[],
  visibleCount: number,
): number {
  const total = resolveTools().length;
  const current = Math.max(0, Math.floor(visibleCount));
  return Math.min(total, current + CATALOG_PAGE_SIZE);
}

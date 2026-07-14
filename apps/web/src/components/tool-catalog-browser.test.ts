import { describe, expect, it } from "vitest";
import {
  CATALOG_PAGE_SIZE,
  createCatalogPagination,
  resolveCatalogPage,
  resolveNextCatalogVisibleCount,
  transitionCatalogPagination,
} from "../lib/catalog-pagination";

describe("catalog pagination", () => {
  it("reveals exactly twenty-four more tools at a time with an injected resolver", () => {
    const syntheticTools = Object.freeze(
      Array.from({ length: 49 }, (_, index) => `synthetic-${String(index).padStart(2, "0")}`),
    );
    const resolveTools = () => syntheticTools;

    const first = resolveCatalogPage(resolveTools, CATALOG_PAGE_SIZE);
    expect(first.items).toHaveLength(24);
    expect(first.hasMore).toBe(true);

    const secondCount = resolveNextCatalogVisibleCount(resolveTools, first.items.length);
    const second = resolveCatalogPage(resolveTools, secondCount);
    expect(second.items).toHaveLength(48);
    expect(second.hasMore).toBe(true);

    const finalCount = resolveNextCatalogVisibleCount(resolveTools, second.items.length);
    const final = resolveCatalogPage(resolveTools, finalCount);
    expect(final.items).toHaveLength(49);
    expect(final.hasMore).toBe(false);
  });

  it("creates a fresh twenty-four-tool page for every A to B to A filter transition", () => {
    let pagination = createCatalogPagination("filter-a");
    pagination = transitionCatalogPagination(pagination, {
      type: "reveal-more",
      filterKey: "filter-a",
      total: 49,
    });
    expect(pagination).toEqual({ filterKey: "filter-a", visibleCount: 48 });

    pagination = transitionCatalogPagination(pagination, {
      type: "filter-changed",
      filterKey: "filter-b",
    });
    expect(pagination).toEqual({ filterKey: "filter-b", visibleCount: CATALOG_PAGE_SIZE });

    pagination = transitionCatalogPagination(pagination, {
      type: "filter-changed",
      filterKey: "filter-a",
    });
    expect(pagination).toEqual({ filterKey: "filter-a", visibleCount: CATALOG_PAGE_SIZE });
  });
});

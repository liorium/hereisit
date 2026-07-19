"use client";

import {
  type DiscoveryDomainId,
  domainFilterDefinitions,
  type PlannedToolEntry,
  type PurposeFilter,
  purposeDefinitions,
} from "@hereisit/tool-registry/catalog";
import {
  type CatalogUrlState,
  parseCatalogUrlState,
  selectAvailableTools,
  selectPlannedTools,
  serializeCatalogUrlState,
} from "@hereisit/tool-registry/discovery";
import { useRouter, useSearchParams } from "next/navigation";
import { type KeyboardEvent, type ReactNode, useMemo, useRef, useState } from "react";
import {
  createCatalogPagination,
  resolveCatalogPage,
  transitionCatalogPagination,
} from "../lib/catalog-pagination";
import { focusAndRevealTab } from "../lib/focus-and-reveal-tab";
import { CatalogSearch } from "./catalog-search";
import { ToolCard } from "./tool-card";
import styles from "./tool-catalog-browser.module.css";

function catalogHref(state: CatalogUrlState): string {
  const query = serializeCatalogUrlState(state);
  return query === "" ? "/tools" : `/tools?${query}`;
}

function PlannedToolCard({ tool }: { tool: PlannedToolEntry }): ReactNode {
  return (
    <article className={styles.plannedCard}>
      <span className={styles.plannedBadge}>준비 중</span>
      <h3>{tool.name}</h3>
      <p>{tool.shortDescription}</p>
    </article>
  );
}

function AvailableCatalogResults({
  filterKey,
  tools,
}: {
  filterKey: string;
  tools: ReturnType<typeof selectAvailableTools>;
}): ReactNode {
  const [pagination, setPagination] = useState(() => createCatalogPagination(filterKey));
  const synchronizedPagination = transitionCatalogPagination(pagination, {
    type: "filter-changed",
    filterKey,
  });
  if (synchronizedPagination !== pagination) setPagination(synchronizedPagination);
  const page = resolveCatalogPage(() => tools, synchronizedPagination.visibleCount);

  return (
    <section aria-labelledby="available-tools-title" className={styles.results}>
      <div className={styles.resultHeading}>
        <h2 id="available-tools-title">사용 가능한 도구</h2>
        <span>{tools.length}개</span>
      </div>
      {page.items.length > 0 ? (
        <div className={styles.cards} data-testid="available-tool-grid">
          {page.items.map((tool) => (
            <ToolCard key={tool.id} tool={tool} />
          ))}
        </div>
      ) : (
        <p className={styles.noAvailable}>조건에 맞는 사용 가능한 도구가 없어요.</p>
      )}

      {page.hasMore ? (
        <button
          className={styles.moreButton}
          onClick={() =>
            setPagination((current) =>
              transitionCatalogPagination(current, {
                type: "reveal-more",
                filterKey,
                total: tools.length,
              }),
            )
          }
          type="button"
        >
          더 보기
        </button>
      ) : null}
    </section>
  );
}

export function ToolCatalogBrowser(): ReactNode {
  const router = useRouter();
  const searchParams = useSearchParams();
  const state = useMemo(() => parseCatalogUrlState(searchParams), [searchParams]);
  const filterKey = serializeCatalogUrlState(state);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const availableTools = useMemo(
    () =>
      selectAvailableTools({
        query: state.query,
        domain: state.domain,
        purpose: state.purpose,
      }),
    [state.domain, state.purpose, state.query],
  );
  const plannedTools = useMemo(
    () =>
      selectPlannedTools({
        query: state.query,
        domain: state.domain,
        purpose: state.purpose,
        includePlanned: state.includePlanned,
      }),
    [state.domain, state.includePlanned, state.purpose, state.query],
  );
  const selectedDomainIndex = domainFilterDefinitions.findIndex(({ id }) => id === state.domain);
  const selectedDomain = domainFilterDefinitions[selectedDomainIndex] ?? domainFilterDefinitions[0];
  const selectedTabId = `catalog-domain-tab-${selectedDomain?.id ?? "all"}`;
  const totalResults = availableTools.length + plannedTools.length;

  function replaceState(nextState: CatalogUrlState): void {
    window.history.replaceState(null, "", catalogHref(nextState));
  }

  function pushState(nextState: CatalogUrlState): void {
    router.push(catalogHref(nextState), { scroll: false });
  }

  function resetState(): void {
    window.history.pushState(null, "", "/tools");
  }

  function selectDomain(domain: DiscoveryDomainId): void {
    pushState({ ...state, domain });
  }

  function selectPurpose(purpose: PurposeFilter): void {
    pushState({ ...state, purpose });
  }

  function handleDomainKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    let nextIndex: number | undefined;
    if (event.key === "ArrowLeft") {
      nextIndex = (index - 1 + domainFilterDefinitions.length) % domainFilterDefinitions.length;
    } else if (event.key === "ArrowRight") {
      nextIndex = (index + 1) % domainFilterDefinitions.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = domainFilterDefinitions.length - 1;
    }
    if (nextIndex === undefined) return;
    const definition = domainFilterDefinitions[nextIndex];
    if (definition === undefined) return;
    event.preventDefault();
    selectDomain(definition.id);
    focusAndRevealTab(tabRefs.current[nextIndex] ?? null);
  }

  return (
    <section className={styles.catalog} aria-labelledby="tools-title">
      <header className={styles.hero}>
        <div>
          <p className="eyebrow">ALL TOOLS · LOCAL FIRST</p>
          <h1 id="tools-title">모든 도구</h1>
          <p>검색과 분야, 작업 목적을 함께 골라 지금 사용할 수 있는 도구를 찾으세요.</p>
        </div>
        <div className={styles.search}>
          <CatalogSearch
            idPrefix="tool-catalog"
            onQueryChange={(query) => replaceState({ ...state, query })}
            onSubmitQuery={(query) => pushState({ ...state, query })}
            query={state.query}
            variant="catalog"
          />
        </div>
      </header>

      <div aria-label="도구 분야" className={styles.tablist} role="tablist">
        {domainFilterDefinitions.map((definition, index) => {
          const selected = definition.id === state.domain;
          return (
            <button
              aria-controls="catalog-domain-panel"
              aria-selected={selected}
              className={styles.tab}
              id={`catalog-domain-tab-${definition.id}`}
              key={definition.id}
              onClick={() => selectDomain(definition.id)}
              onKeyDown={(event) => handleDomainKeyDown(event, index)}
              ref={(node) => {
                tabRefs.current[index] = node;
              }}
              role="tab"
              tabIndex={selected ? 0 : -1}
              type="button"
            >
              {definition.label}
            </button>
          );
        })}
      </div>

      <div
        aria-labelledby={selectedTabId}
        className={styles.panel}
        id="catalog-domain-panel"
        role="tabpanel"
      >
        <div className={styles.panelHeading}>
          <div>
            <h2>{selectedDomain?.label ?? "전체·추천"} 도구</h2>
            <p>{selectedDomain?.description ?? "필요한 도구를 모았어요."}</p>
          </div>
          <span aria-live="polite">검색 결과 {totalResults}개</span>
        </div>

        <fieldset className={styles.purposeControls}>
          <legend className={styles.visuallyHidden}>작업 목적</legend>
          <button
            aria-pressed={state.purpose === "all"}
            onClick={() => selectPurpose("all")}
            type="button"
          >
            전체
          </button>
          {purposeDefinitions.map((purpose) => (
            <button
              aria-pressed={state.purpose === purpose.id}
              key={purpose.id}
              onClick={() => selectPurpose(purpose.id)}
              type="button"
            >
              {purpose.label}
            </button>
          ))}
        </fieldset>

        <label className={styles.plannedToggle}>
          <input
            checked={state.includePlanned}
            onChange={(event) =>
              pushState({ ...state, includePlanned: event.currentTarget.checked })
            }
            type="checkbox"
          />
          <span>준비 중인 도구 포함</span>
        </label>

        <AvailableCatalogResults filterKey={filterKey} tools={availableTools} />

        {state.includePlanned ? (
          <section aria-labelledby="planned-tools-title" className={styles.plannedResults}>
            <div className={styles.resultHeading}>
              <h2 id="planned-tools-title">준비 중인 도구</h2>
              <span>{plannedTools.length}개</span>
            </div>
            {plannedTools.length > 0 ? (
              <div className={styles.plannedCards} data-testid="planned-tool-grid">
                {plannedTools.map((tool) => (
                  <PlannedToolCard key={tool.id} tool={tool} />
                ))}
              </div>
            ) : (
              <p className={styles.noAvailable}>조건에 맞는 준비 중 도구가 없어요.</p>
            )}
          </section>
        ) : null}

        {totalResults === 0 ? (
          <div className={styles.empty}>
            <strong>조건에 맞는 도구를 찾지 못했어요.</strong>
            <p>검색어나 필터를 지우고 전체 도구를 다시 살펴보세요.</p>
            <button onClick={resetState} type="button">
              모든 필터 초기화
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

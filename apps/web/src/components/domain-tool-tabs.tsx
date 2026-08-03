"use client";

import {
  type AvailableToolId,
  type DiscoveryDomainId,
  domainFilterDefinitions,
} from "@hereisit/tool-registry/catalog";
import { selectHomeTools, serializeCatalogUrlState } from "@hereisit/tool-registry/discovery";
import Link from "next/link";
import { type KeyboardEvent, type ReactNode, useMemo, useRef } from "react";
import { focusAndRevealTab } from "../lib/focus-and-reveal-tab";
import styles from "./domain-tool-tabs.module.css";
import { ToolCard } from "./tool-card";

function toolsHref(domain: DiscoveryDomainId): string {
  const query = serializeCatalogUrlState({
    query: "",
    domain,
    purpose: "all",
    includePlanned: false,
  });
  return query === "" ? "/tools" : `/tools?${query}`;
}

export function DomainToolTabs({
  selected,
  onSelect,
  recentToolIds,
}: {
  selected: DiscoveryDomainId;
  onSelect(id: DiscoveryDomainId): void;
  recentToolIds: readonly AvailableToolId[];
}): ReactNode {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = domainFilterDefinitions.findIndex(({ id }) => id === selected);
  const selectedDefinition = domainFilterDefinitions[selectedIndex] ?? domainFilterDefinitions[0];
  const tools = useMemo(
    () => selectHomeTools({ domain: selected, recentToolIds, limit: 12 }),
    [recentToolIds, selected],
  );

  function selectTab(index: number): void {
    const definition = domainFilterDefinitions[index];
    if (definition === undefined) return;
    onSelect(definition.id);
    focusAndRevealTab(tabRefs.current[index] ?? null);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
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
    event.preventDefault();
    selectTab(nextIndex);
  }

  if (selectedDefinition === undefined) return null;
  const selectedTabId = `home-domain-tab-${selectedDefinition.id}`;

  return (
    <section className={styles.section} aria-labelledby="home-tools-title">
      <div className={styles.heading}>
        <div>
          <p className="eyebrow">02 / 도구 선택</p>
          <h2 id="home-tools-title">도구 찾기</h2>
        </div>
      </div>

      <div aria-label="도구 분야" className={styles.tablist} role="tablist">
        {domainFilterDefinitions.map((definition, index) => {
          const isSelected = definition.id === selected;
          return (
            <button
              aria-controls="home-domain-panel"
              aria-selected={isSelected}
              className={styles.tab}
              id={`home-domain-tab-${definition.id}`}
              key={definition.id}
              onClick={() => onSelect(definition.id)}
              onKeyDown={(event) => handleKeyDown(event, index)}
              ref={(node) => {
                tabRefs.current[index] = node;
              }}
              role="tab"
              tabIndex={isSelected ? 0 : -1}
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
        id="home-domain-panel"
        role="tabpanel"
      >
        <div className={styles.panelHeading}>
          <div>
            <h3>{selectedDefinition.label} 도구</h3>
            <p>{selectedDefinition.description}</p>
          </div>
          <span aria-live="polite">{tools.length}개</span>
        </div>

        {tools.length > 0 ? (
          <div className={styles.cards} data-testid="home-tool-grid">
            {tools.map((tool) => (
              <ToolCard key={tool.id} tool={tool} />
            ))}
          </div>
        ) : (
          <p className={styles.empty}>이 분야의 도구를 준비하고 있어요.</p>
        )}

        <Link className={styles.allTools} href={toolsHref(selected)} prefetch={false}>
          {selectedDefinition.label} 모두 보기
        </Link>
      </div>
    </section>
  );
}

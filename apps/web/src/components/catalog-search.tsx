"use client";

import type { AvailableToolEntry } from "@hereisit/tool-registry/catalog";
import {
  normalizeCatalogSearch,
  searchAvailableTools,
  serializeCatalogUrlState,
} from "@hereisit/tool-registry/discovery";
import { useRouter } from "next/navigation";
import {
  type ChangeEvent,
  type FocusEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import styles from "./catalog-search.module.css";

export interface CatalogSearchProps {
  idPrefix: string;
  variant: "hero" | "header" | "drawer" | "catalog";
  initialQuery?: string;
  query?: string;
  onQueryChange?(query: string): void;
  onSubmitQuery?(query: string): void;
  onNavigate?(): void;
}

const EMPTY_RESULTS: readonly AvailableToolEntry[] = Object.freeze([]);

function clearAnnouncementTimer(timerRef: { current: number | null }): void {
  if (timerRef.current === null) return;
  window.clearTimeout(timerRef.current);
  timerRef.current = null;
}

function restartAnnouncementTimer(
  timerRef: { current: number | null },
  rawQuery: string,
  resultCount: number,
  announce: (message: string) => void,
): void {
  clearAnnouncementTimer(timerRef);
  announce("");
  if (normalizeCatalogSearch(rawQuery) === "") return;
  timerRef.current = window.setTimeout(() => {
    announce(`검색 결과 ${resultCount}개`);
    timerRef.current = null;
  }, 150);
}

function optionId(idPrefix: string, tool: AvailableToolEntry): string {
  return `${idPrefix}-option-${tool.id.replaceAll(".", "-")}`;
}

export function CatalogSearch({
  idPrefix,
  variant,
  initialQuery = "",
  query,
  onQueryChange,
  onSubmitQuery,
  onNavigate,
}: CatalogSearchProps): ReactNode {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const announcementTimerRef = useRef<number | null>(null);
  const [localQuery, setLocalQuery] = useState(initialQuery);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [activeToolId, setActiveToolId] = useState<string | null>(null);
  const [liveMessage, setLiveMessage] = useState("");
  const currentQuery = query === undefined ? localQuery : query;
  const normalizedQuery = normalizeCatalogSearch(currentQuery);
  const results = useMemo(
    () =>
      normalizedQuery === ""
        ? EMPTY_RESULTS
        : Object.freeze(searchAvailableTools(currentQuery).slice(0, 5)),
    [currentQuery, normalizedQuery],
  );
  const activeIndex = results.findIndex((tool) => tool.id === activeToolId);
  const showSuggestions = suggestionsOpen && normalizedQuery !== "";
  const listboxId = `${idPrefix}-listbox`;
  const inputId = `${idPrefix}-input`;

  useEffect(() => {
    restartAnnouncementTimer(announcementTimerRef, currentQuery, results.length, setLiveMessage);
    return () => clearAnnouncementTimer(announcementTimerRef);
  }, [currentQuery, results.length]);

  function closeSuggestions(): void {
    setSuggestionsOpen(false);
    setActiveToolId(null);
  }

  function updateQuery(event: ChangeEvent<HTMLInputElement>): void {
    const nextQuery = event.currentTarget.value;
    restartAnnouncementTimer(
      announcementTimerRef,
      nextQuery,
      Math.min(5, searchAvailableTools(nextQuery).length),
      setLiveMessage,
    );
    if (query === undefined) setLocalQuery(nextQuery);
    onQueryChange?.(nextQuery);
    setActiveToolId(null);
    setSuggestionsOpen(normalizeCatalogSearch(nextQuery) !== "");
  }

  function navigateToTool(tool: AvailableToolEntry): void {
    closeSuggestions();
    router.push(tool.route);
    onNavigate?.();
  }

  function submitSearch(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (normalizedQuery === "") {
      closeSuggestions();
      return;
    }

    closeSuggestions();
    if (onSubmitQuery !== undefined) {
      onSubmitQuery(currentQuery);
    } else {
      const catalogState = serializeCatalogUrlState({
        query: currentQuery,
        domain: "all",
        purpose: "all",
        includePlanned: false,
      });
      router.push(`/tools?${catalogState}`);
    }
    onNavigate?.();
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Escape") {
      closeSuggestions();
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (results.length === 0) return;
      setSuggestionsOpen(true);
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const nextIndex =
        activeIndex < 0
          ? direction > 0
            ? 0
            : results.length - 1
          : (activeIndex + direction + results.length) % results.length;
      setActiveToolId(results[nextIndex]?.id ?? null);
      return;
    }

    if (event.key === "Enter" && showSuggestions && activeIndex >= 0) {
      const selectedTool = results[activeIndex];
      if (selectedTool !== undefined) {
        event.preventDefault();
        navigateToTool(selectedTool);
      }
    }
  }

  function handleFormBlur(event: FocusEvent<HTMLFormElement>): void {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && formRef.current?.contains(nextTarget)) return;
    closeSuggestions();
  }

  return (
    <form
      className={`${styles.search} ${styles[variant]}`}
      onBlur={handleFormBlur}
      onSubmit={submitSearch}
      ref={formRef}
    >
      <label className={styles.label} htmlFor={inputId}>
        도구 검색
      </label>
      <div className={styles.fieldRow}>
        <input
          aria-activedescendant={
            showSuggestions && activeIndex >= 0
              ? optionId(idPrefix, results[activeIndex] as AvailableToolEntry)
              : undefined
          }
          aria-autocomplete="list"
          aria-controls={showSuggestions ? listboxId : undefined}
          aria-expanded={showSuggestions}
          autoComplete="off"
          className={styles.input}
          id={inputId}
          onChange={updateQuery}
          onFocus={() => setSuggestionsOpen(normalizedQuery !== "")}
          onKeyDown={handleInputKeyDown}
          placeholder="어떤 도구가 필요하세요?"
          role="combobox"
          type="search"
          value={currentQuery}
        />
        <button className={styles.submit} type="submit">
          검색하기
        </button>
      </div>

      {showSuggestions ? (
        <div aria-label="도구 검색 결과" className={styles.listbox} id={listboxId} role="listbox">
          {results.length > 0 ? (
            results.map((tool) => {
              const selected = tool.id === activeToolId;
              return (
                <div className={styles.optionItem} key={tool.id} role="none">
                  <button
                    aria-selected={selected}
                    className={styles.option}
                    id={optionId(idPrefix, tool)}
                    onClick={() => navigateToTool(tool)}
                    onPointerDown={() => setActiveToolId(tool.id)}
                    onPointerMove={() => setActiveToolId(tool.id)}
                    role="option"
                    tabIndex={-1}
                    type="button"
                  >
                    <strong>{tool.name}</strong>
                    <span>{tool.shortDescription}</span>
                  </button>
                </div>
              );
            })
          ) : (
            <div className={styles.empty}>일치하는 도구가 없어요.</div>
          )}
        </div>
      ) : null}

      {variant === "catalog" ? null : (
        <span aria-atomic="true" aria-live="polite" className={styles.liveRegion} role="status">
          {liveMessage}
        </span>
      )}
    </form>
  );
}

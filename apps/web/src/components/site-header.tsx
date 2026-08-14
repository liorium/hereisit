"use client";

import {
  type AvailableToolEntry,
  availableToolEntries,
  domainDefinitions,
} from "@hereisit/tool-registry/catalog";
import { selectHomeTools, serializeCatalogUrlState } from "@hereisit/tool-registry/discovery";
import Link from "next/link";
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useToolPreferences } from "../lib/use-tool-preferences";
import { CatalogSearch } from "./catalog-search";
import styles from "./site-header.module.css";
import { globalNavigationLinks } from "./site-header-navigation";

type GlobalOverlay = "mega" | "search" | "drawer" | null;

const domainLinks = Object.freeze(
  domainDefinitions.map((domain) => ({
    ...domain,
    href: `/tools?${serializeCatalogUrlState({
      query: "",
      domain: domain.id,
      purpose: "all",
      includePlanned: false,
    })}`,
  })),
);

const featuredTools = Object.freeze(
  selectHomeTools({ domain: "all", recentToolIds: [], limit: 12 })
    .filter((tool) => tool.featured)
    .slice(0, 4),
);
const availableRoutes: ReadonlySet<string> = new Set<string>(
  availableToolEntries.map((tool) => tool.route),
);

function normalizeExplicitPath(path: string | undefined): string | undefined {
  if (path === undefined || !path.startsWith("/")) return undefined;
  const suffixIndex = path.search(/[?#]/);
  const pathname = suffixIndex < 0 ? path : path.slice(0, suffixIndex);
  return pathname === "/" ? pathname : pathname.replace(/\/+$/, "");
}

function isCurrentPath(activePath: string | undefined, href: string): boolean {
  return activePath !== undefined && activePath === normalizeExplicitPath(href);
}

function restoreFocus(triggerRef: RefObject<HTMLButtonElement | null>): void {
  window.requestAnimationFrame(() => {
    if (triggerRef.current?.isConnected) triggerRef.current.focus({ preventScroll: true });
  });
}

function CatalogToolLinks({
  tools,
  section,
  onNavigate,
}: {
  tools: readonly AvailableToolEntry[];
  section: "featured" | "recent";
  onNavigate(): void;
}): ReactNode {
  return (
    <ul className={styles.toolList} data-tool-section={section}>
      {tools.map((tool) => (
        <li key={tool.id}>
          <Link
            className={styles.toolLink}
            data-tool-link
            href={tool.route}
            onClick={onNavigate}
            prefetch={false}
          >
            <strong>{tool.name}</strong>
            <span>{tool.shortDescription}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function trapDialogFocus(event: KeyboardEvent<HTMLDialogElement>): void {
  if (event.key !== "Tab") return;
  const focusable = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => element.getClientRects().length > 0);
  const first = focusable[0];
  const last = focusable.at(-1);
  if (first === undefined || last === undefined) return;

  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export function SiteHeader({ activePath }: { activePath?: string }): ReactNode {
  const [overlay, setOverlay] = useState<GlobalOverlay>(null);
  const { recent } = useToolPreferences();
  const headerRef = useRef<HTMLElement>(null);
  const megaTriggerRef = useRef<HTMLButtonElement>(null);
  const searchTriggerRef = useRef<HTMLButtonElement>(null);
  const mobileTriggerRef = useRef<HTMLButtonElement>(null);
  const searchPanelRef = useRef<HTMLDivElement>(null);
  const megaPanelRef = useRef<HTMLElement>(null);
  const drawerRef = useRef<HTMLDialogElement>(null);
  const drawerCloseRef = useRef<HTMLButtonElement>(null);
  const normalizedActivePath = normalizeExplicitPath(activePath);
  const recentTools = useMemo(() => {
    const recentIds = new Set<string>(recent);
    return Object.freeze(
      selectHomeTools({ domain: "all", recentToolIds: recent, limit: 12 })
        .filter((tool) => recentIds.has(tool.id))
        .slice(0, 4),
    );
  }, [recent]);
  const toolsAreActive =
    normalizedActivePath === "/tools" ||
    (normalizedActivePath !== undefined && availableRoutes.has(normalizedActivePath));

  useEffect(() => {
    if (overlay !== "search") return;
    const frame = window.requestAnimationFrame(() => {
      searchPanelRef.current?.querySelector<HTMLInputElement>("input")?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [overlay]);

  useEffect(() => {
    if (overlay !== "mega" && overlay !== "search") return;
    const panel = overlay === "mega" ? megaPanelRef.current : searchPanelRef.current;
    const triggerRef = overlay === "mega" ? megaTriggerRef : searchTriggerRef;

    function closeDesktopOverlay(): void {
      setOverlay(null);
      restoreFocus(triggerRef);
    }

    function handlePointerDown(event: PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Node)) return;
      const isOverlayTrigger = [
        megaTriggerRef.current,
        searchTriggerRef.current,
        mobileTriggerRef.current,
      ].some((trigger) => trigger?.contains(target));
      if (panel?.contains(target) || isOverlayTrigger) return;
      closeDesktopOverlay();
    }

    function handleKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeDesktopOverlay();
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [overlay]);

  useEffect(() => {
    if (overlay !== "drawer") return;
    const dialog = drawerRef.current;
    const header = headerRef.current;
    if (dialog === null || header === null) return;

    const inertSiblings = Array.from(header.parentElement?.children ?? [])
      .filter(
        (element): element is HTMLElement => element instanceof HTMLElement && element !== header,
      )
      .map((element) => ({ element, wasInert: element.inert }));
    const previousOverflow = document.body.style.overflow;
    for (const { element } of inertSiblings) element.inert = true;
    document.body.style.overflow = "hidden";
    if (!dialog.open) dialog.showModal();
    drawerCloseRef.current?.focus({ preventScroll: true });

    return () => {
      for (const { element, wasInert } of inertSiblings) element.inert = wasInert;
      document.body.style.overflow = previousOverflow;
      if (dialog.open) dialog.close();
      restoreFocus(mobileTriggerRef);
    };
  }, [overlay]);

  function closeOverlay(): void {
    setOverlay(null);
  }

  function enterMegaDisclosure(event: KeyboardEvent<HTMLButtonElement>): void {
    if (overlay !== "mega" || event.key !== "Tab" || event.shiftKey) return;
    const firstLink = megaPanelRef.current?.querySelector<HTMLAnchorElement>("a[href]");
    if (firstLink === undefined || firstLink === null) return;
    event.preventDefault();
    firstLink.focus();
  }

  return (
    <header className={styles.header} ref={headerRef}>
      <Link
        aria-current={isCurrentPath(normalizedActivePath, "/") ? "page" : undefined}
        aria-label="HereIsIt 홈"
        className={styles.brand}
        href="/"
        onClick={closeOverlay}
        prefetch={false}
      >
        <span aria-hidden="true" className={styles.brandMark}>
          H
        </span>
        <span>HereIsIt</span>
      </Link>

      <div className={styles.desktopActions}>
        <nav aria-label="주요 탐색" className={styles.desktopNav}>
          <button
            aria-controls="site-header-mega"
            aria-expanded={overlay === "mega"}
            className={styles.navButton}
            data-active={toolsAreActive ? "true" : undefined}
            onClick={() => setOverlay((current) => (current === "mega" ? null : "mega"))}
            onKeyDown={enterMegaDisclosure}
            ref={megaTriggerRef}
            type="button"
          >
            모든 도구
          </button>
          {globalNavigationLinks.map((destination) => (
            <Link
              aria-current={
                isCurrentPath(normalizedActivePath, destination.href) ? "page" : undefined
              }
              className={styles.navLink}
              href={destination.href}
              key={destination.href}
              onClick={closeOverlay}
              prefetch={false}
            >
              {destination.label}
            </Link>
          ))}
          <button
            aria-controls="site-header-search"
            aria-expanded={overlay === "search"}
            className={styles.searchTrigger}
            onClick={() => setOverlay((current) => (current === "search" ? null : "search"))}
            ref={searchTriggerRef}
            type="button"
          >
            <span aria-hidden="true">⌕</span>
            검색
          </button>
        </nav>

        {overlay === "mega" ? (
          <nav
            aria-label="도구 탐색"
            className={styles.mega}
            data-testid="desktop-mega"
            id="site-header-mega"
            ref={megaPanelRef}
          >
            <section className={styles.domainSection}>
              <div className={styles.sectionHeading}>
                <h2>분야별 도구</h2>
              </div>
              <ul className={styles.domainGrid}>
                {domainLinks.map((domain) => (
                  <li key={domain.id}>
                    <Link href={domain.href} onClick={closeOverlay} prefetch={false}>
                      {domain.label}
                    </Link>
                  </li>
                ))}
              </ul>
              <Link
                className={styles.allToolsLink}
                href="/tools"
                onClick={closeOverlay}
                prefetch={false}
              >
                모든 도구 보기
              </Link>
            </section>

            <section className={styles.toolSection}>
              <h2>추천 도구</h2>
              <CatalogToolLinks
                tools={featuredTools}
                section="featured"
                onNavigate={closeOverlay}
              />
            </section>

            <section className={styles.toolSection}>
              <h2>최근 사용</h2>
              {recentTools.length > 0 ? (
                <CatalogToolLinks tools={recentTools} section="recent" onNavigate={closeOverlay} />
              ) : (
                <p className={styles.emptyRecent}>아직 최근 사용한 도구가 없어요.</p>
              )}
            </section>
          </nav>
        ) : null}

        {overlay === "search" ? (
          <div
            className={styles.searchPanel}
            data-testid="desktop-search"
            id="site-header-search"
            ref={searchPanelRef}
          >
            <CatalogSearch idPrefix="site-header" onNavigate={closeOverlay} variant="header" />
          </div>
        ) : null}
      </div>

      <button
        aria-controls="site-header-drawer"
        aria-expanded={overlay === "drawer"}
        aria-label="메뉴 열기"
        className={styles.mobileTrigger}
        onClick={() => setOverlay("drawer")}
        ref={mobileTriggerRef}
        type="button"
      >
        <span aria-hidden="true" />
        <span aria-hidden="true" />
        <span aria-hidden="true" />
      </button>

      <dialog
        aria-labelledby="site-header-drawer-title"
        className={styles.drawer}
        id="site-header-drawer"
        onCancel={(event) => {
          event.preventDefault();
          closeOverlay();
        }}
        onClose={() => {
          if (overlay === "drawer") closeOverlay();
        }}
        onKeyDown={trapDialogFocus}
        ref={drawerRef}
      >
        <div className={styles.drawerContent}>
          <div className={styles.drawerHeader}>
            <h2 id="site-header-drawer-title">전체 메뉴</h2>
            <button
              aria-label="메뉴 닫기"
              className={styles.drawerClose}
              onClick={closeOverlay}
              ref={drawerCloseRef}
              type="button"
            >
              <span aria-hidden="true">×</span>
            </button>
          </div>

          <CatalogSearch idPrefix="site-drawer" onNavigate={closeOverlay} variant="drawer" />

          <nav aria-label="모바일 주요 탐색" className={styles.drawerDestinations}>
            <Link href="/" onClick={closeOverlay} prefetch={false}>
              홈
            </Link>
            <Link href="/tools" onClick={closeOverlay} prefetch={false}>
              모든 도구
            </Link>
            {globalNavigationLinks.map((destination) => (
              <Link
                href={destination.href}
                key={destination.href}
                onClick={closeOverlay}
                prefetch={false}
              >
                {destination.label}
              </Link>
            ))}
          </nav>

          <section className={styles.drawerSection}>
            <h3>분야별 도구</h3>
            <ul className={styles.drawerDomainGrid} data-testid="mobile-domain-grid">
              {domainLinks.map((domain) => (
                <li key={domain.id}>
                  <Link href={domain.href} onClick={closeOverlay} prefetch={false}>
                    {domain.label}
                  </Link>
                </li>
              ))}
            </ul>
          </section>

          {recentTools.length > 0 ? (
            <section className={styles.drawerSection}>
              <h3>최근 사용</h3>
              <CatalogToolLinks tools={recentTools} section="recent" onNavigate={closeOverlay} />
            </section>
          ) : null}

          <footer className={styles.drawerFooter}>
            <span aria-hidden="true" />
            파일은 명시된 경우를 제외하고 이 기기에서만 처리해요.
          </footer>
        </div>
      </dialog>
    </header>
  );
}

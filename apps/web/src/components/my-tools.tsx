"use client";

import {
  type AvailableToolEntry,
  availableToolEntries,
  findAvailableToolById,
} from "@hereisit/tool-registry/catalog";
import Link from "next/link";
import { type ReactNode, useEffect, useState } from "react";
import { MAX_PERSONAL_TOOLS } from "../lib/tool-preferences";
import { useToolPreferences } from "../lib/use-tool-preferences";
import styles from "./my-tools.module.css";
import { ToolCard } from "./tool-card";

const featuredTools = Object.freeze(
  availableToolEntries.filter((tool) => tool.featured).slice(0, 4),
);

function resolvePersonalTools(ids: readonly string[]): readonly AvailableToolEntry[] {
  return Object.freeze(
    ids
      .slice(0, MAX_PERSONAL_TOOLS)
      .map(findAvailableToolById)
      .filter((tool): tool is AvailableToolEntry => tool !== undefined),
  );
}

function PersonalToolSection({
  title,
  emptyMessage,
  tools,
}: {
  title: string;
  emptyMessage: string;
  tools: readonly AvailableToolEntry[];
}): ReactNode {
  const titleId = `my-tools-${title === "즐겨찾는 도구" ? "favorites" : "recent"}-title`;
  return (
    <section aria-labelledby={titleId} className={styles.toolSection}>
      <div className={styles.sectionHeading}>
        <h2 id={titleId}>{title}</h2>
        <span>{tools.length}개</span>
      </div>
      {tools.length > 0 ? (
        <div className={styles.cards}>
          {tools.map((tool) => (
            <ToolCard key={tool.id} tool={tool} />
          ))}
        </div>
      ) : (
        <p className={styles.sectionEmpty}>{emptyMessage}</p>
      )}
    </section>
  );
}

export function MyTools(): ReactNode {
  const preferences = useToolPreferences();
  const [clientReady, setClientReady] = useState(false);
  const favoriteTools = resolvePersonalTools(preferences.favorites);
  const recentTools = resolvePersonalTools(preferences.recent);
  const isEmpty = favoriteTools.length === 0 && recentTools.length === 0;

  useEffect(() => {
    setClientReady(true);
  }, []);

  return (
    <section className={styles.page} aria-labelledby="my-tools-title">
      <header className={styles.hero}>
        <p className="eyebrow">SAVED ON THIS DEVICE</p>
        <h1 id="my-tools-title">내 도구</h1>
        <p>즐겨찾기와 최근 사용 기록은 이 브라우저에 도구 ID만 저장해 정리해요.</p>
      </header>

      {clientReady && preferences.persistence === "memory" ? (
        <p className={styles.memoryNote} role="status">
          브라우저 저장소를 사용할 수 없어 이 탭에서만 목록을 기억해요. 도구 검색과 파일 처리는
          그대로 사용할 수 있어요.
        </p>
      ) : null}

      {isEmpty ? (
        <section aria-labelledby="my-tools-empty-title" className={styles.emptyState}>
          <h2 id="my-tools-empty-title">아직 모아 둔 도구가 없어요.</h2>
          <p>추천 도구를 열어 보거나 모든 도구에서 필요한 작업을 찾아보세요.</p>
          <div className={styles.featuredLinks}>
            {featuredTools.map((tool) => (
              <Link href={tool.route} key={tool.id} prefetch={false}>
                {tool.name}
              </Link>
            ))}
          </div>
          <Link className={styles.allToolsLink} href="/tools" prefetch={false}>
            모든 도구 보기
          </Link>
        </section>
      ) : (
        <div className={styles.sections}>
          <PersonalToolSection
            emptyMessage="도구 카드의 별을 눌러 즐겨찾기에 추가해 보세요."
            title="즐겨찾는 도구"
            tools={favoriteTools}
          />
          <PersonalToolSection
            emptyMessage="도구를 사용하면 최근 기록이 여기에 표시돼요."
            title="최근 사용한 도구"
            tools={recentTools}
          />
        </div>
      )}
    </section>
  );
}

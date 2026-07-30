import type { AvailableToolId } from "@hereisit/tool-registry/catalog";
import { getAvailableToolById, getRelatedAvailableTools } from "@hereisit/tool-registry/catalog";
import Link from "next/link";
import type { ReactNode } from "react";
import { getToolImplementation } from "../lib/tool-implementations";
import { FavoriteToolButton } from "./favorite-tool-button";
import { SiteFooter } from "./site-footer";
import { SiteHeader } from "./site-header";
import { ToolCard } from "./tool-card";
import styles from "./tool-detail-page.module.css";
import { ToolVisitTracker } from "./tool-visit-tracker";

export interface ToolDetailPageProps {
  toolId: AvailableToolId;
  workbench: ReactNode;
}

export function ToolDetailPage({ toolId, workbench }: ToolDetailPageProps): ReactNode {
  const tool = getAvailableToolById(toolId);
  const implementation = getToolImplementation(toolId);
  const related = getRelatedAvailableTools(toolId);

  if (tool.experience === "quick") {
    throw new Error(`Quick detail shell is not implemented: ${toolId}`);
  }

  const workAreaLabel = tool.experience === "workspace" ? "편집 작업 공간" : "파일 작업 영역";
  const primaryDomain = tool.domains[0];

  return (
    <>
      <ToolVisitTracker toolId={toolId} />
      <SiteHeader activePath={tool.route} />
      <main className={styles.page}>
        <nav aria-label="현재 위치" className={styles.breadcrumbs}>
          <Link href="/" prefetch={false}>
            홈
          </Link>
          <Link href={`/tools?domain=${primaryDomain}`} prefetch={false}>
            모든 도구
          </Link>
          <span aria-current="page">{tool.name}</span>
        </nav>

        <header className={styles.hero}>
          <p className={styles.eyebrow}>{implementation.eyebrow}</p>
          <div className={styles.titleRow}>
            <h1>{tool.name}</h1>
            <FavoriteToolButton toolId={toolId} toolName={tool.name} />
          </div>
          <p className={styles.description}>{tool.shortDescription}</p>
          <p className={styles.summary}>{implementation.defaultSummary}</p>
          {tool.execution === "browser" ? (
            <section aria-label="처리 방식" className={styles.execution}>
              <strong>이 기기에서 처리</strong>
              <span>파일은 업로드되지 않으며 다운로드는 버튼을 눌러 직접 시작해요.</span>
            </section>
          ) : null}
          {implementation.notices.map((notice) => (
            <p
              className={notice.tone === "warning" ? styles.warning : styles.support}
              key={notice.text}
            >
              {notice.text}
            </p>
          ))}
        </header>

        <section
          aria-label={workAreaLabel}
          className={tool.experience === "workspace" ? styles.workspace : styles.file}
        >
          {workbench}
        </section>

        <section aria-label="다음 작업" className={styles.related}>
          <h2>다음 작업</h2>
          <div className={styles.relatedGrid}>
            {related.map((item) => (
              <ToolCard context="related" key={item.id} tool={item} />
            ))}
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}

import { type AvailableToolEntry, availableToolEntries } from "@hereisit/tool-registry/catalog";
import Link from "next/link";
import type { ReactNode } from "react";
import { FavoriteToolButton } from "./favorite-tool-button";
import styles from "./tool-card.module.css";

export function ToolCard({
  tool,
  context = "catalog",
}: {
  tool: AvailableToolEntry;
  context?: "catalog" | "related";
}): ReactNode {
  const catalogTool = availableToolEntries.find((entry) => entry.id === tool.id);
  if (catalogTool === undefined) {
    throw new Error(`ToolCard requires an available catalog tool: ${tool.id}`);
  }

  return (
    <article className={styles.card} data-context={context}>
      <Link className={styles.link} href={catalogTool.route} prefetch={false}>
        <span className={styles.name}>{catalogTool.name}</span>
        <span className={styles.description}>{catalogTool.shortDescription}</span>
        <span className={styles.execution}>
          {catalogTool.execution === "browser" ? "내 기기에서 처리" : "서버에서 처리"}
        </span>
      </Link>
      <FavoriteToolButton toolId={catalogTool.id} />
    </article>
  );
}

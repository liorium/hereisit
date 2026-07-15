"use client";

import type { AvailableToolId } from "@hereisit/tool-registry/catalog";
import type { MouseEvent, ReactNode } from "react";
import { toolPreferencesStore } from "../lib/tool-preferences";
import { useToolPreferences } from "../lib/use-tool-preferences";
import styles from "./tool-card.module.css";

export function FavoriteToolButton({ toolId }: { toolId: AvailableToolId }): ReactNode {
  const { favorites } = useToolPreferences();
  const isFavorite = favorites.includes(toolId);
  const label = isFavorite ? "즐겨찾기 해제" : "즐겨찾기 추가";

  function toggleFavorite(event: MouseEvent<HTMLButtonElement>): void {
    event.stopPropagation();
    toolPreferencesStore.toggleFavorite(toolId);
  }

  return (
    <button
      aria-pressed={isFavorite}
      className={styles.favoriteButton}
      onClick={toggleFavorite}
      type="button"
    >
      <span className={styles.favoriteLabel}>{label}</span>
      <span aria-hidden="true" className={styles.favoriteIcon}>
        {isFavorite ? "★" : "☆"}
      </span>
    </button>
  );
}

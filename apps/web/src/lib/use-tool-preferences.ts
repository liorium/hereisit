"use client";

import type { AvailableToolId } from "@hereisit/tool-registry/catalog";
import { useSyncExternalStore } from "react";
import { type ToolPreferencesSnapshot, toolPreferencesStore } from "./tool-preferences";

const EMPTY_SERVER_TOOL_IDS: readonly AvailableToolId[] = Object.freeze([]);
const EMPTY_SERVER_SNAPSHOT: ToolPreferencesSnapshot = Object.freeze({
  favorites: EMPTY_SERVER_TOOL_IDS,
  recent: EMPTY_SERVER_TOOL_IDS,
  persistence: "memory",
});

function getEmptyServerSnapshot(): ToolPreferencesSnapshot {
  return EMPTY_SERVER_SNAPSHOT;
}

export function useToolPreferences(): ToolPreferencesSnapshot {
  return useSyncExternalStore(
    toolPreferencesStore.subscribe,
    toolPreferencesStore.getSnapshot,
    getEmptyServerSnapshot,
  );
}

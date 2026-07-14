"use client";

import type { AvailableToolId } from "@hereisit/tool-registry/catalog";
import { useEffect } from "react";
import { toolPreferencesStore } from "../lib/tool-preferences";

export function ToolVisitTracker({ toolId }: { toolId: AvailableToolId }): null {
  useEffect(() => {
    toolPreferencesStore.recordRecent(toolId);
  }, [toolId]);

  return null;
}

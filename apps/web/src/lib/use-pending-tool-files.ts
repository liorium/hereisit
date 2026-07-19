"use client";

import type { AvailableToolId } from "@hereisit/tool-registry/catalog";
import { useEffect, useRef } from "react";
import { consumePendingToolSelection } from "./pending-tool-selection";

interface UsePendingToolFilesOptions {
  toolId: AvailableToolId;
  ready: boolean;
  acceptFiles(files: readonly File[]): void | Promise<void>;
  onReselectRequired(message: "파일을 다시 선택해 주세요"): void;
}

export function usePendingToolFiles({
  toolId,
  ready,
  acceptFiles,
  onReselectRequired,
}: UsePendingToolFilesOptions): void {
  const attemptedToolId = useRef<AvailableToolId | null>(null);

  useEffect(() => {
    if (!ready || attemptedToolId.current === toolId) return;
    attemptedToolId.current = toolId;
    const result = consumePendingToolSelection(toolId);
    if (result.state === "consumed") {
      void acceptFiles(result.items.map(({ file }) => file));
    } else if (result.state === "expired" || result.state === "target-mismatch") {
      onReselectRequired("파일을 다시 선택해 주세요");
    }
  }, [acceptFiles, onReselectRequired, ready, toolId]);
}

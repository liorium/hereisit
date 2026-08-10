import { runImageBatch } from "@hereisit/browser-runtime/image";
import type { LocalImageOptimizeRuntimeEvent } from "@hereisit/browser-runtime/image-optimize";
import { runLosslessImageOptimizeBatch } from "@hereisit/browser-runtime/image-optimize";
import type {
  BatchImageItem,
  BatchItemResult,
  BatchRuntimeEvent,
  ImagePipelineSpecV2,
} from "@hereisit/tool-contracts";
import type {
  ImageOptimizeMime,
  ImageOptimizePhase,
  ImageOptimizeSpecV1,
  ImageOptimizeWarningCode,
} from "@hereisit/tool-contracts/image-optimize";

export interface LocalImageOptimizeItem {
  readonly itemId: string;
  readonly file: File;
  readonly mime: ImageOptimizeMime;
}

export type LocalImageOptimizeResult =
  | {
      readonly status: "fulfilled";
      readonly itemId: string;
      readonly mime: ImageOptimizeMime;
      readonly bytes: ArrayBuffer;
      readonly byteLength: number;
      readonly width: number;
      readonly height: number;
      readonly warnings: readonly ImageOptimizeWarningCode[];
    }
  | {
      readonly status: "original-retained";
      readonly itemId: string;
      readonly warnings: readonly ["ORIGINAL_RETAINED_UNMODIFIED"];
    }
  | {
      readonly status: "unsupported";
      readonly itemId: string;
      readonly reason: "LOSSLESS_SERVER_REQUIRED";
    }
  | { readonly status: "cancelled"; readonly itemId: string }
  | {
      readonly status: "rejected";
      readonly itemId: string;
      readonly message: string;
    };

type ProgressEvent = {
  readonly type: "item-progress";
  readonly itemId: string;
  readonly phase: Extract<
    ImageOptimizePhase,
    "inspecting" | "optimizing" | "verifying" | "completed"
  >;
  readonly fraction: number | null;
};

export type LocalImageOptimizeEvent =
  | ProgressEvent
  | {
      readonly type: "item-complete";
      readonly itemId: string;
      readonly result: LocalImageOptimizeResult;
    };

export interface LocalImageOptimizeBatchHandle {
  readonly result: Promise<readonly LocalImageOptimizeResult[]>;
  cancel(): void;
}

interface SmartImageBatchHandle {
  readonly result: Promise<readonly BatchItemResult[]>;
  cancel(): void;
}

export interface LocalFallbackOptions {
  readonly signal?: AbortSignal;
  readonly smartSupported?: boolean;
  readonly onEvent?: (event: LocalImageOptimizeEvent) => void;
  readonly runSmart?: (
    items: readonly BatchImageItem[],
    options: { readonly concurrency: 1; readonly onEvent: (event: BatchRuntimeEvent) => void },
  ) => SmartImageBatchHandle;
  readonly runLossless?: (
    items: readonly { itemId: string; file: File }[],
    options: { readonly onEvent: (event: LocalImageOptimizeRuntimeEvent) => void },
  ) => LocalImageOptimizeBatchHandle;
}

function emit(options: LocalFallbackOptions, event: LocalImageOptimizeEvent): void {
  try {
    options.onEvent?.(event);
  } catch {
    // UI observers cannot own processing.
  }
}

function complete(options: LocalFallbackOptions, result: LocalImageOptimizeResult): void {
  emit(options, { type: "item-complete", itemId: result.itemId, result });
}

function smartPipelineSpec(optimize: ImageOptimizeSpecV1): ImagePipelineSpecV2 {
  return {
    version: 2,
    resize: { kind: "none" },
    output: {
      format: "source",
      compression: { mode: "quality", quality: optimize.preset === "smallest" ? 72 : 82 },
    },
    sizeGoal: {
      mode: "smaller-only",
      minSavingsPercent: optimize.minimumSavingsPercent,
      minQuality: 35,
      maxAttempts: 3,
    },
    autoOrient: true,
    metadata: "strip",
  };
}

function cancelled(itemId: string): LocalImageOptimizeResult {
  return { status: "cancelled", itemId };
}

function smartProgress(event: BatchRuntimeEvent): ProgressEvent | undefined {
  if (event.type !== "item-progress") return undefined;
  return {
    type: "item-progress",
    itemId: event.itemId,
    phase:
      event.phase === "finalizing"
        ? "verifying"
        : event.phase === "transforming" || event.phase === "encoding"
          ? "optimizing"
          : "inspecting",
    fraction: event.fraction,
  };
}

function smartResult(
  result: BatchItemResult | undefined,
  source: LocalImageOptimizeItem,
): LocalImageOptimizeResult {
  if (result === undefined || result.status === "cancelled") return cancelled(source.itemId);
  if (result.status === "rejected") {
    if (result.error.code === "NO_SIZE_REDUCTION") {
      return {
        status: "original-retained",
        itemId: source.itemId,
        warnings: ["ORIGINAL_RETAINED_UNMODIFIED"],
      };
    }
    return { status: "rejected", itemId: source.itemId, message: result.error.message };
  }
  return {
    status: "fulfilled",
    itemId: source.itemId,
    mime: result.value.mime,
    bytes: result.value.bytes,
    byteLength: result.value.byteLength,
    width: result.value.width,
    height: result.value.height,
    warnings: source.mime === "image/png" ? ["SMART_PNG_FELL_BACK_TO_LOSSLESS"] : [],
  };
}

function onceCancel(handle: { cancel(): void }, signal: AbortSignal | undefined): () => void {
  let cancelled = false;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    handle.cancel();
  };
  if (signal?.aborted) cancel();
  else signal?.addEventListener("abort", cancel, { once: true });
  return () => signal?.removeEventListener("abort", cancel);
}

export async function runLocalImageOptimizeFallback(
  items: readonly LocalImageOptimizeItem[],
  spec: ImageOptimizeSpecV1,
  options: LocalFallbackOptions = {},
): Promise<readonly LocalImageOptimizeResult[]> {
  if (items.length === 0) return [];
  if (options.signal?.aborted) return items.map((item) => cancelled(item.itemId));

  if (spec.mode === "lossless") {
    const runLossless = options.runLossless ?? runLosslessImageOptimizeBatch;
    const handle = runLossless(
      items.map(({ itemId, file }) => ({ itemId, file })),
      {
        onEvent: (event) => {
          if (event.type === "item-progress" || event.type === "item-complete")
            emit(options, event);
        },
      },
    );
    const removeAbortListener = onceCancel(handle, options.signal);
    try {
      return await handle.result;
    } finally {
      removeAbortListener();
    }
  }

  if (options.smartSupported === false) {
    const result = items.map<LocalImageOptimizeResult>((item) => ({
      status: "rejected",
      itemId: item.itemId,
      message: "이 브라우저는 로컬 이미지 처리를 지원하지 않습니다.",
    }));
    for (const item of result) complete(options, item);
    return result;
  }

  const runSmart = options.runSmart ?? runImageBatch;
  const pipelineSpec = smartPipelineSpec(spec);
  const handle = runSmart(
    items.map(({ itemId, file }) => ({ itemId, file, spec: pipelineSpec })),
    {
      concurrency: 1,
      onEvent: (event) => {
        const progress = smartProgress(event);
        if (progress !== undefined) emit(options, progress);
        if (event.type === "item-complete") {
          const source = items.find((item) => item.itemId === event.itemId);
          if (source !== undefined) complete(options, smartResult(event.result, source));
        }
      },
    },
  );
  const removeAbortListener = onceCancel(handle, options.signal);
  try {
    const result = await handle.result;
    return items.map((source) =>
      smartResult(
        result.find((entry) => entry.itemId === source.itemId),
        source,
      ),
    );
  } finally {
    removeAbortListener();
  }
}

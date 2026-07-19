import {
  inspectImageHeader,
  readJpegExifOrientation,
  stripJpegMetadata,
  stripPngMetadata,
} from "@hereisit/image-tool";
import type { ImagePipelineSpecV1 } from "@hereisit/tool-contracts";
import type {
  ImageOptimizeMime,
  ImageOptimizePhase,
  ImageOptimizeSpecV1,
  ImageOptimizeWarningCode,
} from "@hereisit/tool-contracts/image-optimize";

export interface LocalImageOptimizeItem {
  readonly itemId: string;
  readonly file: File;
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

export interface LocalFallbackOptions {
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: ProgressEvent) => void;
  readonly runSmart?: (
    item: LocalImageOptimizeItem,
    spec: ImageOptimizeSpecV1,
    pipelineSpec: ImagePipelineSpecV1,
    options: LocalFallbackOptions,
  ) => Promise<LocalImageOptimizeResult>;
}

function emit(options: LocalFallbackOptions, itemId: string, phase: ProgressEvent["phase"]): void {
  try {
    options.onEvent?.({ type: "item-progress", itemId, phase, fraction: null });
  } catch {
    // UI observers cannot own processing.
  }
}

function cancelled(itemId: string): LocalImageOptimizeResult {
  return { status: "cancelled", itemId };
}

function containsAscii(bytes: Uint8Array, text: string): boolean {
  const needle = new TextEncoder().encode(text);
  outer: for (let offset = 0; offset + needle.length <= bytes.length; offset += 1) {
    for (let index = 0; index < needle.length; index += 1) {
      if (bytes[offset + index] !== needle[index]) continue outer;
    }
    return true;
  }
  return false;
}

function smartPipelineSpec(
  mime: ImageOptimizeMime,
  optimize: ImageOptimizeSpecV1,
): ImagePipelineSpecV1 {
  const common = {
    version: 1 as const,
    resize: { kind: "none" as const },
    sizeGoal: {
      mode: "smaller-only" as const,
      minSavingsPercent: optimize.minimumSavingsPercent,
      minQuality: 35,
      maxAttempts: mime === "image/png" ? 1 : 3,
    },
    autoOrient: true as const,
    metadata: "strip" as const,
  };
  if (mime === "image/png") {
    return { ...common, output: { format: "png", compression: { mode: "lossless" } } };
  }
  if (mime === "image/jpeg") {
    return {
      ...common,
      output: {
        format: "jpeg",
        compression: {
          mode: "quality",
          quality: optimize.preset === "smallest" ? 72 : 82,
        },
        matte: "#ffffff",
      },
    };
  }
  return {
    ...common,
    output: {
      format: "webp",
      compression: {
        mode: "quality",
        quality: optimize.preset === "smallest" ? 72 : 82,
      },
    },
  };
}

async function defaultSmartExecutor(
  item: LocalImageOptimizeItem,
  _spec: ImageOptimizeSpecV1,
  pipelineSpec: ImagePipelineSpecV1,
  options: LocalFallbackOptions,
): Promise<LocalImageOptimizeResult> {
  const { runImageBatch } = await import("@hereisit/browser-runtime/image");
  const handle = runImageBatch([{ itemId: item.itemId, file: item.file, spec: pipelineSpec }], {
    concurrency: 1,
  });
  options.signal?.addEventListener("abort", () => handle.cancel(), { once: true });
  const result = (await handle.result)[0];
  if (result === undefined || result.status === "cancelled") return cancelled(item.itemId);
  if (result.status === "rejected") {
    if (result.error.code === "NO_SIZE_REDUCTION") {
      return {
        status: "original-retained",
        itemId: item.itemId,
        warnings: ["ORIGINAL_RETAINED_UNMODIFIED"],
      };
    }
    return { status: "rejected", itemId: item.itemId, message: result.error.message };
  }
  return {
    status: "fulfilled",
    itemId: item.itemId,
    mime: result.value.mime,
    bytes: result.value.bytes,
    byteLength: result.value.byteLength,
    width: result.value.width,
    height: result.value.height,
    warnings: [],
  };
}

export async function runLocalImageOptimizeFallback(
  item: LocalImageOptimizeItem,
  spec: ImageOptimizeSpecV1,
  options: LocalFallbackOptions = {},
): Promise<LocalImageOptimizeResult> {
  if (options.signal?.aborted) return cancelled(item.itemId);
  emit(options, item.itemId, "inspecting");
  let bytes: ArrayBuffer;
  let inspected: ReturnType<typeof inspectImageHeader>;
  try {
    bytes = await item.file.arrayBuffer();
    inspected = inspectImageHeader(bytes);
  } catch {
    return { status: "rejected", itemId: item.itemId, message: "이미지를 확인할 수 없습니다." };
  }
  if (
    inspected.animated ||
    inspected.width * inspected.height > 40_000_000 ||
    inspected.mime === "image/heic"
  ) {
    return { status: "rejected", itemId: item.itemId, message: "지원하지 않는 이미지입니다." };
  }
  if (options.signal?.aborted) return cancelled(item.itemId);

  if (spec.mode === "lossless") {
    if (
      inspected.mime === "image/webp" ||
      (inspected.mime === "image/jpeg" &&
        (readJpegExifOrientation(bytes) !== 1 ||
          containsAscii(new Uint8Array(bytes), "ICC_PROFILE\0"))) ||
      (inspected.mime === "image/png" && containsAscii(new Uint8Array(bytes), "iCCP"))
    ) {
      return { status: "unsupported", itemId: item.itemId, reason: "LOSSLESS_SERVER_REQUIRED" };
    }
    emit(options, item.itemId, "optimizing");
    const output =
      inspected.mime === "image/jpeg" ? stripJpegMetadata(bytes) : stripPngMetadata(bytes);
    emit(options, item.itemId, "verifying");
    const verified = inspectImageHeader(output);
    emit(options, item.itemId, "completed");
    return {
      status: "fulfilled",
      itemId: item.itemId,
      mime: inspected.mime,
      bytes: output,
      byteLength: output.byteLength,
      width: verified.width,
      height: verified.height,
      warnings: [],
    };
  }

  emit(options, item.itemId, "optimizing");
  const execute = options.runSmart ?? defaultSmartExecutor;
  const result = await execute(item, spec, smartPipelineSpec(inspected.mime, spec), options);
  emit(options, item.itemId, "verifying");
  if (result.status === "fulfilled" && inspected.mime === "image/png") {
    const withWarning = {
      ...result,
      warnings: ["SMART_PNG_FELL_BACK_TO_LOSSLESS" as const],
    };
    emit(options, item.itemId, "completed");
    return withWarning;
  }
  emit(options, item.itemId, "completed");
  return result;
}

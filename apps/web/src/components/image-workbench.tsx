"use client";

import { runImageBatch, supportsBrowserImageRuntime } from "@hereisit/browser-runtime/image";
import type {
  BatchHandle,
  BatchRuntimeEvent,
  ImagePhase,
  ImagePipelineResult,
  ImagePipelineSpecV2,
} from "@hereisit/tool-contracts";
import { findImagePreset, imagePresets } from "@hereisit/tool-registry";
import type { AvailableToolId, FileKind } from "@hereisit/tool-registry/catalog";
import {
  type ChangeEvent,
  type DragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { detectFileSelection, LauncherFileLimitError } from "../lib/file-selection-detection";
import {
  createZipArchive,
  downloadUrl,
  formatBytes,
  formatDuration,
  formatSavings,
  resolveIfCurrent,
} from "../lib/files";
import { reportDownloadRequested, startProductUsageRun } from "../lib/product-analytics";
import { getToolImplementation } from "../lib/tool-implementations";
import { usePendingToolFiles } from "../lib/use-pending-tool-files";
import styles from "./image-workbench.module.css";

const IMAGE_KINDS = new Set<FileKind>([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);
const COMPRESSION_IMAGE_KINDS = new Set<FileKind>(["image/jpeg", "image/png", "image/webp"]);
const HEIC_KINDS = new Set<FileKind>(["image/heic", "image/heif"]);
const HEIC_COMPRESSION_MESSAGE =
  "HEIC는 같은 형식으로 다시 저장할 수 없어 용량 줄이기에서 지원하지 않아요. 이미지 형식 변환 도구를 이용해 주세요.";
export type ImageWorkbenchIntent = "general" | "compress" | "resize" | "convert";

const INTENT_PRESET_IDS: Record<ImageWorkbenchIntent, readonly string[] | null> = {
  general: null,
  compress: ["balanced"],
  resize: ["web-1920", "product-square", "social-square"],
  convert: ["convert-webp"],
};

const INTENT_CONFIG: Record<
  ImageWorkbenchIntent,
  {
    defaultPresetId: string;
    emptyTitle: string;
    selectLabel: string;
    runLabel: string;
    workbenchTitle: string;
  }
> = {
  general: {
    defaultPresetId: "web-1920",
    emptyTitle: "이미지를 놓거나 선택하세요",
    selectLabel: "이미지 선택",
    runLabel: "이미지 변환",
    workbenchTitle: "이미지 작업대",
  },
  compress: {
    defaultPresetId: "balanced",
    emptyTitle: "압축할 이미지를 놓거나 선택하세요",
    selectLabel: "압축할 이미지 선택",
    runLabel: "이미지 용량 줄이기",
    workbenchTitle: "이미지 압축 작업대",
  },
  resize: {
    defaultPresetId: "web-1920",
    emptyTitle: "크기를 바꿀 이미지를 놓거나 선택하세요",
    selectLabel: "크기를 바꿀 이미지 선택",
    runLabel: "이미지 크기 조절",
    workbenchTitle: "크기 조절 작업대",
  },
  convert: {
    defaultPresetId: "convert-webp",
    emptyTitle: "변환할 이미지를 놓거나 선택하세요",
    selectLabel: "변환할 이미지 선택",
    runLabel: "이미지 형식 변환",
    workbenchTitle: "형식 변환 작업대",
  },
};

type ItemStatus =
  | "ready"
  | "queued"
  | "processing"
  | "completed"
  | "unchanged"
  | "failed"
  | "cancelled";

interface WorkItem {
  id: string;
  file: File;
  detectedKind: FileKind;
  previewUrl: string;
  resultUrl?: string;
  result?: ImagePipelineResult;
  status: ItemStatus;
  progress: number;
  phase?: ImagePhase;
  error?: string | undefined;
}

function cloneSpec(spec: ImagePipelineSpecV2): ImagePipelineSpecV2 {
  return structuredClone(spec);
}

function resolveInitialPreset(intent: ImageWorkbenchIntent): {
  presetId: string;
  spec: ImagePipelineSpecV2;
} {
  const preset = findImagePreset(INTENT_CONFIG[intent].defaultPresetId);
  return { presetId: preset.id, spec: cloneSpec(preset.spec) };
}

function makeId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function phaseLabel(phase: ImagePhase | undefined, intent: ImageWorkbenchIntent): string {
  if (phase === "validating") return "확인 중";
  if (phase === "decoding") return "읽는 중";
  if (phase === "transforming") return intent === "resize" ? "크기 조절 중" : "이미지 준비 중";
  if (phase === "encoding") return "압축 중";
  if (phase === "finalizing") return "마무리 중";
  return "대기 중";
}

const DEFAULT_LOSSY_QUALITY = 82;
const SMALLER_ONLY_GOAL = {
  mode: "smaller-only",
  minSavingsPercent: 1,
  minQuality: 35,
  maxAttempts: 6,
} as const;

function isSmallerOnly(spec: ImagePipelineSpecV2): boolean {
  return spec.sizeGoal?.mode === "smaller-only";
}

function currentQuality(spec: ImagePipelineSpecV2): number {
  if (spec.output.format === "png") return DEFAULT_LOSSY_QUALITY;
  if (spec.output.compression.mode === "maxBytes") {
    return spec.output.compression.maxQuality ?? 92;
  }
  return spec.output.compression.quality;
}

function withOutputFormat(
  spec: ImagePipelineSpecV2,
  format: "jpeg" | "png" | "webp",
): ImagePipelineSpecV2 {
  const quality = Math.min(95, currentQuality(spec));
  if (format === "png") {
    return { ...spec, output: { format: "png", compression: { mode: "lossless" } } };
  }
  if (format === "jpeg") {
    return {
      ...spec,
      output: {
        format: "jpeg",
        compression: { mode: "quality", quality },
        matte: "#ffffff",
      },
    };
  }
  return {
    ...spec,
    output: { format: "webp", compression: { mode: "quality", quality } },
  };
}

function resultBlob(result: ImagePipelineResult): Blob {
  return new Blob([result.bytes], { type: result.mime });
}

function resetWorkItem(item: WorkItem, status: ItemStatus = "ready", error?: string): WorkItem {
  const reset: WorkItem = {
    id: item.id,
    file: item.file,
    detectedKind: item.detectedKind,
    previewUrl: item.previewUrl,
    status,
    progress: 0,
  };
  if (error !== undefined) reset.error = error;
  return reset;
}

function isAcceptedKind(
  detectedKind: FileKind | null,
  intent: ImageWorkbenchIntent,
): detectedKind is FileKind {
  if (detectedKind === null) return false;
  return intent === "compress"
    ? COMPRESSION_IMAGE_KINDS.has(detectedKind)
    : IMAGE_KINDS.has(detectedKind);
}

function getValidatedImageImplementation(
  toolId: AvailableToolId,
  intent: Exclude<ImageWorkbenchIntent, "general">,
) {
  const implementation = getToolImplementation(toolId);
  if (
    implementation.bundleProfile !== "image" ||
    implementation.family !== "image" ||
    implementation.intent !== intent
  ) {
    throw new Error(`ImageWorkbench tool mismatch: ${toolId}/${intent}`);
  }
  return implementation;
}

export function ImageWorkbench({
  intent,
  toolId,
}: {
  intent: Exclude<ImageWorkbenchIntent, "general">;
  toolId: AvailableToolId;
}) {
  const implementation = getValidatedImageImplementation(toolId, intent);
  const { minFiles, maxFiles, maxFileBytes, maxTotalBytes } = implementation.sourceFileLimits;
  const intentCopy = INTENT_CONFIG[intent];
  const isCompressionIntent = intent === "compress";
  const [initialPreset] = useState(() => resolveInitialPreset(intent));
  const [items, setItems] = useState<WorkItem[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [presetId, setPresetId] = useState(initialPreset.presetId);
  const [spec, setSpec] = useState<ImagePipelineSpecV2>(initialPreset.spec);
  const [dragging, setDragging] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [detectionProgress, setDetectionProgress] = useState<{
    completed: number;
    total: number;
  } | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [message, setMessage] = useState("이미지를 선택하면 바로 준비할게요.");
  const [runtimeSupported, setRuntimeSupported] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const batchRef = useRef<BatchHandle | undefined>(undefined);
  const activeRunRef = useRef(0);
  const detectionGenerationRef = useRef(0);
  const itemsRef = useRef(items);
  const objectUrlsRef = useRef(new Set<string>());
  const archiveLeasesRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const productRunRef = useRef<ReturnType<typeof startProductUsageRun> | null>(null);
  const detecting = detectionProgress !== null;
  const busy = processing || archiving || detecting;

  const commitItems = useCallback((update: (current: WorkItem[]) => WorkItem[]) => {
    const next = update(itemsRef.current);
    itemsRef.current = next;
    setItems(next);
  }, []);

  const createOwnedUrl = useCallback((blob: Blob): string => {
    const url = URL.createObjectURL(blob);
    objectUrlsRef.current.add(url);
    return url;
  }, []);

  const revokeOwnedUrl = useCallback((url: string | undefined) => {
    if (url === undefined || !objectUrlsRef.current.delete(url)) return;
    URL.revokeObjectURL(url);
  }, []);

  const releaseArchiveLeases = useCallback(() => {
    for (const [url, timeoutId] of archiveLeasesRef.current) {
      clearTimeout(timeoutId);
      revokeOwnedUrl(url);
    }
    archiveLeasesRef.current.clear();
  }, [revokeOwnedUrl]);

  useEffect(() => {
    setHydrated(true);
    setRuntimeSupported(supportsBrowserImageRuntime());
  }, []);

  useEffect(() => {
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (itemsRef.current.length === 0) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, []);

  useEffect(
    () => () => {
      activeRunRef.current += 1;
      detectionGenerationRef.current += 1;
      batchRef.current?.cancel();
      productRunRef.current?.cancelled();
      for (const timeoutId of archiveLeasesRef.current.values()) clearTimeout(timeoutId);
      archiveLeasesRef.current.clear();
      for (const url of objectUrlsRef.current) URL.revokeObjectURL(url);
      objectUrlsRef.current.clear();
    },
    [],
  );

  const addFiles = useCallback(
    async (fileList: FileList | readonly File[]) => {
      const candidates = Array.from(fileList);
      const generation = detectionGenerationRef.current + 1;
      detectionGenerationRef.current = generation;

      if (candidates.length === 0) {
        setDetectionProgress(null);
        return;
      }

      setDragging(false);
      setDetectionProgress({ completed: 0, total: candidates.length });
      setMessage(`0/${candidates.length}개 이미지 형식을 확인하고 있어요.`);

      try {
        const detected = await detectFileSelection(candidates, {
          isCurrent: () => detectionGenerationRef.current === generation,
          onProgress: ({ completed, total }) => {
            if (detectionGenerationRef.current !== generation) return;
            setDetectionProgress({ completed, total });
            setMessage(`${completed}/${total}개 이미지 형식을 확인하고 있어요.`);
          },
        });
        if (detected === null || detectionGenerationRef.current !== generation) return;

        const currentBytes = itemsRef.current.reduce((total, item) => total + item.file.size, 0);
        let remainingBytes = Math.max(0, maxTotalBytes - currentBytes);
        const available = Math.max(0, maxFiles - itemsRef.current.length);
        const accepted: Array<{ file: File; detectedKind: FileKind }> = [];
        const rejectedHeicCount =
          intent === "compress"
            ? detected.filter(
                ({ detectedKind }) => detectedKind !== null && HEIC_KINDS.has(detectedKind),
              ).length
            : 0;

        for (const { file, detectedKind } of detected) {
          if (
            accepted.length >= available ||
            !isAcceptedKind(detectedKind, intent) ||
            file.size < 1 ||
            file.size > maxFileBytes ||
            file.size > remainingBytes
          ) {
            continue;
          }
          accepted.push({ file, detectedKind });
          remainingBytes -= file.size;
        }

        const additions = accepted.map<WorkItem>(({ file, detectedKind }) => ({
          id: makeId(),
          file,
          detectedKind,
          previewUrl: createOwnedUrl(file),
          status: "ready",
          progress: 0,
        }));

        if (additions.length > 0) {
          commitItems((current) => [...current, ...additions]);
          setSelectedId((current) => current ?? additions[0]?.id);
          setMessage(`${additions.length}개 이미지를 준비했어요.`);
        }

        const rejected = detected.length - additions.length;
        if (rejectedHeicCount > 0) {
          const otherRejected = Math.max(0, rejected - rejectedHeicCount);
          setMessage(
            additions.length === 0 && otherRejected === 0
              ? HEIC_COMPRESSION_MESSAGE
              : [
                  `${additions.length}개를 추가했어요.`,
                  HEIC_COMPRESSION_MESSAGE,
                  otherRejected > 0
                    ? `그 밖의 ${otherRejected}개는 형식·용량·개수 제한으로 제외했어요.`
                    : undefined,
                ]
                  .filter((part): part is string => part !== undefined)
                  .join(" "),
          );
          return;
        }

        if (rejected > 0) {
          setMessage(
            `${additions.length}개를 추가했어요. ${rejected}개는 형식·파일당 50MB·총 250MB·개수 제한으로 제외했어요.`,
          );
        }
      } catch (error) {
        if (detectionGenerationRef.current === generation) {
          setMessage(
            error instanceof LauncherFileLimitError
              ? `파일은 한 번에 최대 ${error.maximum}개까지 선택할 수 있어요. 파일을 나눠 주세요.`
              : "파일 형식을 확인하지 못했어요. 다시 선택해 주세요.",
          );
        }
      } finally {
        if (detectionGenerationRef.current === generation) setDetectionProgress(null);
      }
    },
    [commitItems, createOwnedUrl, intent, maxFileBytes, maxFiles, maxTotalBytes],
  );

  usePendingToolFiles({
    toolId,
    ready: hydrated && runtimeSupported && !busy,
    acceptFiles: addFiles,
    onReselectRequired: setMessage,
  });

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target;
      if (
        busy ||
        event.clipboardData?.files.length === 0 ||
        (target instanceof HTMLElement &&
          (target.matches("input, textarea, [contenteditable=true]") ||
            target.closest("[contenteditable=true]") !== null))
      ) {
        return;
      }
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length > 0) void addFiles(files);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [addFiles, busy]);

  const selected = useMemo(
    () => items.find((item) => item.id === selectedId) ?? items[0],
    [items, selectedId],
  );
  const totalInputBytes = useMemo(
    () => items.reduce((total, item) => total + item.file.size, 0),
    [items],
  );
  const completedItems = useMemo(
    () => items.filter((item) => item.status === "completed" && item.result !== undefined),
    [items],
  );
  const completedInputBytes = useMemo(
    () => completedItems.reduce((total, item) => total + item.file.size, 0),
    [completedItems],
  );
  const totalOutputBytes = useMemo(
    () => completedItems.reduce((total, item) => total + (item.result?.byteLength ?? 0), 0),
    [completedItems],
  );
  const visiblePresets = useMemo(() => {
    const presetIds = INTENT_PRESET_IDS[intent];
    return presetIds === null
      ? imagePresets
      : imagePresets.filter((preset) => presetIds.includes(preset.id));
  }, [intent]);
  const pngItemCount = useMemo(
    () => items.filter((item) => item.detectedKind === "image/png").length,
    [items],
  );
  const hasLossyCompressionInput = useMemo(
    () =>
      items.some(
        (item) => item.detectedKind === "image/jpeg" || item.detectedKind === "image/webp",
      ),
    [items],
  );

  const invalidateResults = () => {
    releaseArchiveLeases();
    activeRunRef.current += 1;
    const hasResultOrError = itemsRef.current.some(
      (item) => item.resultUrl !== undefined || item.status !== "ready",
    );
    if (!hasResultOrError) return;
    for (const item of itemsRef.current) revokeOwnedUrl(item.resultUrl);
    commitItems((current) => current.map((item) => resetWorkItem(item)));
    setMessage(
      isCompressionIntent
        ? "설정이 바뀌었어요. 새 설정으로 다시 압축해 주세요."
        : "설정이 바뀌었어요. 새 설정으로 다시 변환해 주세요.",
    );
  };

  const choosePreset = (id: string) => {
    invalidateResults();
    setPresetId(id);
    setSpec(cloneSpec(findImagePreset(id).spec));
  };

  const changeFormat = (event: ChangeEvent<HTMLSelectElement>) => {
    const format = event.target.value as "jpeg" | "png" | "webp";
    invalidateResults();
    setPresetId("custom");
    setSpec((current) => withOutputFormat(current, format));
    setMessage(
      format === "png"
        ? "PNG 무손실은 사진에서 용량이 커질 수 있어요."
        : "출력 형식을 바꿨어요. 새 설정으로 변환해 주세요.",
    );
  };

  const changeQuality = (event: ChangeEvent<HTMLInputElement>) => {
    const quality = Number(event.target.value);
    invalidateResults();
    setPresetId("custom");
    setSpec((current) => {
      if (current.output.format === "png") return current;
      return {
        ...current,
        output: { ...current.output, compression: { mode: "quality", quality } },
      };
    });
  };

  const changeSizeGoal = (event: ChangeEvent<HTMLInputElement>) => {
    const enabled = event.target.checked;
    invalidateResults();
    setPresetId("custom");
    setSpec((current) => ({
      ...current,
      sizeGoal: enabled ? { ...SMALLER_ONLY_GOAL } : { mode: "allow-growth" },
    }));
    setMessage(
      enabled
        ? "원본보다 작아질 때만 결과를 만들어요."
        : "용량 증가를 허용했어요. 선택한 변환을 그대로 적용합니다.",
    );
  };

  const changeResizeMode = (mode: "none" | "inside" | "cover") => {
    invalidateResults();
    setPresetId("custom");
    setSpec((current) => ({
      ...current,
      resize:
        mode === "none"
          ? { kind: "none" }
          : mode === "inside"
            ? { kind: "inside", maxWidth: 1920, maxHeight: 1920 }
            : { kind: "cover", width: 1000, height: 1000 },
    }));
  };

  const changeSize = (value: number) => {
    const size = Math.max(64, Math.min(16_384, Math.round(value || 64)));
    invalidateResults();
    setPresetId("custom");
    setSpec((current) => {
      if (current.resize.kind === "inside") {
        return { ...current, resize: { kind: "inside", maxWidth: size, maxHeight: size } };
      }
      if (current.resize.kind === "cover") {
        return { ...current, resize: { ...current.resize, width: size, height: size } };
      }
      return current;
    });
  };

  const removeItem = (id: string) => {
    if (busy) return;
    const target = itemsRef.current.find((item) => item.id === id);
    if (target === undefined) return;
    releaseArchiveLeases();
    activeRunRef.current += 1;
    revokeOwnedUrl(target.previewUrl);
    revokeOwnedUrl(target.resultUrl);
    const next = itemsRef.current.filter((item) => item.id !== id);
    itemsRef.current = next;
    setItems(next);
    setSelectedId((selectedItem) => (selectedItem === id ? next[0]?.id : selectedItem));
  };

  const reset = () => {
    releaseArchiveLeases();
    activeRunRef.current += 1;
    detectionGenerationRef.current += 1;
    batchRef.current?.cancel();
    productRunRef.current?.cancelled();
    batchRef.current = undefined;
    for (const item of itemsRef.current) {
      revokeOwnedUrl(item.previewUrl);
      revokeOwnedUrl(item.resultUrl);
    }
    itemsRef.current = [];
    setItems([]);
    setSelectedId(undefined);
    setProcessing(false);
    setArchiving(false);
    setDetectionProgress(null);
    setMessage("이미지를 선택하면 바로 준비할게요.");
  };

  const applyRuntimeEvent = (event: BatchRuntimeEvent) => {
    if (event.type === "item-progress") {
      commitItems((current) =>
        current.map((item) =>
          item.id === event.itemId
            ? {
                ...item,
                status: "processing",
                progress: event.fraction,
                phase: event.phase,
              }
            : item,
        ),
      );
      return;
    }

    if (event.type !== "item-complete") return;
    const previous = itemsRef.current.find((item) => item.id === event.itemId);
    revokeOwnedUrl(previous?.resultUrl);

    if (event.result.status === "fulfilled") {
      const result = event.result.value;
      const resultUrl = createOwnedUrl(resultBlob(result));
      commitItems((current) =>
        current.map((item) =>
          item.id === event.itemId
            ? {
                ...resetWorkItem(item, "completed"),
                progress: 1,
                result,
                resultUrl,
              }
            : item,
        ),
      );
      return;
    }

    const noSizeReduction =
      event.result.status === "rejected" && event.result.error.code === "NO_SIZE_REDUCTION";
    const error =
      event.result.status === "cancelled" ? "작업을 중단했어요." : event.result.error.message;
    const status: ItemStatus =
      event.result.status === "cancelled" ? "cancelled" : noSizeReduction ? "unchanged" : "failed";
    commitItems((current) =>
      current.map((item) => (item.id === event.itemId ? resetWorkItem(item, status, error) : item)),
    );
  };

  const startProcessing = async () => {
    if (itemsRef.current.length < minFiles || busy || !runtimeSupported) return;
    const productRun = startProductUsageRun(toolId);
    productRunRef.current = productRun;
    releaseArchiveLeases();
    const sourceItems = itemsRef.current;
    const runId = activeRunRef.current + 1;
    activeRunRef.current = runId;
    for (const item of sourceItems) {
      revokeOwnedUrl(item.previewUrl);
      revokeOwnedUrl(item.resultUrl);
    }
    const queuedItems = sourceItems.map((item) => ({
      ...resetWorkItem(item, "queued"),
      previewUrl: createOwnedUrl(item.file),
    }));
    itemsRef.current = queuedItems;
    setItems(queuedItems);
    setProcessing(true);
    setMessage(
      isCompressionIntent
        ? `${sourceItems.length}개 이미지를 압축하고 있어요.`
        : `${sourceItems.length}개 이미지를 변환하고 있어요.`,
    );

    let handle: BatchHandle | undefined;
    try {
      handle = runImageBatch(
        sourceItems.map((item) => ({ itemId: item.id, file: item.file, spec: cloneSpec(spec) })),
        {
          concurrency: "auto",
          onEvent: (event) => {
            if (activeRunRef.current === runId) applyRuntimeEvent(event);
          },
        },
      );
      batchRef.current = handle;
      const results = await handle.result;
      if (activeRunRef.current !== runId) return;

      if (results.some((result) => result.status === "fulfilled")) productRun.succeeded();
      else if (results.some((result) => result.status === "cancelled")) productRun.cancelled();
      else productRun.failed(results.find((result) => result.status === "rejected")?.error.code);

      const successes = results.filter((result) => result.status === "fulfilled").length;
      const unchanged = results.filter(
        (result) => result.status === "rejected" && result.error.code === "NO_SIZE_REDUCTION",
      ).length;
      const failures = results.filter(
        (result) => result.status === "rejected" && result.error.code !== "NO_SIZE_REDUCTION",
      ).length;
      if (successes === results.length) {
        setMessage(
          String(successes).concat(
            isCompressionIntent ? "개 이미지 압축을 완료했어요." : "개 이미지 변환을 완료했어요.",
          ),
        );
      } else if (unchanged === results.length) {
        setMessage("이미 충분히 작아 더 줄이지 못했어요.");
      } else if (successes > 0) {
        const summary = [
          String(successes).concat("개 완료"),
          unchanged > 0 ? String(unchanged).concat("개는 이미 최적화") : undefined,
          failures > 0 ? String(failures).concat("개 처리 실패") : undefined,
        ]
          .filter((part): part is string => part !== undefined)
          .join(", ");
        setMessage(summary.concat("."));
      } else if (results.some((result) => result.status === "cancelled")) {
        setMessage("작업을 중단했어요.");
      } else if (unchanged > 0) {
        setMessage(
          [
            String(unchanged).concat("개는 이미 최적화"),
            String(failures).concat("개는 처리하지 못했어요."),
          ].join(", "),
        );
      } else {
        setMessage("이미지를 처리하지 못했어요. 파일을 확인해 주세요.");
      }
    } catch {
      if (activeRunRef.current !== runId) return;
      productRun.failed("WORKER_CRASH");
      commitItems((current) =>
        current.map((item) =>
          item.status === "completed"
            ? item
            : resetWorkItem(item, "failed", "브라우저 작업기를 시작하지 못했습니다."),
        ),
      );
      setMessage("이미지 작업을 시작하지 못했습니다. 브라우저 설정을 확인해 주세요.");
    } finally {
      if (activeRunRef.current === runId) {
        if (batchRef.current === handle) batchRef.current = undefined;
        if (productRunRef.current === productRun) productRunRef.current = null;
        setProcessing(false);
      }
    }
  };

  const cancelProcessing = () => {
    productRunRef.current?.cancelled();
    activeRunRef.current += 1;
    batchRef.current?.cancel();
    batchRef.current = undefined;
    setProcessing(false);
    commitItems((current) =>
      current.map((item) =>
        item.status === "completed" ? item : resetWorkItem(item, "cancelled", "작업을 중단했어요."),
      ),
    );
    const preserved = itemsRef.current.filter((item) => item.status === "completed").length;
    setMessage(
      preserved > 0
        ? `작업을 중단했어요. 완료된 결과 ${preserved}개는 받을 수 있어요.`
        : "작업을 중단했어요.",
    );
  };

  const downloadItem = (item: WorkItem) => {
    const current = itemsRef.current.find((candidate) => candidate.id === item.id);
    if (
      item.resultUrl === undefined ||
      item.result === undefined ||
      current?.resultUrl !== item.resultUrl ||
      current.result !== item.result
    ) {
      return;
    }
    try {
      reportDownloadRequested(toolId);
      downloadUrl(item.resultUrl, item.result.suggestedName);
      setMessage("다운로드를 시작했어요.");
    } catch {
      setMessage("다운로드를 시작하지 못했어요. 다시 시도해 주세요.");
    }
  };

  const downloadAll = async () => {
    if (completedItems.length === 0 || archiving) return;
    const runId = activeRunRef.current;
    setArchiving(true);
    setMessage("ZIP 파일을 만들고 있어요.");
    try {
      let archive: Blob | undefined;
      try {
        archive = await resolveIfCurrent(
          createZipArchive(
            completedItems.flatMap((item) =>
              item.result === undefined
                ? []
                : [{ name: item.result.suggestedName, bytes: item.result.bytes }],
            ),
          ),
          runId,
          () => activeRunRef.current,
        );
      } catch {
        if (activeRunRef.current === runId) {
          setMessage("ZIP 파일을 만들지 못했어요. 개별 파일을 다운로드해 주세요.");
        }
        return;
      }
      if (archive === undefined) return;
      let url: string | undefined;
      try {
        const createdUrl = createOwnedUrl(archive);
        url = createdUrl;
        reportDownloadRequested(toolId);
        downloadUrl(createdUrl, "hereisit-images.zip");
        const timeoutId = setTimeout(() => {
          if (!archiveLeasesRef.current.delete(createdUrl)) return;
          revokeOwnedUrl(createdUrl);
        }, 10_000);
        archiveLeasesRef.current.set(createdUrl, timeoutId);
        setMessage("ZIP 다운로드를 시작했어요.");
      } catch {
        revokeOwnedUrl(url);
        if (activeRunRef.current === runId) {
          setMessage("다운로드를 시작하지 못했어요. 다시 시도해 주세요.");
        }
      }
    } finally {
      if (activeRunRef.current === runId) setArchiving(false);
    }
  };

  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragging(false);
    if (!busy) void addFiles(event.dataTransfer.files);
  };

  return (
    <section className={styles.shell} aria-labelledby="workbench-title">
      <p className={styles.liveStatus} role="status" aria-live="polite" aria-atomic="true">
        {!hydrated
          ? "도구를 준비하고 있어요…"
          : runtimeSupported
            ? message
            : "최신 Safari, Chrome, Firefox 또는 Edge에서 사용할 수 있어요."}
      </p>
      <input
        ref={inputRef}
        className={styles.hiddenInput}
        type="file"
        accept={
          intent === "compress"
            ? "image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
            : "image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif"
        }
        multiple
        tabIndex={-1}
        disabled={!hydrated || busy || !runtimeSupported}
        onChange={(event) => {
          if (event.target.files !== null) void addFiles(event.target.files);
          event.target.value = "";
        }}
      />

      {items.length === 0 ? (
        <section
          className={`${styles.emptyDropzone} ${dragging ? styles.dragging : ""}`}
          aria-labelledby="workbench-title"
          onDragEnter={(event) => {
            event.preventDefault();
            if (!busy) setDragging(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false);
          }}
          onDrop={onDrop}
        >
          <div className={styles.dropIcon} aria-hidden="true">
            <span>＋</span>
          </div>
          <div>
            <p className={styles.dropEyebrow}>DROP YOUR IMAGES</p>
            <h2 id="workbench-title">{intentCopy.emptyTitle}</h2>
            <p>
              {intent === "compress" ? "JPG, PNG, WebP" : "JPG, PNG, WebP · HEIC(Safari 17+)"}
              {" · 파일당 50MB · 총 250MB · 최대 100개"}
            </p>
          </div>
          <div className={styles.dropActions}>
            <button
              className={styles.primaryButton}
              type="button"
              disabled={!hydrated || busy || !runtimeSupported}
              onClick={() => inputRef.current?.click()}
            >
              {intentCopy.selectLabel}
            </button>
            <span className={styles.pasteHint}>⌘V 또는 Ctrl+V로 붙여넣기</span>
            <p className={styles.emptyStatus} data-testid="image-workbench-status">
              {!hydrated
                ? "도구를 준비하고 있어요…"
                : runtimeSupported
                  ? message
                  : "최신 Safari, Chrome, Firefox 또는 Edge에서 사용할 수 있어요."}
            </p>
          </div>
          <div className={styles.localBadge}>
            <span aria-hidden="true">✓</span> 업로드 없음 · 내 기기에서 처리
          </div>
        </section>
      ) : (
        <div className={styles.workbench}>
          <div className={styles.workbenchHeader}>
            <div>
              <p className={styles.dropEyebrow}>LOCAL IMAGE WORKBENCH</p>
              <h2 id="workbench-title">{intentCopy.workbenchTitle}</h2>
            </div>
            <div className={styles.headerActions}>
              <button type="button" onClick={() => inputRef.current?.click()} disabled={busy}>
                ＋ 추가
              </button>
              <button type="button" onClick={reset} disabled={busy}>
                처음부터
              </button>
            </div>
          </div>

          {hydrated && !runtimeSupported && (
            <div className={styles.runtimeWarning} role="alert">
              현재 브라우저는 로컬 이미지 Worker를 완전히 지원하지 않습니다. 최신 Safari, Chrome,
              Firefox 또는 Edge를 사용해 주세요.
            </div>
          )}

          <div className={styles.workspaceGrid}>
            <aside className={styles.filePanel} aria-label="선택한 이미지">
              <div className={styles.panelTitle}>
                <strong>파일</strong>
                <span>{items.length}</span>
              </div>
              <div className={styles.fileList}>
                {items.map((item) => (
                  <div
                    className={`${styles.fileRow} ${item.id === selected?.id ? styles.selectedFile : ""}`}
                    key={item.id}
                  >
                    <button
                      className={styles.fileSelect}
                      type="button"
                      aria-pressed={item.id === selected?.id}
                      onClick={() => setSelectedId(item.id)}
                    >
                      {processing ? (
                        <span className={styles.filePlaceholder} aria-hidden="true">
                          IMG
                        </span>
                      ) : (
                        /* biome-ignore lint/performance/noImgElement: local object URLs are local previews */
                        <img src={item.previewUrl} alt="" loading="lazy" decoding="async" />
                      )}
                      <span className={styles.fileCopy}>
                        <strong>{item.file.name}</strong>
                        <small>
                          {item.status === "processing"
                            ? `${phaseLabel(item.phase, intent)} ${Math.round(item.progress * 100)}%`
                            : item.status === "completed" && item.result !== undefined
                              ? `${formatBytes(item.file.size)} → ${formatBytes(item.result.byteLength)} · ${formatSavings(item.file.size, item.result.byteLength)} · ${formatDuration(item.result.timing.totalMs)}`
                              : item.status === "unchanged"
                                ? "이미 최적화됨"
                                : item.status === "failed"
                                  ? "처리 실패"
                                  : formatBytes(item.file.size)}
                        </small>
                      </span>
                    </button>
                    {!busy && (
                      <button
                        className={styles.removeButton}
                        type="button"
                        aria-label={`${item.file.name} 제거`}
                        onClick={() => removeItem(item.id)}
                      >
                        ×
                      </button>
                    )}
                    {item.status === "processing" && (
                      <span
                        className={styles.rowProgress}
                        role="progressbar"
                        aria-label={`${item.file.name} ${isCompressionIntent ? "압축" : "변환"} 진행률`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(item.progress * 100)}
                        style={{ width: `${item.progress * 100}%` }}
                      />
                    )}
                  </div>
                ))}
              </div>
            </aside>

            <aside
              className={styles.settingsPanel}
              aria-label={isCompressionIntent ? "압축 설정" : "변환 설정"}
            >
              <div className={styles.panelTitle}>
                <strong>설정</strong>
                <span>{presetId === "custom" ? "직접 설정" : "모두 적용"}</span>
              </div>

              <fieldset className={styles.settingsGroup} disabled={busy}>
                <legend>빠른 프리셋</legend>
                <div className={styles.presetList}>
                  {visiblePresets.map((preset) => (
                    <button
                      className={presetId === preset.id ? styles.activePreset : ""}
                      type="button"
                      key={preset.id}
                      aria-pressed={presetId === preset.id}
                      onClick={() => choosePreset(preset.id)}
                    >
                      <span>
                        <strong>{preset.name}</strong>
                        <small>{preset.description}</small>
                      </span>
                      <em>{preset.badge}</em>
                    </button>
                  ))}
                </div>
              </fieldset>

              {intent !== "compress" && (
                <fieldset className={styles.settingsGroup} disabled={busy}>
                  <legend>크기</legend>
                  <div className={styles.segmented}>
                    {[
                      ["none", "유지"],
                      ["inside", "최대 크기"],
                      ["cover", "정사각 자르기"],
                    ].map(([value, label]) => (
                      <button
                        className={spec.resize.kind === value ? styles.activeSegment : ""}
                        type="button"
                        key={value}
                        aria-pressed={spec.resize.kind === value}
                        onClick={() => changeResizeMode(value as "none" | "inside" | "cover")}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {spec.resize.kind !== "none" && spec.resize.kind !== "stretch" && (
                    <label className={styles.numberField}>
                      <span>{spec.resize.kind === "cover" ? "정사각형 한 변" : "긴 변 최대"}</span>
                      <span>
                        <input
                          type="number"
                          min="64"
                          max="16384"
                          step="10"
                          value={
                            spec.resize.kind === "cover"
                              ? spec.resize.width
                              : (spec.resize.maxWidth ?? spec.resize.maxHeight ?? 1920)
                          }
                          onChange={(event) => changeSize(Number(event.target.value))}
                        />
                        px
                      </span>
                    </label>
                  )}
                </fieldset>
              )}

              <fieldset className={styles.settingsGroup} disabled={busy}>
                <legend>형식과 품질</legend>
                <label className={styles.selectField}>
                  <span>출력 형식</span>
                  <select
                    value={intent === "compress" ? "source" : spec.output.format}
                    disabled={intent === "compress"}
                    onChange={changeFormat}
                  >
                    {intent === "compress" ? (
                      <option value="source">원본 형식 유지</option>
                    ) : (
                      <>
                        {spec.output.format === "source" && (
                          <option value="source">원본 형식 유지</option>
                        )}
                        <option value="webp">WebP · 작은 용량</option>
                        <option value="jpeg">JPG · 넓은 호환성</option>
                        <option value="png">PNG · 무손실</option>
                      </>
                    )}
                  </select>
                </label>
                {spec.output.format !== "png" && (
                  <label className={styles.qualityField}>
                    <span>
                      <span>{intent === "compress" ? "JPG/WebP 품질" : "품질"}</span>
                      <strong>{currentQuality(spec)}</strong>
                    </span>
                    <input
                      aria-label={intent === "compress" ? "JPG/WebP 품질" : undefined}
                      disabled={intent === "compress" && !hasLossyCompressionInput}
                      type="range"
                      min="35"
                      max="95"
                      step="1"
                      value={currentQuality(spec)}
                      onChange={changeQuality}
                    />
                  </label>
                )}
                {spec.output.format === "png" && (
                  <p className={styles.formatWarning}>
                    <strong>PNG 무손실은 용량이 커질 수 있어요.</strong>
                    <span>
                      {isSmallerOnly(spec)
                        ? "더 작아지지 않으면 결과를 만들지 않아요."
                        : "용량이 목적이면 WebP를 선택하세요."}
                    </span>
                  </p>
                )}
                {intent === "compress" && pngItemCount > 0 && (
                  <p className={styles.formatWarning}>
                    <strong>
                      {items.length === 1
                        ? "PNG는 무손실로 다시 저장해요."
                        : `PNG ${pngItemCount}개는 무손실로 다시 저장해요.`}
                    </strong>
                    <span>더 작아지지 않으면 결과를 만들지 않아요.</span>
                  </p>
                )}
                <label className={styles.sizeGoalField}>
                  <input
                    type="checkbox"
                    checked={intent === "compress" || isSmallerOnly(spec)}
                    disabled={intent === "compress"}
                    onChange={changeSizeGoal}
                  />
                  <span>
                    <strong>원본보다 작을 때만 완료</strong>
                    <small>더 커지는 결과는 만들지 않아요.</small>
                  </span>
                </label>
              </fieldset>

              <div className={styles.privacyNotice}>
                <span aria-hidden="true">✓</span>
                <p className={styles.privacyCopy}>
                  <strong>메타데이터 자동 제거</strong>
                  위치와 촬영 정보는 결과에 포함하지 않아요.
                </p>
              </div>
            </aside>
            <section className={styles.previewPanel} aria-label="이미지 미리보기">
              {selected !== undefined && (
                <>
                  <div className={styles.previewTopline}>
                    <span>
                      {processing
                        ? "메모리 절약 모드"
                        : selected.resultUrl === undefined
                          ? "원본 미리보기"
                          : isCompressionIntent
                            ? "압축 전 · 후"
                            : "변환 전 · 후"}
                    </span>
                    {selected.result !== undefined && (
                      <span>
                        {selected.result.width}×{selected.result.height}
                      </span>
                    )}
                  </div>
                  <div
                    className={`${styles.previewStage} ${!processing && selected.resultUrl ? styles.withResult : ""}`}
                  >
                    {processing ? (
                      <div className={styles.previewMemoryNotice} role="status">
                        <strong>메모리를 아끼고 있어요</strong>
                        <span>
                          {isCompressionIntent ? "압축" : "변환"} 중에는 고해상도 원본 미리보기를
                          잠시 숨겨요.
                        </span>
                      </div>
                    ) : (
                      <>
                        <figure>
                          {/* biome-ignore lint/performance/noImgElement: local object URL preview */}
                          <img
                            src={selected.previewUrl}
                            alt={`${selected.file.name} 원본`}
                            decoding="async"
                          />
                          <figcaption>원본 · {formatBytes(selected.file.size)}</figcaption>
                        </figure>
                        {selected.resultUrl !== undefined && selected.result !== undefined && (
                          <figure>
                            {/* biome-ignore lint/performance/noImgElement: local generated result */}
                            <img
                              src={selected.resultUrl}
                              alt={`${selected.file.name} ${isCompressionIntent ? "압축" : "변환"} 결과`}
                              decoding="async"
                            />
                            <figcaption>
                              결과 · {formatBytes(selected.result.byteLength)} ·{` `}
                              {formatSavings(selected.file.size, selected.result.byteLength)} ·{` `}
                              {formatDuration(selected.result.timing.totalMs)}
                            </figcaption>
                          </figure>
                        )}
                      </>
                    )}
                  </div>
                  {selected.error !== undefined && (
                    <p className={styles.itemError} role="alert">
                      {selected.error}
                    </p>
                  )}
                  {selected.resultUrl !== undefined && (
                    <button
                      className={styles.inlineDownload}
                      type="button"
                      onClick={() => downloadItem(selected)}
                    >
                      이 이미지 다운로드 ↓
                    </button>
                  )}
                </>
              )}
            </section>
          </div>

          <div className={styles.actionBar}>
            <div className={styles.statusCopy}>
              <strong data-testid="image-workbench-status">{message}</strong>
              <span>
                {completedItems.length > 0
                  ? `${formatBytes(completedInputBytes)} → ${formatBytes(totalOutputBytes)} · ${formatSavings(completedInputBytes, totalOutputBytes)}`
                  : `총 ${items.length}개 · ${formatBytes(totalInputBytes)}`}
              </span>
            </div>
            <div className={styles.actionButtons}>
              {processing ? (
                <button className={styles.cancelButton} type="button" onClick={cancelProcessing}>
                  작업 중단
                </button>
              ) : completedItems.length > 0 ? (
                <>
                  <button
                    className={styles.secondaryButton}
                    type="button"
                    disabled={busy}
                    onClick={startProcessing}
                  >
                    {isCompressionIntent ? "다시 압축" : "다시 변환"}
                  </button>
                  <button
                    className={styles.runButton}
                    type="button"
                    disabled={archiving}
                    onClick={() => {
                      const onlyItem = completedItems[0];
                      if (completedItems.length === 1 && onlyItem !== undefined) {
                        downloadItem(onlyItem);
                      } else {
                        void downloadAll();
                      }
                    }}
                  >
                    {completedItems.length === 1
                      ? "결과 다운로드 ↓"
                      : `결과 ${completedItems.length}개 ZIP 다운로드 ↓`}
                  </button>
                </>
              ) : (
                <button
                  className={styles.runButton}
                  type="button"
                  disabled={!runtimeSupported || busy}
                  onClick={startProcessing}
                >
                  {items.length}개 {intentCopy.runLabel} →
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

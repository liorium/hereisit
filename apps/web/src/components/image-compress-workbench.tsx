"use client";

import { supportsBrowserImageRuntime } from "@hereisit/browser-runtime/image";
import { inspectImageHeader, suggestSameFormatOptimizedName } from "@hereisit/image-tool";
import {
  getProcessingPolicy,
  type RemoteDownloadHandle,
  type RemoteImageOptimizeEvent,
  runRemoteImageOptimizeBatch,
} from "@hereisit/server-runtime";
import type {
  ImageOptimizeMime,
  ImageOptimizePhase,
  ImageOptimizeSpecV1,
} from "@hereisit/tool-contracts/image-optimize";
import type { AvailableToolId } from "@hereisit/tool-registry/catalog";
import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { downloadUrl, formatBytes } from "../lib/files";
import {
  deriveImageCompressScreen,
  summarizeImageCompression,
} from "../lib/image-compress-presentation";
import {
  type LocalImageOptimizeResult,
  runLocalImageOptimizeFallback,
} from "../lib/local-image-optimize-fallback";
import {
  getOrCreateAnonymousSessionId,
  isUnprovenInAppBrowser,
  readProcessingClientConfig,
} from "../lib/processing-config";
import {
  buildImageArchive,
  type ImageArchiveEntry,
  remoteArchiveByteBudget,
} from "../lib/remote-image-archive";
import { usePendingToolFiles } from "../lib/use-pending-tool-files";
import styles from "./image-compress-workbench.module.css";

const MAX_FILES = 20;
const MAX_FILE_BYTES = 30 * 1024 * 1024;
const ACCEPTED = new Set<ImageOptimizeMime>(["image/jpeg", "image/png", "image/webp"]);
const HEIC_GUIDANCE =
  "HEIC·HEIF는 같은 형식으로 압축할 수 없어요. 이미지 형식 변환 도구를 이용해 주세요.";
const SUPPORTED_IMAGE_GUIDANCE =
  "JPG, PNG, WebP 정지 이미지만 지원하며 파일당 30MB까지 처리할 수 있어요.";

type Preset = "recommended" | "smallest" | "lossless";
type PolicyView =
  | { readonly state: "checking" }
  | { readonly state: "server"; readonly text: string }
  | { readonly state: "local"; readonly text: string };

type ResultValue =
  | { readonly kind: "remote"; readonly handle: RemoteDownloadHandle }
  | { readonly kind: "remote-consumed" }
  | {
      readonly kind: "local";
      readonly result: Extract<LocalImageOptimizeResult, { status: "fulfilled" }>;
    }
  | { readonly kind: "original" };

interface WorkItem {
  readonly id: string;
  readonly file: File;
  readonly mime: ImageOptimizeMime;
  readonly width: number;
  readonly height: number;
  readonly status: "ready" | "processing" | "completed" | "failed";
  readonly phase: ImageOptimizePhase | null;
  readonly fraction: number | null;
  readonly message: string;
  readonly result?: ResultValue;
  readonly outputByteLength?: number;
}

function optimizeSpec(preset: Preset): ImageOptimizeSpecV1 {
  return {
    version: 1,
    mode: preset === "lossless" ? "lossless" : "smart",
    preset: preset === "smallest" ? "smallest" : "balanced",
    output: "same-format",
    metadata: "strip",
    orientation: "apply",
    colorSpace: "srgb",
    minimumSavingsPercent: 1,
  };
}

function phaseLabel(phase: ImageOptimizePhase | null): string {
  const labels: Record<ImageOptimizePhase, string> = {
    uploading: "안전하게 업로드 중",
    queued: "처리 순서를 기다리는 중",
    validating: "파일 확인 중",
    inspecting: "이미지 구조 확인 중",
    normalizing: "방향과 색상 정리 중",
    optimizing: "용량 최적화 중",
    verifying: "결과 검증 중",
    "preparing-output": "다운로드 준비 중",
    completed: "완료",
  };
  return phase === null ? "처리 준비 중" : labels[phase];
}

function updateItem(items: readonly WorkItem[], id: string, patch: Partial<WorkItem>): WorkItem[] {
  return items.map((item) => (item.id === id ? { ...item, ...patch } : item));
}

async function disposeRemoteItems(items: readonly WorkItem[]): Promise<void> {
  await Promise.allSettled(
    items.flatMap((item) => (item.result?.kind === "remote" ? [item.result.handle.dispose()] : [])),
  );
}

export function ImageCompressWorkbench({ toolId }: { toolId: AvailableToolId }) {
  const config = useMemo(() => readProcessingClientConfig(), []);
  const sessionId = useMemo(() => getOrCreateAnonymousSessionId(), []);
  const [policy, setPolicy] = useState<PolicyView>({ state: "checking" });
  const [items, setItems] = useState<readonly WorkItem[]>([]);
  const [preset, setPreset] = useState<Preset>("recommended");
  const [message, setMessage] = useState("처리 방식을 확인하고 있어요.");
  const [runtimeSupported, setRuntimeSupported] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [remoteDeliveryBusy, setRemoteDeliveryBusy] = useState(false);
  const [archiveByteBudget, setArchiveByteBudget] = useState(() =>
    remoteArchiveByteBudget({ deviceMemoryGiB: null, coarsePointer: true }),
  );
  const batchRef = useRef<ReturnType<typeof runRemoteImageOptimizeBatch> | null>(null);
  const processingControllerRef = useRef<AbortController | null>(null);
  const itemsRef = useRef<readonly WorkItem[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hasFileSelectionRef = useRef(false);
  const downloadHandoffRef = useRef(false);
  const remoteDeliveryLockRef = useRef(false);

  useEffect(() => {
    setRuntimeSupported(supportsBrowserImageRuntime());
    const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    setArchiveByteBudget(
      remoteArchiveByteBudget({
        deviceMemoryGiB:
          typeof memory === "number" && Number.isFinite(memory) && memory > 0 ? memory : null,
        coarsePointer: window.matchMedia("(pointer: coarse)").matches,
      }),
    );
  }, []);

  useEffect(() => {
    let active = true;
    if (config.apiOrigin === null) {
      setPolicy({ state: "local", text: "파일은 업로드하지 않고 이 기기에서 처리해요." });
      if (!hasFileSelectionRef.current) {
        setMessage("파일은 업로드하지 않고 이 기기에서 처리해요.");
      }
      return () => {
        active = false;
      };
    }
    void getProcessingPolicy({ apiOrigin: config.apiOrigin, anonymousSessionId: sessionId })
      .then((value) => {
        if (!active) return;
        if (value.execution === "server") {
          setPolicy({
            state: "server",
            text: "파일은 HereIsIt 처리 서버로 전송되며 작업 후 자동 삭제를 시도해요.",
          });
          if (!hasFileSelectionRef.current) setMessage("서버 처리 정책을 확인했어요.");
        } else {
          setPolicy({
            state: "local",
            text: "파일은 업로드하지 않고 이 기기에서 처리해요.",
          });
          if (!hasFileSelectionRef.current) {
            setMessage(
              value.reason === "LOCAL_FALLBACK_REQUIRED"
                ? "사용량 보호를 위해 이 기기에서 처리해요."
                : "현재 서버 처리가 중지되어 이 기기에서 처리해요.",
            );
          }
        }
      })
      .catch(() => {
        if (!active) return;
        setPolicy({ state: "local", text: "파일은 업로드하지 않고 이 기기에서 처리해요." });
        if (!hasFileSelectionRef.current) {
          setMessage("서버에 연결하지 못해 로컬 처리로 전환했어요.");
        }
      });
    return () => {
      active = false;
    };
  }, [config.apiOrigin, sessionId]);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(
    () => () => {
      batchRef.current?.cancel();
      processingControllerRef.current?.abort();
      for (const item of itemsRef.current) {
        if (item.result?.kind === "remote")
          void item.result.handle.dispose().catch(() => undefined);
      }
    },
    [],
  );

  const chooseFiles = useCallback(async (files: FileList | readonly File[] | null) => {
    if (files === null) return;
    setDragging(false);
    hasFileSelectionRef.current = true;
    const supplied = Array.from(files);
    const selected = supplied.slice(0, MAX_FILES);
    const next: WorkItem[] = [];
    let heicCount = 0;
    let unsupportedCount = Math.max(0, supplied.length - selected.length);
    for (const [index, file] of selected.entries()) {
      setMessage(`${index + 1}/${selected.length} 이미지 확인 중`);
      if (file.size < 1 || file.size > MAX_FILE_BYTES) {
        unsupportedCount += 1;
        continue;
      }
      try {
        const inspected = inspectImageHeader(await file.arrayBuffer());
        if (inspected.mime === "image/heic") {
          heicCount += 1;
          continue;
        }
        if (
          inspected.animated ||
          inspected.width * inspected.height > 40_000_000 ||
          !ACCEPTED.has(inspected.mime as ImageOptimizeMime)
        ) {
          unsupportedCount += 1;
          continue;
        }
        next.push({
          id: crypto.randomUUID(),
          file,
          mime: inspected.mime as ImageOptimizeMime,
          width: inspected.width,
          height: inspected.height,
          status: "ready",
          phase: null,
          fraction: null,
          message: "처리할 준비가 됐어요.",
        });
      } catch {
        unsupportedCount += 1;
      }
    }
    const previousItems = itemsRef.current;
    itemsRef.current = next;
    setItems(next);
    void disposeRemoteItems(previousItems);
    const prefix =
      next.length === 0
        ? "지원되는 이미지를 찾지 못했어요."
        : `${next.length}개 이미지를 확인했어요.`;
    const rejected = [
      heicCount > 0
        ? next.length === 0 && unsupportedCount === 0
          ? HEIC_GUIDANCE
          : `HEIC·HEIF는 같은 형식으로 압축할 수 없어 ${heicCount}개를 제외했어요. 이미지 형식 변환 도구를 이용해 주세요.`
        : null,
      unsupportedCount > 0
        ? next.length === 0
          ? SUPPORTED_IMAGE_GUIDANCE
          : `지원 조건에 맞지 않는 ${unsupportedCount}개를 제외했어요. ${SUPPORTED_IMAGE_GUIDANCE}`
        : null,
    ].filter((value): value is string => value !== null);
    setMessage([prefix, ...rejected].join(" "));
  }, []);

  const executionReady =
    policy.state === "server" || (policy.state === "local" && runtimeSupported);
  const busy = processing || archiving || remoteDeliveryBusy;

  usePendingToolFiles({
    toolId,
    ready: executionReady && !busy,
    acceptFiles: chooseFiles,
    onReselectRequired: setMessage,
  });

  const changePreset = (value: Preset) => {
    setPreset(value);
    if (!itemsRef.current.some((item) => item.result !== undefined)) return;
    void disposeRemoteItems(itemsRef.current);
    const reset = itemsRef.current.map<WorkItem>((item) => {
      const { result: _result, outputByteLength: _outputByteLength, ...source } = item;
      return {
        ...source,
        status: "ready",
        phase: null,
        fraction: null,
        message: "설정이 바뀌어 다시 처리할 준비가 됐어요.",
      };
    });
    itemsRef.current = reset;
    setItems(reset);
    setMessage("압축 설정이 바뀌었어요. 다시 처리해 주세요.");
  };

  const runLocal = async (
    sourceItems: readonly WorkItem[],
    spec: ImageOptimizeSpecV1,
    signal: AbortSignal,
  ) => {
    for (const item of sourceItems) {
      if (signal.aborted) break;
      setItems((current) =>
        updateItem(current, item.id, {
          status: "processing",
          phase: "inspecting",
          fraction: null,
          message: "내 기기에서 처리하고 있어요.",
        }),
      );
      const result = await runLocalImageOptimizeFallback(
        { itemId: item.id, file: item.file },
        spec,
        {
          signal,
          onEvent: (event) =>
            setItems((current) =>
              updateItem(current, item.id, {
                phase: event.phase,
                fraction: event.fraction,
                message: phaseLabel(event.phase),
              }),
            ),
        },
      );
      if (result.status === "fulfilled") {
        setItems((current) =>
          updateItem(current, item.id, {
            status: "completed",
            phase: "completed",
            result: { kind: "local", result },
            outputByteLength: result.byteLength,
            message: result.warnings.includes("SMART_PNG_FELL_BACK_TO_LOSSLESS")
              ? "PNG는 무손실 메타데이터 정리로 완료했어요."
              : "압축을 완료했어요.",
          }),
        );
      } else if (result.status === "original-retained") {
        setItems((current) =>
          updateItem(current, item.id, {
            status: "completed",
            phase: "completed",
            result: { kind: "original" },
            outputByteLength: item.file.size,
            message: "이미 충분히 작아 원본을 유지했어요",
          }),
        );
      } else {
        setItems((current) =>
          updateItem(current, item.id, {
            status: "failed",
            message:
              result.status === "unsupported"
                ? "무손실 서버 처리가 필요한 이미지예요. 현재는 업로드하지 않았어요."
                : result.status === "rejected"
                  ? result.message
                  : "작업을 취소했어요.",
          }),
        );
      }
    }
  };

  const processItems = async () => {
    if (processing || remoteDeliveryBusy || items.length === 0 || policy.state === "checking")
      return;
    setProcessing(true);
    const processingController = new AbortController();
    processingControllerRef.current = processingController;
    const sourceItems = items.filter((item) => item.status === "ready" || item.status === "failed");
    const spec = optimizeSpec(preset);
    try {
      let execution: "server" | "local" = policy.state === "server" ? "server" : "local";
      if (config.apiOrigin !== null) {
        setMessage("처리 정책을 다시 확인하고 있어요.");
        try {
          const refreshed = await getProcessingPolicy({
            apiOrigin: config.apiOrigin,
            anonymousSessionId: sessionId,
            forceRefresh: true,
            signal: processingController.signal,
          });
          if (refreshed.execution === "server") {
            execution = "server";
            setPolicy({
              state: "server",
              text: "파일은 HereIsIt 처리 서버로 전송되며 작업 후 자동 삭제를 시도해요.",
            });
          } else {
            execution = "local";
            setPolicy({
              state: "local",
              text: "파일은 업로드하지 않고 이 기기에서 처리해요.",
            });
          }
        } catch {
          if (processingController.signal.aborted) {
            setMessage("작업을 중단했어요.");
            return;
          }
          execution = "local";
          setPolicy({ state: "local", text: "파일은 업로드하지 않고 이 기기에서 처리해요." });
        }
      }

      if (execution === "server" && config.apiOrigin !== null) {
        const onEvent = (event: RemoteImageOptimizeEvent) => {
          if (event.type === "item-progress") {
            setItems((current) =>
              updateItem(current, event.itemId, {
                status: "processing",
                phase: event.phase,
                fraction: event.fraction,
                message: phaseLabel(event.phase),
              }),
            );
          } else if (event.type === "item-complete") {
            const completedResult = event.result;
            const completedItemId = event.itemId;
            const source = sourceItems.find((item) => item.id === completedItemId);
            if (source === undefined) return;
            if (completedResult.status === "fulfilled") {
              setItems((current) =>
                updateItem(current, completedItemId, {
                  status: "completed",
                  phase: "completed",
                  result: { kind: "remote", handle: completedResult.value },
                  outputByteLength: completedResult.value.descriptor.byteLength,
                  message: "서버 압축을 완료했어요.",
                }),
              );
            } else if (completedResult.status === "original-retained") {
              setItems((current) =>
                updateItem(current, completedItemId, {
                  status: "completed",
                  phase: "completed",
                  result: { kind: "original" },
                  outputByteLength: source.file.size,
                  message: "이미 충분히 작아 원본을 유지했어요",
                }),
              );
            }
          }
        };
        const batch = runRemoteImageOptimizeBatch(
          sourceItems.map((item) => ({
            itemId: item.id,
            file: item.file,
            width: item.width,
            height: item.height,
            spec,
          })),
          {
            apiOrigin: config.apiOrigin,
            anonymousSessionId: sessionId,
            confirmDownloadHandoff: async () => {
              downloadHandoffRef.current = true;
              return true;
            },
            onEvent,
          },
        );
        batchRef.current = batch;
        const remoteResults = await batch.result;
        const fallback: WorkItem[] = [];
        for (const result of remoteResults) {
          const source = sourceItems.find((item) => item.id === result.itemId);
          if (source === undefined) continue;
          if (result.status === "fulfilled") {
            setItems((current) =>
              updateItem(current, result.itemId, {
                status: "completed",
                phase: "completed",
                result: { kind: "remote", handle: result.value },
                outputByteLength: result.value.descriptor.byteLength,
                message: "서버 압축을 완료했어요.",
              }),
            );
          } else if (result.status === "original-retained") {
            setItems((current) =>
              updateItem(current, result.itemId, {
                status: "completed",
                phase: "completed",
                result: { kind: "original" },
                outputByteLength: source.file.size,
                message: "이미 충분히 작아 원본을 유지했어요",
              }),
            );
          } else if (result.status === "rejected" && result.error.retryable) {
            if (result.error.code === "RATE_LIMITED" || result.error.code === "QUOTA_EXCEEDED") {
              setPolicy({
                state: "local",
                text: "파일은 업로드하지 않고 이 기기에서 처리해요.",
              });
            }
            fallback.push(source);
          } else {
            setItems((current) =>
              updateItem(current, result.itemId, {
                status: "failed",
                message: result.status === "rejected" ? result.error.message : "작업을 취소했어요.",
              }),
            );
          }
        }
        if (fallback.length > 0) {
          setMessage("서버 처리를 시작하지 못한 이미지를 업로드 없이 다시 처리해요.");
          await runLocal(fallback, spec, processingController.signal);
        }
      } else {
        await runLocal(sourceItems, spec, processingController.signal);
      }
      setMessage(
        processingController.signal.aborted
          ? "작업을 중단했어요."
          : "처리가 끝났어요. 결과를 바로 다운로드할 수 있어요.",
      );
    } catch {
      const failureMessage = "처리를 완료하지 못했어요. 다시 시도해 주세요.";
      setItems((current) =>
        current.map((item) =>
          item.status === "completed"
            ? item
            : { ...item, status: "failed", message: failureMessage },
        ),
      );
      setMessage(failureMessage);
    } finally {
      batchRef.current = null;
      if (processingControllerRef.current === processingController) {
        processingControllerRef.current = null;
      }
      setProcessing(false);
    }
  };

  const downloadItem = async (item: WorkItem) => {
    const result = item.result;
    if (result === undefined || result.kind === "remote-consumed") return;
    const filename = suggestSameFormatOptimizedName(item.file.name, item.mime);
    if (result.kind === "remote") {
      if (remoteDeliveryLockRef.current) return;
      remoteDeliveryLockRef.current = true;
      setRemoteDeliveryBusy(true);
      downloadHandoffRef.current = false;
      try {
        await result.handle.download({ filename });
        setItems((current) =>
          updateItem(current, item.id, {
            result: { kind: "remote-consumed" },
            message: "다운로드 완료",
          }),
        );
        setMessage("다운로드와 서버 결과 삭제 요청을 완료했어요.");
      } catch {
        if (downloadHandoffRef.current) {
          setItems((current) =>
            updateItem(current, item.id, {
              result: { kind: "remote-consumed" },
              message: "다운로드 전달됨",
            }),
          );
          setMessage("파일이 다운로드되었을 수 있어요. 브라우저 다운로드 목록을 확인해 주세요.");
        } else {
          setMessage("다운로드를 시작하지 못했어요. 다시 시도해 주세요.");
        }
      } finally {
        remoteDeliveryLockRef.current = false;
        setRemoteDeliveryBusy(false);
      }
      return;
    }
    const blob =
      result.kind === "original"
        ? item.file
        : new Blob([result.result.bytes], { type: result.result.mime });
    const url = URL.createObjectURL(blob);
    try {
      downloadUrl(url, filename);
      setMessage(
        isUnprovenInAppBrowser()
          ? "다운로드가 시작되지 않으면 기본 브라우저에서 열어 다시 다운로드해 주세요."
          : "다운로드를 시작했어요.",
      );
    } catch {
      setMessage("다운로드를 시작하지 못했어요. 다시 시도해 주세요.");
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  };

  const completed = items.filter((item) => item.status === "completed");
  const resultItems = completed.filter(
    (item): item is WorkItem & { readonly outputByteLength: number } =>
      item.outputByteLength !== undefined,
  );
  const singleResultItem = items.length === 1 ? resultItems[0] : undefined;
  const resultSummary = summarizeImageCompression(
    resultItems.map((item) => ({ inputBytes: item.file.size, outputBytes: item.outputByteLength })),
  );
  const reductionText =
    resultSummary === null
      ? null
      : `${resultSummary.reductionPercent.toFixed(1).replace(/\.0$/, "")}% 줄였어요`;
  const archiveItems = resultItems.filter(
    (item) =>
      item.result?.kind === "remote" ||
      item.result?.kind === "local" ||
      item.result?.kind === "original",
  );
  const archiveBytes = archiveItems.reduce((sum, item) => sum + item.outputByteLength, 0);
  const remoteArchiveIds = new Set(
    archiveItems.flatMap((item) => (item.result?.kind === "remote" ? [item.id] : [])),
  );
  const markRemoteArchiveEntriesConsumed = (itemMessage: string) => {
    setItems((current) =>
      current.map((item) =>
        remoteArchiveIds.has(item.id)
          ? { ...item, result: { kind: "remote-consumed" }, message: itemMessage }
          : item,
      ),
    );
  };
  const downloadArchive = async () => {
    if (
      remoteDeliveryLockRef.current ||
      archiveItems.length < 2 ||
      archiveBytes > archiveByteBudget
    ) {
      return;
    }
    remoteDeliveryLockRef.current = true;
    downloadHandoffRef.current = false;
    setArchiving(true);
    setMessage("ZIP 파일을 만들고 있어요.");
    let archive: Awaited<ReturnType<typeof buildImageArchive>> | null = null;
    let url: string | null = null;
    try {
      const archiveEntries = archiveItems.flatMap<ImageArchiveEntry>((item) => {
        const filename = suggestSameFormatOptimizedName(item.file.name, item.mime);
        if (item.result?.kind === "remote") {
          return [{ kind: "remote", filename, handle: item.result.handle }];
        }
        if (item.result?.kind === "local") {
          return [
            {
              kind: "local",
              filename,
              blob: new Blob([item.result.result.bytes], { type: item.result.result.mime }),
            },
          ];
        }
        return item.result?.kind === "original"
          ? [{ kind: "local", filename, blob: item.file }]
          : [];
      });
      archive = await buildImageArchive({
        entries: archiveEntries,
        byteBudget: archiveByteBudget,
      });
      url = URL.createObjectURL(archive.blob);
      downloadUrl(url, "hereisit-images.zip");
      downloadHandoffRef.current = true;
      await archive.acknowledgeAfterHandoff();
      markRemoteArchiveEntriesConsumed("다운로드 완료");
      setMessage(
        remoteArchiveIds.size > 0
          ? "ZIP 다운로드와 서버 결과 삭제 요청을 완료했어요."
          : "ZIP 다운로드를 시작했어요.",
      );
    } catch {
      if (downloadHandoffRef.current) {
        markRemoteArchiveEntriesConsumed("다운로드 전달됨");
        setMessage("파일이 다운로드되었을 수 있어요. 브라우저 다운로드 목록을 확인해 주세요.");
      } else {
        setMessage("다운로드를 시작하지 못했어요. 다시 시도해 주세요.");
      }
    } finally {
      if (url !== null) {
        const createdUrl = url;
        setTimeout(() => URL.revokeObjectURL(createdUrl), 0);
      }
      archive?.dispose();
      remoteDeliveryLockRef.current = false;
      setArchiving(false);
    }
  };
  const screen = deriveImageCompressScreen({
    processing,
    archiving,
    completedCount: completed.length,
  });
  const totalInputBytes = items.reduce((sum, item) => sum + item.file.size, 0);
  const activeItem = items.find((item) => item.status === "processing");
  const settledCount = items.filter(
    (item) => item.status === "completed" || item.status === "failed",
  ).length;
  const presetLabels: Record<Preset, string> = {
    recommended: "추천",
    smallest: "최소 용량",
    lossless: "무손실",
  };
  const actionableCount = items.filter(
    (item) => item.status === "ready" || item.status === "failed",
  ).length;
  const terminalFailure =
    !processing &&
    items.length > 0 &&
    items.every((item) => item.status === "failed") &&
    message !== "작업을 중단했어요.";
  const statusMessage = terminalFailure ? (items[0]?.message ?? message) : message;
  const idleStatus =
    items.length === 0 &&
    (statusMessage === "처리 방식을 확인하고 있어요." ||
      statusMessage === "서버 처리 정책을 확인했어요." ||
      (policy.state !== "checking" && statusMessage === policy.text));
  const runDisabled = actionableCount === 0 || policy.state === "checking" || remoteDeliveryBusy;
  const handleFileInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    void chooseFiles(input.files).finally(() => {
      input.value = "";
    });
  };
  const cancelProcessing = () => {
    processingControllerRef.current?.abort();
    batchRef.current?.cancel();
  };

  const resetWorkbench = async () => {
    if (remoteDeliveryLockRef.current) return;
    processingControllerRef.current?.abort();
    batchRef.current?.cancel();
    const previous = itemsRef.current;
    itemsRef.current = [];
    setItems([]);
    setDragging(false);
    await disposeRemoteItems(previous);
    setMessage(
      policy.state === "checking"
        ? "처리 방식을 확인하고 있어요."
        : policy.state === "server"
          ? "서버 처리 정책을 확인했어요."
          : policy.text,
    );
  };

  return (
    <section
      className={styles.workbench}
      data-runtime="hereisit-server-runtime"
      aria-label="이미지 압축 작업대"
    >
      {screen === "setup" ? (
        <section className={styles.stage} aria-labelledby="compress-setup-title">
          <h2 id="compress-setup-title" className={styles.visuallyHidden}>
            압축 설정
          </h2>
          <button
            type="button"
            className={styles.picker}
            aria-label={items.length > 0 ? "이미지 다시 선택" : "이미지 선택"}
            data-dragging={dragging}
            data-selected={items.length > 0}
            disabled={!executionReady || busy}
            onDragEnter={(event) => {
              event.preventDefault();
              if (executionReady && !busy) setDragging(true);
            }}
            onDragLeave={(event) => {
              const nextTarget = event.relatedTarget;
              if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
                setDragging(false);
              }
            }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              if (!executionReady || busy) return;
              void chooseFiles(event.dataTransfer.files);
            }}
            onClick={() => fileInputRef.current?.click()}
          >
            {items.length > 0 ? (
              <>
                <span className={styles.pickerKicker}>선택됨</span>
                <strong className={styles.pickerTitle}>
                  {items.length === 1
                    ? `${items[0]?.file.name} · ${formatBytes(totalInputBytes)}`
                    : `${items.length}개 이미지 · ${formatBytes(totalInputBytes)}`}
                </strong>
                <span className={styles.pickerHint}>눌러서 이미지 다시 선택</span>
              </>
            ) : (
              <>
                <strong className={styles.pickerTitle}>이미지 선택</strong>
                <span className={styles.pickerHint}>클릭하거나 여기로 끌어오세요</span>
                <span className={styles.pickerMeta}>JPG, PNG, WebP · 최대 20개 · 각 30MB</span>
              </>
            )}
          </button>
          <input
            ref={fileInputRef}
            className={styles.fileInput}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            disabled={!executionReady || busy}
            onChange={handleFileInputChange}
          />
          <p className={styles.disclosure} data-policy={policy.state}>
            {policy.state === "checking" ? "처리 방식을 확인하고 있어요." : policy.text}
            {policy.state === "server" ? <a href="/privacy">자세히</a> : null}
          </p>
          {items.length > 0 ? (
            <details className={styles.settings}>
              <summary>압축 설정 · {presetLabels[preset]}</summary>
              <div className={styles.presets} role="radiogroup" aria-label="압축 프리셋">
                {(
                  [
                    ["recommended", "추천", "품질과 용량의 균형"],
                    ["smallest", "최소 용량", "더 강한 시각적 압축"],
                    ["lossless", "무손실", "픽셀을 바꾸지 않고 정리"],
                  ] as const
                ).map(([value, label, detail]) => (
                  <label key={value} data-selected={preset === value}>
                    <input
                      type="radio"
                      name="compress-preset"
                      value={value}
                      checked={preset === value}
                      onChange={() => changePreset(value)}
                    />
                    <strong>{label}</strong>
                    <span>{detail}</span>
                  </label>
                ))}
              </div>
              {items.some((item) => item.mime === "image/png") && preset !== "lossless" ? (
                <p>PNG 스마트 모드는 색상 수를 줄일 수 있는 시각적 압축입니다.</p>
              ) : null}
            </details>
          ) : null}
          {!idleStatus ? (
            <p
              role={terminalFailure ? "alert" : "status"}
              aria-live={terminalFailure ? "assertive" : "polite"}
              data-testid="image-workbench-status"
            >
              {statusMessage}
            </p>
          ) : null}
          {items.length > 0 ? (
            <button
              type="button"
              className={styles.primaryAction}
              disabled={runDisabled}
              onClick={() => void processItems()}
            >
              용량 줄이기
            </button>
          ) : null}
        </section>
      ) : null}

      {screen === "processing" ? (
        <section className={styles.stage} aria-labelledby="compress-progress-title">
          <h2 id="compress-progress-title">
            {archiving ? "ZIP 파일 만드는 중" : "이미지 압축 중"}
          </h2>
          {archiving ? null : (
            <p className={styles.progressCount}>
              {Math.min(items.length, settledCount + 1)}/{items.length}
            </p>
          )}
          <p role="status" aria-live="polite" data-testid="image-workbench-status">
            {archiving ? message : phaseLabel(activeItem?.phase ?? null)}
          </p>
          <progress value={archiving ? undefined : (activeItem?.fraction ?? undefined)} max={1} />
          {archiving ? null : (
            <button type="button" className={styles.secondaryAction} onClick={cancelProcessing}>
              중단
            </button>
          )}
        </section>
      ) : null}

      {screen === "result" && resultSummary !== null && singleResultItem !== undefined ? (
        <section className={styles.resultStage} aria-labelledby="compress-result-title">
          <h2 id="compress-result-title">
            {singleResultItem.result?.kind === "original" ? "원본 유지" : "압축 완료"}
          </h2>
          <div className={styles.sizeComparison}>
            <div>
              <span className={styles.sizeLabel}>원본</span>
              <strong>{formatBytes(singleResultItem.file.size)}</strong>
            </div>
            <span aria-hidden="true" className={styles.sizeArrow}>
              →
            </span>
            <div data-result="true">
              <span className={styles.sizeLabel}>결과</span>
              <strong>{formatBytes(singleResultItem.outputByteLength)}</strong>
            </div>
          </div>
          <p className={styles.reduction}>
            {singleResultItem.result?.kind === "original"
              ? "이미 충분히 작아 원본을 유지했어요"
              : reductionText}
          </p>
          <p role="status" aria-live="polite" data-testid="image-workbench-status">
            {message}
          </p>
          {singleResultItem.result !== undefined &&
          singleResultItem.result.kind !== "remote-consumed" ? (
            <button
              className={styles.primaryAction}
              type="button"
              disabled={singleResultItem.result.kind === "remote" && remoteDeliveryBusy}
              onClick={() => void downloadItem(singleResultItem)}
            >
              {singleResultItem.result.kind === "original" ? "원본 다운로드 ↓" : "결과 다운로드 ↓"}
            </button>
          ) : null}
          <button
            className={styles.textAction}
            type="button"
            disabled={remoteDeliveryBusy}
            onClick={() => void resetWorkbench()}
          >
            다른 이미지 압축
          </button>
        </section>
      ) : null}

      {screen === "result" && resultSummary !== null && items.length > 1 ? (
        <section className={styles.resultStage} aria-labelledby="compress-result-title">
          <h2 id="compress-result-title">{resultSummary.count}개 이미지 압축 완료</h2>
          <div className={styles.sizeComparison}>
            <div>
              <span className={styles.sizeLabel}>원본</span>
              <strong>{formatBytes(resultSummary.inputBytes)}</strong>
            </div>
            <span aria-hidden="true" className={styles.sizeArrow}>
              →
            </span>
            <div data-result="true">
              <span className={styles.sizeLabel}>결과</span>
              <strong>{formatBytes(resultSummary.outputBytes)}</strong>
            </div>
          </div>
          <p className={styles.reduction}>{reductionText}</p>
          <p role="status" aria-live="polite" data-testid="image-workbench-status">
            {message}
          </p>
          {archiveItems.length >= 2 && archiveBytes <= archiveByteBudget ? (
            <button
              className={styles.primaryAction}
              type="button"
              disabled={remoteDeliveryBusy}
              onClick={() => void downloadArchive()}
            >
              결과 {archiveItems.length}개 ZIP 다운로드 ↓
            </button>
          ) : archiveItems.length >= 2 ? (
            <p>용량이 커서 개별 다운로드만 지원해요.</p>
          ) : null}
          <details className={styles.individualResults} open={archiveBytes > archiveByteBudget}>
            <summary>파일별 결과 보기</summary>
            <ul>
              {items.map((item) => (
                <li key={item.id}>
                  <div>
                    <strong>{item.file.name}</strong>
                    {item.outputByteLength === undefined ? (
                      <span>{item.message}</span>
                    ) : (
                      <span>
                        {formatBytes(item.file.size)} → {formatBytes(item.outputByteLength)}
                      </span>
                    )}
                    {item.result?.kind === "original" ? <span>{item.message}</span> : null}
                  </div>
                  {item.status === "completed" &&
                  item.result !== undefined &&
                  item.result.kind !== "remote-consumed" ? (
                    <button
                      type="button"
                      disabled={item.result.kind === "remote" && remoteDeliveryBusy}
                      onClick={() => void downloadItem(item)}
                    >
                      {item.result.kind === "original" ? "원본 다운로드 ↓" : "결과 다운로드 ↓"}
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </details>
          <button
            className={styles.textAction}
            type="button"
            disabled={remoteDeliveryBusy}
            onClick={() => void resetWorkbench()}
          >
            다른 이미지 압축
          </button>
        </section>
      ) : null}
    </section>
  );
}

"use client";

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
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { downloadUrl, formatBytes } from "../lib/files";
import {
  type LocalImageOptimizeResult,
  runLocalImageOptimizeFallback,
} from "../lib/local-image-optimize-fallback";
import {
  getOrCreateAnonymousSessionId,
  isUnprovenInAppBrowser,
  readProcessingClientConfig,
} from "../lib/processing-config";
import { buildRemoteImageArchive, remoteArchiveByteBudget } from "../lib/remote-image-archive";
import styles from "./image-compress-workbench.module.css";

const MAX_FILES = 20;
const MAX_FILE_BYTES = 30 * 1024 * 1024;
const ACCEPTED = new Set<ImageOptimizeMime>(["image/jpeg", "image/png", "image/webp"]);

type Preset = "recommended" | "smallest" | "lossless";
type PolicyView =
  | { readonly state: "checking" }
  | { readonly state: "server"; readonly text: string }
  | { readonly state: "local"; readonly text: string };

type ResultValue =
  | { readonly kind: "remote"; readonly handle: RemoteDownloadHandle }
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

export function ImageCompressWorkbench() {
  const config = useMemo(() => readProcessingClientConfig(), []);
  const sessionId = useMemo(() => getOrCreateAnonymousSessionId(), []);
  const [policy, setPolicy] = useState<PolicyView>({ state: "checking" });
  const [items, setItems] = useState<readonly WorkItem[]>([]);
  const [preset, setPreset] = useState<Preset>("recommended");
  const [message, setMessage] = useState("처리 방식을 확인하고 있어요.");
  const [processing, setProcessing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const batchRef = useRef<ReturnType<typeof runRemoteImageOptimizeBatch> | null>(null);
  const processingControllerRef = useRef<AbortController | null>(null);
  const itemsRef = useRef<readonly WorkItem[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    if (config.apiOrigin === null) {
      setPolicy({ state: "local", text: "업로드 없음 · 내 기기에서 처리" });
      setMessage("파일은 업로드하지 않고 이 기기에서 처리해요.");
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
            text: "선택한 이미지는 HereIsIt 처리 서버로 전송되며 입력과 결과는 자동 삭제를 시도해요.",
          });
          setMessage("서버 처리 정책을 확인했어요.");
        } else {
          setPolicy({
            state: "local",
            text:
              value.reason === "LOCAL_FALLBACK_REQUIRED"
                ? "사용량 보호 · 업로드 없이 내 기기에서 처리"
                : "서버 처리 중지 · 업로드 없이 내 기기에서 처리",
          });
          setMessage(
            value.reason === "LOCAL_FALLBACK_REQUIRED"
              ? "사용량 보호를 위해 이 기기에서 처리해요."
              : "현재 서버 처리가 중지되어 이 기기에서 처리해요.",
          );
        }
      })
      .catch(() => {
        if (!active) return;
        setPolicy({ state: "local", text: "서버 연결 실패 · 업로드 없이 내 기기에서 처리" });
        setMessage("서버에 연결하지 못해 로컬 처리로 전환했어요.");
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

  const chooseFiles = async (files: FileList | null) => {
    if (files === null || processing || archiving) return;
    const selected = Array.from(files).slice(0, MAX_FILES);
    const next: WorkItem[] = [];
    for (const file of selected) {
      if (
        !ACCEPTED.has(file.type as ImageOptimizeMime) ||
        file.size < 1 ||
        file.size > MAX_FILE_BYTES
      ) {
        continue;
      }
      try {
        const inspected = inspectImageHeader(await file.arrayBuffer());
        if (
          inspected.animated ||
          inspected.width * inspected.height > 40_000_000 ||
          !ACCEPTED.has(inspected.mime as ImageOptimizeMime) ||
          inspected.mime !== file.type
        ) {
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
        // Invalid files are omitted and disclosed in the aggregate message below.
      }
    }
    const previousItems = itemsRef.current;
    itemsRef.current = next;
    setItems(next);
    void disposeRemoteItems(previousItems);
    setMessage(
      next.length === selected.length
        ? `${next.length}개 이미지를 확인했어요.`
        : `지원되는 정지 이미지 ${next.length}개를 확인했어요.`,
    );
  };

  const changePreset = (value: Preset) => {
    setPreset(value);
    if (!itemsRef.current.some((item) => item.result !== undefined)) return;
    void disposeRemoteItems(itemsRef.current);
    const reset = itemsRef.current.map<WorkItem>((item) => {
      const { result: _result, ...source } = item;
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
            message: "원본 파일을 그대로 내려받습니다 · 메타데이터도 그대로일 수 있어요",
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
    if (processing || archiving || items.length === 0 || policy.state === "checking") return;
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
              text: "선택한 이미지는 HereIsIt 처리 서버로 전송되며 입력과 결과는 자동 삭제를 시도해요.",
            });
          } else {
            execution = "local";
            setPolicy({
              state: "local",
              text:
                refreshed.reason === "LOCAL_FALLBACK_REQUIRED"
                  ? "사용량 보호 · 업로드 없이 내 기기에서 처리"
                  : "서버 처리 중지 · 업로드 없이 내 기기에서 처리",
            });
          }
        } catch {
          if (processingController.signal.aborted) {
            setMessage("작업을 중단했어요.");
            return;
          }
          execution = "local";
          setPolicy({ state: "local", text: "서버 연결 실패 · 업로드 없이 내 기기에서 처리" });
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
            if (completedResult.status === "fulfilled") {
              setItems((current) =>
                updateItem(current, completedItemId, {
                  status: "completed",
                  phase: "completed",
                  result: { kind: "remote", handle: completedResult.value },
                  message: "서버 압축을 완료했어요.",
                }),
              );
            } else if (completedResult.status === "original-retained") {
              setItems((current) =>
                updateItem(current, completedItemId, {
                  status: "completed",
                  phase: "completed",
                  result: { kind: "original" },
                  message: "원본 파일을 그대로 내려받습니다 · 메타데이터도 그대로일 수 있어요",
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
          { apiOrigin: config.apiOrigin, anonymousSessionId: sessionId, onEvent },
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
                message: "서버 압축을 완료했어요.",
              }),
            );
          } else if (result.status === "original-retained") {
            setItems((current) =>
              updateItem(current, result.itemId, {
                status: "completed",
                phase: "completed",
                result: { kind: "original" },
                message: "원본 파일을 그대로 내려받습니다 · 메타데이터도 그대로일 수 있어요",
              }),
            );
          } else if (result.status === "rejected" && result.error.retryable) {
            if (result.error.code === "RATE_LIMITED" || result.error.code === "QUOTA_EXCEEDED") {
              setPolicy({
                state: "local",
                text: "사용량 보호 · 업로드 없이 내 기기에서 처리",
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
      setMessage("처리를 완료하지 못했어요. 다시 시도해 주세요.");
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
    if (result === undefined) return;
    const filename = suggestSameFormatOptimizedName(item.file.name, item.mime);
    if (result.kind === "remote") {
      try {
        await result.handle.download({ filename });
        setMessage(
          isUnprovenInAppBrowser()
            ? "다운로드가 시작되지 않으면 기본 브라우저에서 열어 다시 다운로드해 주세요."
            : "다운로드를 시작했어요. 필요하면 다시 다운로드할 수 있어요.",
        );
      } catch {
        setMessage("다운로드를 시작하지 못했어요. 결과는 유지되니 다시 시도해 주세요.");
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
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
    setMessage(
      isUnprovenInAppBrowser()
        ? "다운로드가 시작되지 않으면 기본 브라우저에서 열어 다시 다운로드해 주세요."
        : "다운로드를 시작했어요. 필요하면 다시 다운로드할 수 있어요.",
    );
  };

  const completed = items.filter((item) => item.status === "completed");
  const actionableCount = items.filter(
    (item) => item.status === "ready" || item.status === "failed",
  ).length;
  const remoteEntries = completed.flatMap((item) =>
    item.result?.kind === "remote"
      ? [
          {
            filename: suggestSameFormatOptimizedName(item.file.name, item.mime),
            handle: item.result.handle,
          },
        ]
      : [],
  );
  const budget = remoteArchiveByteBudget({
    deviceMemoryGiB:
      typeof navigator === "undefined"
        ? null
        : ((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null),
    coarsePointer:
      typeof matchMedia === "undefined" ? false : matchMedia("(pointer: coarse)").matches,
  });
  const archiveBytes = remoteEntries.reduce(
    (sum, entry) => sum + entry.handle.descriptor.byteLength,
    0,
  );

  const downloadArchive = async () => {
    if (archiving || remoteEntries.length < 2 || archiveBytes > budget) return;
    setArchiving(true);
    try {
      const archive = await buildRemoteImageArchive({ entries: remoteEntries, byteBudget: budget });
      const url = URL.createObjectURL(archive.blob);
      try {
        downloadUrl(url, "hereisit-images.zip");
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 0);
        archive.dispose();
      }
      setMessage("ZIP 다운로드를 시작했어요. 개별 결과도 다시 받을 수 있어요.");
    } catch {
      setMessage("ZIP을 만들지 못했어요. 개별 결과는 계속 다운로드할 수 있어요.");
    } finally {
      setArchiving(false);
    }
  };

  return (
    <section
      className={styles.workbench}
      data-runtime="hereisit-server-runtime"
      aria-label="이미지 압축 작업대"
    >
      <div className={styles.disclosure} data-policy={policy.state}>
        <strong>
          {policy.state === "checking" ? "처리 방식을 확인하고 있어요." : policy.text}
        </strong>
        {policy.state === "server" ? (
          <p>
            입력은 작업 종료 시, 결과는 다운로드 확인 시 삭제를 시도합니다. 확인되지 않은 결과는
            일반적으로 35분 안에 정리하며 장애 시 늦어질 수 있고 1일 만료 규칙이 안전망으로
            적용됩니다. <a href="/privacy">개인정보처리방침</a>
          </p>
        ) : null}
      </div>

      <div className={styles.grid}>
        <section className={styles.panel} aria-labelledby="compress-files-title">
          <h2 id="compress-files-title">1. 이미지 선택</h2>
          <button
            type="button"
            className={styles.picker}
            disabled={policy.state === "checking" || processing || archiving}
            onClick={() => fileInputRef.current?.click()}
          >
            압축할 이미지 선택
          </button>
          <input
            ref={fileInputRef}
            className={styles.fileInput}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            disabled={policy.state === "checking" || processing || archiving}
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              const input = event.currentTarget;
              void chooseFiles(input.files).finally(() => {
                input.value = "";
              });
            }}
          />
          <p>JPG, PNG, WebP · 파일당 30MB · 최대 20개 · 움직이는 이미지 제외</p>
          <ul className={styles.fileList}>
            {items.map((item) => (
              <li key={item.id}>
                <div>
                  <strong>{item.file.name}</strong>
                  <span>
                    {formatBytes(item.file.size)} · {item.width}×{item.height}
                  </span>
                </div>
                <span>{item.status === "processing" ? phaseLabel(item.phase) : item.message}</span>
                {item.status === "processing" ? (
                  <progress value={item.fraction ?? undefined} max={1} />
                ) : null}
              </li>
            ))}
          </ul>
        </section>

        <section className={styles.panel} aria-labelledby="compress-settings-title">
          <h2 id="compress-settings-title">2. 압축 설정</h2>
          <div className={styles.presets}>
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
                  disabled={processing || archiving}
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
        </section>

        <section className={styles.panel} aria-labelledby="compress-results-title">
          <h2 id="compress-results-title">3. 결과</h2>
          <p aria-live="polite">{message}</p>
          <ul className={styles.results}>
            {completed.map((item) => (
              <li key={item.id}>
                <div>
                  <strong>{suggestSameFormatOptimizedName(item.file.name, item.mime)}</strong>
                  <span>{item.message}</span>
                </div>
                <button type="button" onClick={() => void downloadItem(item)}>
                  결과 다운로드 ↓
                </button>
              </li>
            ))}
          </ul>
          {remoteEntries.length >= 2 ? (
            archiveBytes <= budget ? (
              <button type="button" disabled={archiving} onClick={() => void downloadArchive()}>
                결과 {remoteEntries.length}개 ZIP으로 받기 ↓
              </button>
            ) : (
              <p>용량이 커서 개별 다운로드만 지원해요.</p>
            )
          ) : null}
        </section>
      </div>

      <div className={styles.stickyAction}>
        {processing ? (
          <button
            type="button"
            onClick={() => {
              processingControllerRef.current?.abort();
              batchRef.current?.cancel();
            }}
          >
            처리 중단
          </button>
        ) : (
          <button
            type="button"
            disabled={actionableCount === 0 || policy.state === "checking" || archiving}
            onClick={() => void processItems()}
          >
            이미지 {items.length}개 압축하기
          </button>
        )}
      </div>
    </section>
  );
}

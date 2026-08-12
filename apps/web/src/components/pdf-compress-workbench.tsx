"use client";

import {
  type PdfCompressScannedJobHandle,
  type PdfCompressScannedProgress,
  type PdfCompressScannedResultV2,
  type PdfCompressScannedSpecV2,
  runPdfCompressScannedJob,
  supportsBrowserPdfCompressScannedRuntime,
} from "@hereisit/browser-runtime/pdf-compress-scanned";
import { inspectPdfFile } from "@hereisit/browser-runtime/pdf-inspection";
import type { PdfOptimizeVerificationHandle } from "@hereisit/browser-runtime/pdf-optimize-verification";
import { compressedPdfName } from "@hereisit/pdf-tool";
import type { PdfOptimizeJobHandle, PdfOptimizeJobOutcome } from "@hereisit/server-runtime";
import type { PdfInspectionHandle, PdfInspectionResult } from "@hereisit/tool-contracts";
import type { AvailableToolId } from "@hereisit/tool-registry/catalog";
import { type DragEvent, useCallback, useEffect, useRef, useState } from "react";
import { downloadUrl, formatBytes } from "../lib/files";
import {
  getOrCreateAnonymousSessionId,
  readProcessingClientConfig,
} from "../lib/processing-config";
import { reportDownloadRequested, startProductUsageRun } from "../lib/product-analytics";
import { getToolImplementation, type SourceFileLimits } from "../lib/tool-implementations";
import { usePendingToolFiles } from "../lib/use-pending-tool-files";
import styles from "./pdf-workbench.module.css";

const MAX_PAGE_COUNT = 100;
const INITIAL_MESSAGE = "파일을 선택하면 페이지를 확인할게요.";
const UNSUPPORTED_BROWSER_MESSAGE = "이 브라우저는 로컬 PDF 압축을 지원하지 않아요.";
const PAGE_LIMIT_MESSAGE = "PDF는 1페이지부터 100페이지까지 압축할 수 있어요.";
const PDF_COMPRESSION_NOTICE = getToolImplementation("pdf.compress-scanned").notices.find(
  ({ tone }) => tone === "warning",
)?.text;
if (PDF_COMPRESSION_NOTICE === undefined) {
  throw new Error("Missing PDF compression notice");
}

type Preset = PdfCompressScannedSpecV2["preset"];
type CompressionStage = "select" | "inspecting" | "setup" | "processing" | "result";
type CompressionResult =
  | ({ readonly source: "browser" } & Omit<PdfCompressScannedResultV2, "bytes">)
  | {
      readonly source: "server";
      readonly sourceByteLength: number;
      readonly byteLength: number;
      readonly suggestedName: string;
      readonly profile: "structural" | "image-optimized";
    };

type RemotePdfResult = Extract<PdfOptimizeJobOutcome, { status: "fulfilled" }>["value"];

const SERVER_DISCLOSURE = "PDF를 HereIsIt 처리 서버로 보내며, 처리가 끝나면 자동으로 삭제해요.";
const SERVER_RETRY_MESSAGE = "현재 처리 서버를 사용할 수 없어요. 잠시 후 다시 시도해 주세요.";

function isPdf(file: File): boolean {
  return file.type === "application/pdf" || (file.type === "" && /\.pdf$/i.test(file.name));
}

function presetLabel(preset: Preset): "균형 150DPI" | "최소 용량 96DPI" {
  return preset === "balanced" ? "균형 150DPI" : "최소 용량 96DPI";
}

function progressLabel(progress: PdfCompressScannedProgress | undefined): string {
  if (progress === undefined) return "압축 준비됨";
  if (progress.phase === "validating") return "압축 설정 확인 중";
  if (progress.phase === "loading") return "PDF 페이지 읽는 중";
  if (
    progress.phase === "rendering" ||
    progress.phase === "encoding" ||
    progress.phase === "assembling"
  ) {
    return `${progress.completedPages}/${progress.totalPages}페이지 다시 만드는 중`;
  }
  if (progress.phase === "serializing") return "새 PDF 만드는 중";
  return "결과 마무리 중";
}

export function PdfCompressWorkbench({ toolId }: { toolId: AvailableToolId }) {
  const implementation = getToolImplementation(toolId);
  if (
    implementation.bundleProfile !== "pdf-compress-scanned" ||
    implementation.family !== "pdf" ||
    implementation.intent !== "compress"
  ) {
    throw new Error(`PdfCompressWorkbench tool mismatch: ${toolId}`);
  }
  const sourceFileLimits: SourceFileLimits = implementation.sourceFileLimits;
  const { minFiles, maxFiles, maxFileBytes } = sourceFileLimits;
  const [file, setFile] = useState<File>();
  const [inspection, setInspection] = useState<PdfInspectionResult>();
  const [hydrated, setHydrated] = useState(false);
  const [runtimeSupported, setRuntimeSupported] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [message, setMessage] = useState(INITIAL_MESSAGE);
  const [preset, setPreset] = useState<Preset>("balanced");
  const [progress, setProgress] = useState<PdfCompressScannedProgress>();
  const [result, setResult] = useState<CompressionResult>();
  const [serverFallback, setServerFallback] = useState(false);
  const [serverMode, setServerMode] = useState(false);
  const [serverProgress, setServerProgress] = useState<number | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const stageHeadingRef = useRef<HTMLHeadingElement>(null);
  const inspectionHandleRef = useRef<PdfInspectionHandle | undefined>(undefined);
  const jobHandleRef = useRef<PdfCompressScannedJobHandle | undefined>(undefined);
  const serverJobRef = useRef<PdfOptimizeJobHandle | undefined>(undefined);
  const verificationRef = useRef<PdfOptimizeVerificationHandle | undefined>(undefined);
  const remoteResultRef = useRef<RemotePdfResult | undefined>(undefined);
  const remoteResultRunRef = useRef<number | undefined>(undefined);
  const acknowledgementRef = useRef<
    | {
        readonly remoteResult: RemotePdfResult;
        readonly runId: number;
        readonly request: Promise<void>;
      }
    | undefined
  >(undefined);
  const resultUrlRef = useRef<string | undefined>(undefined);
  const runRef = useRef(0);
  const productRunRef = useRef<ReturnType<typeof startProductUsageRun> | null>(null);
  const busy = inspecting || processing;
  const visibleMessage = hydrated && !runtimeSupported ? UNSUPPORTED_BROWSER_MESSAGE : message;

  const clearResult = useCallback((updateState = true) => {
    const resultUrl = resultUrlRef.current;
    resultUrlRef.current = undefined;
    if (resultUrl !== undefined) URL.revokeObjectURL(resultUrl);
    if (updateState) {
      setResult(undefined);
      setProgress(undefined);
    }
  }, []);

  const clearRemoteWork = useCallback(() => {
    serverJobRef.current?.cancel();
    serverJobRef.current = undefined;
    verificationRef.current?.cancel();
    verificationRef.current = undefined;
    const remoteResult = remoteResultRef.current;
    remoteResultRef.current = undefined;
    remoteResultRunRef.current = undefined;
    acknowledgementRef.current = undefined;
    if (remoteResult !== undefined) void remoteResult.dispose().catch(() => undefined);
  }, []);

  const invalidateActiveWork = useCallback(
    (updateState = true) => {
      const runId = runRef.current + 1;
      runRef.current = runId;
      inspectionHandleRef.current?.cancel();
      inspectionHandleRef.current = undefined;
      jobHandleRef.current?.cancel();
      clearRemoteWork();
      productRunRef.current?.cancelled();
      jobHandleRef.current = undefined;
      clearResult(updateState);
      if (updateState) {
        setInspecting(false);
        setProcessing(false);
        setServerFallback(false);
        setServerMode(false);
        setServerProgress(null);
      }
      return runId;
    },
    [clearRemoteWork, clearResult],
  );

  useEffect(() => {
    setHydrated(true);
    setRuntimeSupported(supportsBrowserPdfCompressScannedRuntime());
  }, []);

  useEffect(
    () => () => {
      invalidateActiveWork(false);
    },
    [invalidateActiveWork],
  );

  useEffect(() => {
    if (result?.source !== "server") return;
    const remoteResult = remoteResultRef.current;
    const runId = remoteResultRunRef.current;
    if (remoteResult === undefined || runId === undefined || runId !== runRef.current) return;
    const activeAcknowledgement = acknowledgementRef.current;
    if (
      activeAcknowledgement?.remoteResult === remoteResult &&
      activeAcknowledgement.runId === runId
    ) {
      return;
    }

    const request = remoteResult.acknowledge();
    acknowledgementRef.current = { remoteResult, runId, request };
    void request
      .then(() => {
        if (remoteResultRef.current === remoteResult && remoteResultRunRef.current === runId) {
          remoteResultRef.current = undefined;
          remoteResultRunRef.current = undefined;
        }
      })
      .catch(() => {
        // Keep the verified remote handle so reset or unmount can attempt deletion.
      })
      .finally(() => {
        if (acknowledgementRef.current?.request === request) {
          acknowledgementRef.current = undefined;
        }
      });
  }, [result]);

  const inspectSelectedFile = useCallback(
    async (nextFile: File) => {
      if (!runtimeSupported) {
        setMessage(UNSUPPORTED_BROWSER_MESSAGE);
        return;
      }

      const runId = invalidateActiveWork();
      setFile(nextFile);
      setInspection(undefined);
      setInspecting(true);
      setMessage("PDF 페이지 수를 이 기기에서 확인하고 있어요.");

      let handle: PdfInspectionHandle | undefined;
      try {
        handle = inspectPdfFile(nextFile);
        inspectionHandleRef.current = handle;
        const outcome = await handle.result;
        if (runRef.current !== runId) return;

        if (outcome.status === "fulfilled") {
          const pageCount = outcome.value.pageCount;
          if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > MAX_PAGE_COUNT) {
            setInspection(undefined);
            setMessage(PAGE_LIMIT_MESSAGE);
          } else {
            setInspection(outcome.value);
            setMessage(`${pageCount}페이지 PDF를 불러왔어요.`);
          }
        } else if (outcome.status === "cancelled") {
          setMessage("PDF 페이지 확인을 중단했어요.");
        } else {
          setMessage(outcome.error.message);
        }
      } catch {
        if (runRef.current === runId) {
          setMessage("PDF 페이지를 확인하지 못했어요. 다른 파일로 다시 시도해 주세요.");
        }
      } finally {
        if (runRef.current === runId) {
          if (inspectionHandleRef.current === handle) inspectionHandleRef.current = undefined;
          setInspecting(false);
        }
      }
    },
    [invalidateActiveWork, runtimeSupported],
  );

  const chooseFile = useCallback(
    (fileList: FileList | readonly File[]) => {
      if (!runtimeSupported) {
        setMessage(UNSUPPORTED_BROWSER_MESSAGE);
        return;
      }

      const candidates = Array.from(fileList);
      if (candidates.length < minFiles || candidates.length > maxFiles) {
        setMessage("PDF 파일 한 개만 선택해 주세요.");
        return;
      }

      const nextFile = candidates[0];
      if (nextFile === undefined || !isPdf(nextFile)) {
        setMessage("PDF 파일 한 개를 선택해 주세요.");
        return;
      }
      if (
        !Number.isSafeInteger(nextFile.size) ||
        nextFile.size < 1 ||
        nextFile.size > maxFileBytes
      ) {
        setMessage("PDF 파일은 1바이트 이상 50MB 이하여야 해요.");
        return;
      }

      void inspectSelectedFile(nextFile);
    },
    [inspectSelectedFile, maxFileBytes, maxFiles, minFiles, runtimeSupported],
  );

  usePendingToolFiles({
    toolId,
    ready: hydrated && runtimeSupported && !busy,
    acceptFiles: chooseFile,
    onReselectRequired: setMessage,
  });

  const reset = () => {
    invalidateActiveWork();
    setFile(undefined);
    setInspection(undefined);
    setPreset("balanced");
    setDragging(false);
    setMessage(INITIAL_MESSAGE);
  };

  const selectPreset = (nextPreset: Preset) => {
    if (nextPreset === preset) return;
    invalidateActiveWork();
    setPreset(nextPreset);
    setMessage(`${presetLabel(nextPreset)} 설정을 선택했어요.`);
  };

  const startProcessing = async () => {
    if (busy || !runtimeSupported || file === undefined || inspection === undefined) return;

    const selectedFile = file;
    const selectedInspection = inspection;
    const selectedPreset = preset;
    const runId = invalidateActiveWork();
    const productRun = startProductUsageRun(toolId);
    productRunRef.current = productRun;
    setProcessing(true);
    setProgress({ phase: "validating", fraction: 0 });
    setMessage("압축 설정과 파일을 확인하고 있어요.");

    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (runRef.current !== runId) return;

    let handle: PdfCompressScannedJobHandle | undefined;
    try {
      handle = runPdfCompressScannedJob(
        selectedFile,
        { version: 2, preset: selectedPreset },
        {
          expectedPageCount: selectedInspection.pageCount,
          onProgress: (event) => {
            if (runRef.current === runId) setProgress(event);
          },
        },
      );
      jobHandleRef.current = handle;
      const outcome = await handle.result;
      if (runRef.current !== runId) return;

      if (outcome.status === "fulfilled") {
        productRun.succeeded();
        const { bytes, ...resultMetadata } = outcome.value;
        const blob = new Blob([bytes], { type: "application/pdf" });
        const url = URL.createObjectURL(blob);
        resultUrlRef.current = url;
        setResult({ source: "browser", ...resultMetadata });
        setProgress({ phase: "finalizing", fraction: 1 });
        setMessage("압축 PDF를 준비했어요.");
      } else if (outcome.status === "cancelled") {
        productRun.cancelled();
        setProgress(undefined);
        setMessage("PDF 압축을 중단했어요.");
      } else {
        productRun.failed(outcome.error.code);
        setProgress(undefined);
        const noReductionMessage =
          "텍스트와 링크를 유지하면서는 용량을 1% 이상 줄이지 못했어요. 원본을 그대로 사용하는 것을 권장해요.";
        const memoryLimitMessage =
          selectedPreset === "balanced"
            ? "균형 150DPI에서는 페이지가 너무 커요. 최소 용량 96DPI로 낮춰 다시 시도해 주세요."
            : "사용 가능한 최소 96DPI에서도 이 PDF를 안전하게 처리할 수 없어요. 원본을 그대로 사용하거나 페이지 크기나 페이지 수를 줄인 PDF를 다시 준비해 주세요.";
        if (
          outcome.error.code === "NO_SIZE_REDUCTION" &&
          outcome.error.reason === "STRUCTURED_OR_MIXED"
        ) {
          setServerFallback(true);
        }
        setMessage(
          outcome.error.code === "NO_SIZE_REDUCTION"
            ? noReductionMessage
            : outcome.error.code === "MEMORY_LIMIT"
              ? memoryLimitMessage
              : outcome.error.message,
        );
      }
    } catch {
      if (runRef.current === runId) {
        productRun.failed("WORKER_CRASH");
        setProgress(undefined);
        setMessage("PDF 압축 작업기를 시작하지 못했어요. 다시 시도해 주세요.");
      }
    } finally {
      if (productRunRef.current === productRun) productRunRef.current = null;
      if (runRef.current === runId) {
        if (jobHandleRef.current === handle) jobHandleRef.current = undefined;
        setProcessing(false);
      }
    }
  };

  const startServerProcessing = async () => {
    if (busy || file === undefined || inspection === undefined || !serverFallback) return;

    const selectedFile = file;
    const selectedInspection = inspection;
    const selectedPreset = preset;
    const runId = invalidateActiveWork();
    setServerFallback(true);
    setServerMode(true);
    setServerProgress(null);
    setProcessing(true);
    setMessage("처리 서버에서 PDF를 압축하고 있어요.");

    const config = readProcessingClientConfig();
    if (config.apiOrigin === null) {
      setProcessing(false);
      setServerMode(false);
      setMessage(SERVER_RETRY_MESSAGE);
      return;
    }

    const productRun = startProductUsageRun(toolId);
    productRunRef.current = productRun;
    let remoteResult: RemotePdfResult | undefined;
    let analyticsSettled = false;
    try {
      const [{ runPdfOptimizeJob }, { verifyPdfOptimizeResult }] = await Promise.all([
        import("@hereisit/server-runtime"),
        import("@hereisit/browser-runtime/pdf-optimize-verification"),
      ]);
      if (runRef.current !== runId) return;
      const handle = runPdfOptimizeJob(
        selectedFile,
        { version: 1, preset: selectedPreset },
        {
          apiOrigin: config.apiOrigin,
          anonymousSessionId: getOrCreateAnonymousSessionId(),
          pageCount: selectedInspection.pageCount,
          onProgress: (event) => {
            if (runRef.current === runId) {
              setServerProgress(event.fraction);
              setMessage(
                event.phase === "verifying"
                  ? "처리 결과를 확인하고 있어요."
                  : "처리 서버에서 PDF를 압축하고 있어요.",
              );
            }
          },
        },
      );
      serverJobRef.current = handle;
      const outcome = await handle.result;
      if (serverJobRef.current === handle) serverJobRef.current = undefined;
      if (runRef.current !== runId) {
        if (outcome.status === "fulfilled") await outcome.value.dispose().catch(() => undefined);
        return;
      }
      if (outcome.status === "original-retained") {
        productRun.succeeded();
        analyticsSettled = true;
        setMessage("처리 서버에서도 더 줄이지 못해 원본을 그대로 유지해요.");
        return;
      }
      if (outcome.status === "cancelled") {
        productRun.cancelled();
        analyticsSettled = true;
        setMessage("PDF 압축을 중단했어요.");
        return;
      }
      if (outcome.status === "rejected") {
        productRun.failed(outcome.error.code);
        analyticsSettled = true;
        setMessage(SERVER_RETRY_MESSAGE);
        return;
      }

      remoteResult = outcome.value;
      remoteResultRef.current = remoteResult;
      remoteResultRunRef.current = runId;
      setMessage("다운로드 전에 PDF 결과를 확인하고 있어요.");
      const resultFile = new File([remoteResult.blob], "result.pdf", {
        type: "application/pdf",
      });
      const verification = verifyPdfOptimizeResult(
        selectedFile,
        resultFile,
        remoteResult.descriptor,
      );
      verificationRef.current = verification;
      const verified = await verification.result;
      if (verificationRef.current === verification) verificationRef.current = undefined;
      if (runRef.current !== runId) {
        if (remoteResultRef.current === remoteResult) {
          await remoteResult.dispose().catch(() => undefined);
          remoteResultRef.current = undefined;
          remoteResultRunRef.current = undefined;
        }
        return;
      }
      if (verified.status !== "fulfilled") {
        if (verified.status === "cancelled") productRun.cancelled();
        else productRun.failed(verified.error.code);
        analyticsSettled = true;
        await remoteResult.dispose().catch(() => undefined);
        if (remoteResultRef.current === remoteResult) {
          remoteResultRef.current = undefined;
          remoteResultRunRef.current = undefined;
        }
        setMessage("PDF 결과를 확인하지 못했어요. 잠시 후 다시 시도해 주세요.");
        return;
      }

      const url = URL.createObjectURL(verified.value.blob);
      resultUrlRef.current = url;
      setResult({
        source: "server",
        sourceByteLength: verified.value.descriptor.sourceByteLength,
        byteLength: verified.value.descriptor.byteLength,
        suggestedName: compressedPdfName(selectedFile.name),
        profile: verified.value.descriptor.profile,
      });
      productRun.succeeded();
      analyticsSettled = true;
      setMessage("압축 PDF를 준비했어요.");
    } catch {
      if (!analyticsSettled) productRun.failed("WORKER_CRASH");
      if (remoteResult !== undefined) {
        await remoteResult.dispose().catch(() => undefined);
        if (remoteResultRef.current === remoteResult) {
          remoteResultRef.current = undefined;
          remoteResultRunRef.current = undefined;
        }
      }
      if (runRef.current === runId) setMessage(SERVER_RETRY_MESSAGE);
    } finally {
      if (productRunRef.current === productRun) productRunRef.current = null;
      if (runRef.current === runId) {
        setProcessing(false);
        setServerMode(false);
      }
    }
  };

  const cancelProcessing = () => {
    const keepServerFallback = serverMode;
    invalidateActiveWork();
    if (keepServerFallback) setServerFallback(true);
    setMessage("PDF 압축을 중단했어요.");
  };

  const cancelInspection = () => {
    invalidateActiveWork();
    setInspection(undefined);
    setMessage("PDF 페이지 확인을 중단했어요.");
  };

  const downloadResult = () => {
    const resultUrl = resultUrlRef.current;
    if (result === undefined || resultUrl === undefined) return;
    try {
      reportDownloadRequested(toolId);
      downloadUrl(resultUrl, result.suggestedName);
      setMessage("다운로드를 시작했어요.");
    } catch {
      setMessage("다운로드를 시작하지 못했어요. 다시 시도해 주세요.");
    }
  };

  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragging(false);
    if (!busy) chooseFile(event.dataTransfer.files);
  };

  const pageCount = inspection?.pageCount;
  const runLabel = pageCount === undefined ? "PDF 용량 줄이기" : `${pageCount}페이지 용량 줄이기`;
  const progressText = serverMode ? "처리 서버에서 압축 중" : progressLabel(progress);
  const progressPercent = serverMode
    ? serverProgress === null
      ? undefined
      : Math.round(serverProgress * 100)
    : Math.round((progress?.fraction ?? 0) * 100);
  const savings =
    result === undefined
      ? undefined
      : Math.round(((result.sourceByteLength - result.byteLength) / result.sourceByteLength) * 100);
  const stage: CompressionStage =
    result !== undefined
      ? "result"
      : processing
        ? "processing"
        : inspecting
          ? "inspecting"
          : inspection !== undefined
            ? "setup"
            : "select";

  useEffect(() => {
    if (stage !== "select") stageHeadingRef.current?.focus();
  }, [stage]);

  return (
    <section
      className={styles.shell}
      data-server-fallback="hereisit-server-runtime"
      aria-labelledby="pdf-compress-workbench-title"
    >
      <input
        ref={inputRef}
        className={styles.hiddenInput}
        type="file"
        accept="application/pdf,.pdf"
        tabIndex={-1}
        disabled={!hydrated || busy || !runtimeSupported}
        onChange={(event) => {
          if (event.target.files !== null) chooseFile(event.target.files);
          event.target.value = "";
        }}
      />

      {stage === "select" ? (
        <section
          className={`${styles.emptyDropzone} ${dragging ? styles.dragging : ""}`}
          aria-labelledby="pdf-compress-workbench-title"
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
          <div className={styles.dropCopy}>
            <h2 id="pdf-compress-workbench-title">PDF 용량 줄이기</h2>
            <p>PDF 1개 · 최대 50MB · 최대 100페이지</p>
          </div>
          <div className={styles.dropActions}>
            <button
              className={styles.mergePrimaryAction}
              type="button"
              disabled={!hydrated || !runtimeSupported}
              onClick={() => inputRef.current?.click()}
            >
              PDF 선택
            </button>
            <p className={styles.status} role="status" aria-live="polite" aria-atomic="true">
              {visibleMessage}
            </p>
          </div>
          <div className={styles.localBadge}>
            <span aria-hidden="true">✓</span>
            <span>파일은 이 기기에서만 처리돼요.</span>
          </div>
        </section>
      ) : stage === "inspecting" ? (
        <section className={`${styles.mergeStage} ${styles.mergeProgress}`}>
          <h2 id="pdf-compress-workbench-title" ref={stageHeadingRef} tabIndex={-1}>
            PDF 확인하는 중
          </h2>
          <p role="status" aria-live="polite" aria-atomic="true">
            {visibleMessage}
          </p>
          <button className={styles.mergeSecondaryAction} type="button" onClick={cancelInspection}>
            중단
          </button>
        </section>
      ) : stage === "setup" && file !== undefined && inspection !== undefined ? (
        <section
          className={`${styles.mergeSetup} ${styles.compressionSetup}`}
          aria-label="PDF 압축 설정"
        >
          <header className={styles.mergeSetupHeader}>
            <div>
              <h2 id="pdf-compress-workbench-title" ref={stageHeadingRef} tabIndex={-1}>
                압축 수준 선택
              </h2>
            </div>
            <div className={styles.mergeHeaderActions}>
              <button type="button" onClick={() => inputRef.current?.click()}>
                PDF 교체
              </button>
            </div>
          </header>

          <div className={styles.splitFileSummary}>
            <strong>{file.name}</strong>
            <span>{formatBytes(file.size)}</span>
            <span>{inspection.pageCount}페이지</span>
          </div>

          <fieldset className={styles.splitOptions}>
            <legend>압축 수준</legend>
            <label>
              <input
                type="radio"
                name="pdf-compress-preset"
                checked={preset === "balanced"}
                onChange={() => selectPreset("balanced")}
              />
              <span>
                <strong>균형 150DPI · 추천</strong>
                <small>글자 가독성과 용량의 균형을 맞춰요.</small>
              </span>
            </label>
            <label>
              <input
                type="radio"
                name="pdf-compress-preset"
                checked={preset === "minimum"}
                onChange={() => selectPreset("minimum")}
              />
              <span>
                <strong>최소 용량 96DPI</strong>
                <small>더 작게 만들지만 작은 글자가 흐려질 수 있어요.</small>
              </span>
            </label>
          </fieldset>

          <p className={styles.compressionSetupWarning}>{PDF_COMPRESSION_NOTICE}</p>

          {serverFallback ? (
            <div className={styles.compressionServerFallback}>
              <p>{SERVER_DISCLOSURE}</p>
              <button
                className={styles.mergePrimaryAction}
                type="button"
                onClick={() => void startServerProcessing()}
              >
                처리 서버에서 더 압축
              </button>
            </div>
          ) : null}

          <footer className={styles.mergeSetupFooter}>
            <p className={styles.mergeStatus} role="status" aria-live="polite" aria-atomic="true">
              {visibleMessage}
            </p>
            <button
              className={styles.mergePrimaryAction}
              type="button"
              onClick={() => void startProcessing()}
            >
              {runLabel}
            </button>
          </footer>
        </section>
      ) : stage === "processing" ? (
        <section className={`${styles.mergeStage} ${styles.mergeProgress}`}>
          <h2 id="pdf-compress-workbench-title" ref={stageHeadingRef} tabIndex={-1}>
            {serverMode ? "처리 서버에서 PDF 용량 줄이는 중" : "PDF 용량 줄이는 중"}
          </h2>
          <p>{progressText}</p>
          <div
            className={styles.mergeProgressTrack}
            role="progressbar"
            aria-label="PDF 압축 진행률"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progressPercent}
            aria-valuetext={progressText}
          >
            <span style={{ width: `${progressPercent ?? 8}%` }} />
          </div>
          <p className={styles.mergeStatus} role="status" aria-live="polite" aria-atomic="true">
            {visibleMessage}
          </p>
          <button className={styles.mergeSecondaryAction} type="button" onClick={cancelProcessing}>
            중단
          </button>
        </section>
      ) : result !== undefined && savings !== undefined ? (
        <section
          className={`${styles.mergeStage} ${styles.mergeResult}`}
          aria-label="PDF 압축 결과"
        >
          <div className={styles.mergeResultMark} aria-hidden="true">
            ✓
          </div>
          <h2 id="pdf-compress-workbench-title" ref={stageHeadingRef} tabIndex={-1}>
            용량 줄이기 완료
          </h2>
          <strong className={styles.mergeSizeComparison}>
            {formatBytes(result.sourceByteLength)} → {formatBytes(result.byteLength)}
          </strong>
          <p className={styles.compressionSavings}>{savings}% 줄었어요</p>
          <p className={styles.compressionResultNote}>
            {result.source === "server"
              ? result.profile === "structural"
                ? "처리 서버에서 문서 구조를 유지하며 압축했어요."
                : "처리 서버에서 이미지 품질과 용량을 조정했어요."
              : result.mode === "structure-preserving"
                ? "텍스트와 링크를 유지했어요."
                : "스캔 페이지를 가볍게 다시 만들었어요."}
          </p>
          <button className={styles.mergePrimaryAction} type="button" onClick={downloadResult}>
            PDF 다운로드 ↓
          </button>
          <p
            className={styles.mergeResultStatus}
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {visibleMessage}
          </p>
          <button className={styles.mergeTextAction} type="button" onClick={reset}>
            다른 PDF 압축
          </button>
        </section>
      ) : null}
    </section>
  );
}

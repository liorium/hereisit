"use client";

import { inspectPdfFile } from "@hereisit/browser-runtime/pdf-inspection";
import {
  type PdfToImagesJobHandle,
  type PdfToImagesProgress,
  type PdfToImagesResult,
  type PdfToImagesSpecV1,
  runPdfToImagesJob,
  supportsBrowserPdfToImagesRuntime,
} from "@hereisit/browser-runtime/pdf-to-images";
import {
  PdfToImagesPlanError,
  parseOrderedPageSelection,
  planPdfToImagesRasterization,
} from "@hereisit/pdf-tool";
import type { PdfInspectionHandle, PdfInspectionResult } from "@hereisit/tool-contracts";
import type { AvailableToolId } from "@hereisit/tool-registry/catalog";
import { type DragEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { downloadUrl, formatBytes } from "../lib/files";
import { reportDownloadRequested, startProductUsageRun } from "../lib/product-analytics";
import { getToolImplementation, type SourceFileLimits } from "../lib/tool-implementations";
import { usePendingToolFiles } from "../lib/use-pending-tool-files";
import styles from "./pdf-to-image-workbench.module.css";

const UNSUPPORTED_BROWSER_MESSAGE =
  "이 브라우저에서는 PDF를 이미지로 변환할 수 없어요. 최신 Safari, Chrome, Firefox 또는 Edge를 사용해 주세요.";

type SelectionMode = "every-page" | "extract";
type OutputFormat = "jpeg" | "png";
type Dpi = 96 | 150 | 300;

type Preflight =
  | {
      ok: true;
      spec: PdfToImagesSpecV1;
      outputCount: number;
    }
  | {
      ok: false;
      message: string;
    };

function isPdf(file: File): boolean {
  return file.type === "application/pdf" || (file.type === "" && /\.pdf$/i.test(file.name));
}

function progressLabel(progress: PdfToImagesProgress | undefined): string {
  if (progress === undefined) return "변환 준비됨";
  if (progress.phase === "validating") return "변환 설정 확인 중";
  if (progress.phase === "loading") return "PDF 페이지 읽는 중";
  if (progress.phase === "rendering") {
    return `${progress.completedPages}/${progress.totalPages}페이지 렌더링 중`;
  }
  if (progress.phase === "encoding") {
    return `${progress.completedPages}/${progress.totalPages}페이지 인코딩 중`;
  }
  if (progress.phase === "archiving") return "ZIP 파일 만드는 중";
  return "결과 마무리 중";
}

export function PdfToImageWorkbench({ toolId }: { toolId: AvailableToolId }) {
  const implementation = getToolImplementation(toolId);
  if (
    implementation.bundleProfile !== "pdf-to-images" ||
    implementation.family !== "pdf" ||
    implementation.intent !== "to-image"
  ) {
    throw new Error(`PdfToImageWorkbench tool mismatch: ${toolId}`);
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
  const [message, setMessage] = useState("파일을 선택하면 페이지를 확인할게요.");
  const [selectionMode, setSelectionMode] = useState<SelectionMode>("every-page");
  const [pageRange, setPageRange] = useState("1-3, 5");
  const [format, setFormat] = useState<OutputFormat>("jpeg");
  const [dpi, setDpi] = useState<Dpi>(150);
  const [quality, setQuality] = useState(85);
  const [progress, setProgress] = useState<PdfToImagesProgress>();
  const [result, setResult] = useState<PdfToImagesResult>();
  const [resultUrl, setResultUrl] = useState<string>();

  const inputRef = useRef<HTMLInputElement>(null);
  const stageTitleRef = useRef<HTMLHeadingElement>(null);
  const inspectionHandleRef = useRef<PdfInspectionHandle | undefined>(undefined);
  const jobHandleRef = useRef<PdfToImagesJobHandle | undefined>(undefined);
  const resultUrlRef = useRef<string | undefined>(undefined);
  const runRef = useRef(0);
  const productRunRef = useRef<ReturnType<typeof startProductUsageRun> | null>(null);
  const busy = inspecting || processing;

  const parsedPageRange = useMemo(
    () => parseOrderedPageSelection(pageRange, inspection?.pageCount),
    [inspection?.pageCount, pageRange],
  );

  const preflight = useMemo<Preflight | undefined>(() => {
    if (inspection === undefined) return undefined;

    let selection: PdfToImagesSpecV1["selection"] = { mode: "every-page" };
    if (selectionMode === "extract") {
      if (!parsedPageRange.ok) return { ok: false, message: parsedPageRange.message };
      selection = { mode: "extract", pages: [...parsedPageRange.pages] };
    }

    const spec: PdfToImagesSpecV1 = {
      version: 1,
      selection,
      output:
        format === "jpeg"
          ? { format: "jpeg", quality, background: "#ffffff" }
          : { format: "png", background: "#ffffff" },
      dpi,
    };

    try {
      const plan = planPdfToImagesRasterization(inspection, spec);
      return { ok: true, spec, outputCount: plan.pages.length };
    } catch (error) {
      return {
        ok: false,
        message:
          error instanceof PdfToImagesPlanError
            ? error.message
            : "PDF 페이지 크기를 확인할 수 없어요. 다른 PDF를 선택해 주세요.",
      };
    }
  }, [dpi, format, inspection, parsedPageRange, quality, selectionMode]);

  const revokeResultUrl = useCallback(() => {
    if (resultUrlRef.current !== undefined) {
      URL.revokeObjectURL(resultUrlRef.current);
      resultUrlRef.current = undefined;
    }
    setResultUrl(undefined);
  }, []);

  const clearResult = useCallback(() => {
    revokeResultUrl();
    setResult(undefined);
    setProgress(undefined);
  }, [revokeResultUrl]);

  const invalidateActiveWork = useCallback(() => {
    const runId = runRef.current + 1;
    runRef.current = runId;
    inspectionHandleRef.current?.cancel();
    inspectionHandleRef.current = undefined;
    jobHandleRef.current?.cancel();
    productRunRef.current?.cancelled();
    jobHandleRef.current = undefined;
    setInspecting(false);
    setProcessing(false);
    clearResult();
    return runId;
  }, [clearResult]);

  useEffect(() => {
    setHydrated(true);
    setRuntimeSupported(supportsBrowserPdfToImagesRuntime());
  }, []);

  useEffect(
    () => () => {
      runRef.current += 1;
      inspectionHandleRef.current?.cancel();
      jobHandleRef.current?.cancel();
      productRunRef.current?.cancelled();
      if (resultUrlRef.current !== undefined) URL.revokeObjectURL(resultUrlRef.current);
    },
    [],
  );

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
      setMessage("PDF 페이지 수와 크기를 기기 안에서 확인하고 있어요.");

      let handle: PdfInspectionHandle | undefined;
      try {
        handle = inspectPdfFile(nextFile);
        inspectionHandleRef.current = handle;
        const outcome = await handle.result;
        if (runRef.current !== runId) return;

        if (outcome.status === "fulfilled") {
          setInspection(outcome.value);
          setMessage(`${outcome.value.pageCount}페이지 PDF를 불러왔어요.`);
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
    setSelectionMode("every-page");
    setPageRange("1-3, 5");
    setFormat("jpeg");
    setDpi(150);
    setQuality(85);
    setDragging(false);
    setMessage("파일을 선택하면 페이지를 확인할게요.");
  };

  const applySettingChange = (description: string) => {
    invalidateActiveWork();
    setMessage(description);
  };

  const startProcessing = async () => {
    if (busy || !runtimeSupported || file === undefined || preflight?.ok !== true) return;

    const selectedFile = file;
    const spec = preflight.spec;
    const runId = invalidateActiveWork();
    const productRun = startProductUsageRun(toolId);
    productRunRef.current = productRun;
    setProcessing(true);
    setProgress({ phase: "validating", fraction: 0 });
    setMessage("변환 설정과 파일을 확인하고 있어요.");

    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (runRef.current !== runId) return;

    let handle: PdfToImagesJobHandle | undefined;
    try {
      handle = runPdfToImagesJob(selectedFile, spec, {
        onProgress: (event) => {
          if (runRef.current !== runId) return;
          setProgress((current) =>
            current !== undefined && event.fraction < current.fraction
              ? { ...event, fraction: current.fraction }
              : event,
          );
        },
      });
      jobHandleRef.current = handle;
      const outcome = await handle.result;
      if (runRef.current !== runId) return;

      if (outcome.status === "fulfilled") {
        productRun.succeeded();
        const blob = new Blob([outcome.value.bytes], { type: outcome.value.mime });
        const url = URL.createObjectURL(blob);
        resultUrlRef.current = url;
        setResultUrl(url);
        setResult({ ...outcome.value, bytes: new ArrayBuffer(0) });
        setProgress({ phase: "finalizing", fraction: 1 });
        setMessage(
          outcome.value.outputFileCount === 1
            ? "이미지 한 장을 준비했어요."
            : `${outcome.value.outputFileCount}개 이미지를 ZIP으로 준비했어요.`,
        );
      } else if (outcome.status === "cancelled") {
        productRun.cancelled();
        setProgress(undefined);
        setMessage("이미지 변환을 중단했어요.");
      } else {
        productRun.failed(outcome.error.code);
        setProgress(undefined);
        setMessage(outcome.error.message);
      }
    } catch {
      if (runRef.current === runId) {
        productRun.failed("WORKER_CRASH");
        setProgress(undefined);
        setMessage("PDF 이미지 변환 작업기를 시작하지 못했어요. 다시 시도해 주세요.");
      }
    } finally {
      if (productRunRef.current === productRun) productRunRef.current = null;
      if (runRef.current === runId) {
        if (jobHandleRef.current === handle) jobHandleRef.current = undefined;
        setProcessing(false);
      }
    }
  };

  const cancelProcessing = () => {
    invalidateActiveWork();
    setMessage("이미지 변환을 중단했어요.");
  };

  const cancelInspection = () => {
    invalidateActiveWork();
    setInspection(undefined);
    setMessage("PDF 페이지 확인을 중단했어요.");
  };

  const downloadResult = () => {
    const currentUrl = resultUrlRef.current;
    if (result === undefined || resultUrl === undefined || currentUrl !== resultUrl) return;
    try {
      reportDownloadRequested(toolId);
      downloadUrl(resultUrl, result.suggestedName);
      setMessage(
        result.outputFileCount === 1 ? "다운로드를 시작했어요." : "ZIP 다운로드를 시작했어요.",
      );
    } catch {
      setMessage("다운로드를 시작하지 못했어요. 다시 시도해 주세요.");
    }
  };

  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragging(false);
    if (!busy) chooseFile(event.dataTransfer.files);
  };

  const screen =
    result !== undefined
      ? "result"
      : processing
        ? "processing"
        : inspecting
          ? "inspecting"
          : file !== undefined && inspection !== undefined
            ? "setup"
            : "select";
  const progressPercent = Math.round((progress?.fraction ?? 0) * 100);
  const validationMessage = preflight?.ok === false ? preflight.message : message;
  const runLabel =
    preflight?.ok === true ? `${preflight.outputCount}페이지 이미지로 변환` : "PDF를 이미지로 변환";
  const outputLabel = result?.format === "png" ? "PNG" : "JPG";
  const downloadLabel =
    result?.mime === "application/zip" ? "ZIP 다운로드 ↓" : `${outputLabel} 다운로드 ↓`;
  const selectionSummary =
    selectionMode === "every-page"
      ? "모든 페이지"
      : parsedPageRange.ok
        ? `지정 ${parsedPageRange.pages.length}페이지`
        : "지정 페이지";

  useEffect(() => {
    stageTitleRef.current?.focus({ preventScroll: screen !== "select" });
  }, [screen]);

  return (
    <section className={styles.shell} aria-labelledby="pdf-to-image-workbench-title">
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

      {screen === "select" ? (
        <section
          className={`${styles.stage} ${styles.selectStage} ${dragging ? styles.dragging : ""}`}
          aria-labelledby="pdf-to-image-workbench-title"
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
          <h2 id="pdf-to-image-workbench-title" ref={stageTitleRef} tabIndex={-1}>
            PDF를 JPG·PNG로 변환
          </h2>
          <p>PDF를 페이지별 이미지로 바꿔요.</p>
          <button
            className={styles.primaryButton}
            type="button"
            disabled={!hydrated || !runtimeSupported}
            onClick={() => inputRef.current?.click()}
          >
            PDF 선택
          </button>
          <p className={styles.status} role="status" aria-live="polite" aria-atomic="true">
            {!hydrated
              ? "PDF 이미지 변환 도구를 준비하고 있어요…"
              : runtimeSupported
                ? message
                : UNSUPPORTED_BROWSER_MESSAGE}
          </p>
          <p className={styles.localNotice}>파일은 업로드하지 않고 이 기기에서 처리해요.</p>
        </section>
      ) : null}

      {screen === "inspecting" && file !== undefined ? (
        <section className={`${styles.stage} ${styles.centerStage}`}>
          <h2 id="pdf-to-image-workbench-title" ref={stageTitleRef} tabIndex={-1}>
            페이지 확인 중
          </h2>
          <p>{formatBytes(file.size)} PDF를 기기 안에서 확인하고 있어요.</p>
          <div className={styles.progressTrack} aria-hidden="true">
            <span className={styles.indeterminate} />
          </div>
          <button className={styles.secondaryButton} type="button" onClick={cancelInspection}>
            페이지 확인 중단
          </button>
          <p className={styles.status} role="status" aria-live="polite" aria-atomic="true">
            {message}
          </p>
        </section>
      ) : null}

      {screen === "setup" && file !== undefined && inspection !== undefined ? (
        <section className={`${styles.stage} ${styles.setupStage}`}>
          <header className={styles.stageHeader}>
            <div>
              <h2 id="pdf-to-image-workbench-title" ref={stageTitleRef} tabIndex={-1}>
                변환 설정
              </h2>
              <p>{inspection.pageCount}페이지 · 썸네일 없이 크기만 확인했어요.</p>
            </div>
            <button className={styles.textButton} type="button" onClick={reset}>
              다른 PDF
            </button>
          </header>

          <fieldset className={styles.formatGroup}>
            <legend>출력 형식</legend>
            <div>
              <label>
                <input
                  type="radio"
                  name="pdf-to-image-format"
                  checked={format === "jpeg"}
                  onChange={() => {
                    applySettingChange("JPG로 변환해요.");
                    setFormat("jpeg");
                  }}
                />
                JPG
              </label>
              <label>
                <input
                  type="radio"
                  name="pdf-to-image-format"
                  checked={format === "png"}
                  onChange={() => {
                    applySettingChange("PNG로 변환해요.");
                    setFormat("png");
                  }}
                />
                PNG
              </label>
            </div>
          </fieldset>

          <p className={styles.recommended}>
            {format === "jpeg" ? "JPG" : "PNG"} · {dpi}DPI
          </p>

          <details
            className={styles.settings}
            open={selectionMode === "extract" || dpi !== 150 || quality !== 85}
          >
            <summary>
              페이지·화질 설정 · {selectionSummary} · {dpi}DPI
            </summary>
            <div className={styles.settingsBody}>
              <fieldset className={styles.optionGroup}>
                <legend>변환할 페이지</legend>
                <label>
                  <input
                    type="radio"
                    name="pdf-to-image-pages"
                    checked={selectionMode === "every-page"}
                    onChange={() => {
                      applySettingChange("모든 PDF 페이지를 이미지로 변환해요.");
                      setSelectionMode("every-page");
                    }}
                  />
                  모든 페이지
                </label>
                <label>
                  <input
                    type="radio"
                    name="pdf-to-image-pages"
                    checked={selectionMode === "extract"}
                    onChange={() => {
                      applySettingChange("입력한 페이지만 이미지로 변환해요.");
                      setSelectionMode("extract");
                    }}
                  />
                  지정 페이지
                </label>
                {selectionMode === "extract" ? (
                  <div className={styles.rangeField}>
                    <label htmlFor="pdf-to-image-page-range">페이지 범위</label>
                    <input
                      id="pdf-to-image-page-range"
                      type="text"
                      value={pageRange}
                      aria-invalid={!parsedPageRange.ok || preflight?.ok === false}
                      aria-describedby="pdf-to-image-page-range-help"
                      onChange={(event) => {
                        applySettingChange("페이지 범위를 바꿨어요.");
                        setPageRange(event.target.value);
                      }}
                    />
                    <small id="pdf-to-image-page-range-help">
                      {!parsedPageRange.ok
                        ? parsedPageRange.message
                        : preflight?.ok === false
                          ? preflight.message
                          : `${parsedPageRange.pages.length}페이지를 선택했어요.`}
                    </small>
                  </div>
                ) : null}
              </fieldset>

              <fieldset className={styles.segmentGroup}>
                <legend>해상도</legend>
                <div>
                  {([96, 150, 300] as const).map((option) => (
                    <label key={option}>
                      <input
                        type="radio"
                        name="pdf-to-image-dpi"
                        checked={dpi === option}
                        onChange={() => {
                          applySettingChange(`${option}DPI로 변환해요.`);
                          setDpi(option);
                        }}
                      />
                      {option}DPI
                    </label>
                  ))}
                </div>
              </fieldset>

              {format === "jpeg" ? (
                <fieldset className={styles.qualityGroup}>
                  <legend>JPG 품질 {quality}</legend>
                  <input
                    type="range"
                    min={40}
                    max={95}
                    step={1}
                    value={quality}
                    aria-label={`JPG 품질 ${quality}`}
                    aria-valuetext={`${quality}`}
                    onChange={(event) => {
                      applySettingChange("JPG 품질을 바꿨어요.");
                      setQuality(Number(event.target.value));
                    }}
                  />
                  <div aria-hidden="true">
                    <span>40</span>
                    <span>95</span>
                  </div>
                </fieldset>
              ) : null}
            </div>
          </details>

          <p
            id="pdf-to-image-validation"
            className={preflight?.ok === false ? styles.validationError : styles.status}
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {validationMessage}
          </p>
          <button
            className={styles.primaryButton}
            type="button"
            disabled={preflight?.ok !== true || !runtimeSupported}
            aria-describedby="pdf-to-image-validation"
            onClick={() => void startProcessing()}
          >
            {runLabel}
          </button>
          <p className={styles.localNotice}>파일은 업로드하지 않아요.</p>
        </section>
      ) : null}

      {screen === "processing" ? (
        <section className={`${styles.stage} ${styles.centerStage}`}>
          <h2 id="pdf-to-image-workbench-title" ref={stageTitleRef} tabIndex={-1}>
            이미지로 변환하는 중
          </h2>
          <p>{progressLabel(progress)}</p>
          <div
            className={styles.progressTrack}
            role="progressbar"
            aria-label="PDF 이미지 변환 진행률"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progressPercent}
            aria-valuetext={progressLabel(progress)}
          >
            <span style={{ width: `${progressPercent}%` }} />
          </div>
          <button className={styles.secondaryButton} type="button" onClick={cancelProcessing}>
            작업 중단
          </button>
          <p className={styles.status} role="status" aria-live="polite" aria-atomic="true">
            {message}
          </p>
        </section>
      ) : null}

      {screen === "result" && result !== undefined ? (
        <section className={`${styles.stage} ${styles.resultStage}`}>
          <span className={styles.resultMark} aria-hidden="true">
            ✓
          </span>
          <h2 id="pdf-to-image-workbench-title" ref={stageTitleRef} tabIndex={-1}>
            변환 완료
          </h2>
          <strong>
            PDF {result.sourcePageCount}페이지 → {result.outputFileCount}개 {outputLabel}
          </strong>
          <p className={styles.resultSize}>{formatBytes(result.byteLength)}</p>
          <p className={styles.warning}>이미지로 변환하면 텍스트를 검색하거나 선택할 수 없어요.</p>
          <div className={styles.actions}>
            <button className={styles.primaryButton} type="button" onClick={downloadResult}>
              {downloadLabel}
            </button>
            <button className={styles.secondaryButton} type="button" onClick={reset}>
              다른 PDF 변환
            </button>
          </div>
          <p className={styles.status} role="status" aria-live="polite" aria-atomic="true">
            {message}
          </p>
        </section>
      ) : null}
    </section>
  );
}

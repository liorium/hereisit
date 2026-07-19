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
import { downloadUrl, formatBytes, formatDuration } from "../lib/files";
import { getToolImplementation, type SourceFileLimits } from "../lib/tool-implementations";
import { usePendingToolFiles } from "../lib/use-pending-tool-files";
import styles from "./pdf-workbench.module.css";

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
  const inspectionHandleRef = useRef<PdfInspectionHandle | undefined>(undefined);
  const jobHandleRef = useRef<PdfToImagesJobHandle | undefined>(undefined);
  const resultUrlRef = useRef<string | undefined>(undefined);
  const runRef = useRef(0);
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
        setProgress(undefined);
        setMessage("이미지 변환을 중단했어요.");
      } else {
        setProgress(undefined);
        setMessage(outcome.error.message);
      }
    } catch {
      if (runRef.current === runId) {
        setProgress(undefined);
        setMessage("PDF 이미지 변환 작업기를 시작하지 못했어요. 다시 시도해 주세요.");
      }
    } finally {
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

  const progressText = result !== undefined ? "변환 완료" : progressLabel(progress);
  const progressPercent = result !== undefined ? 100 : Math.round((progress?.fraction ?? 0) * 100);
  const validationMessage = inspecting
    ? "PDF 페이지 확인이 끝나면 변환할 수 있어요."
    : preflight === undefined
      ? message
      : preflight.ok
        ? `${preflight.outputCount}페이지를 ${dpi}DPI ${format === "jpeg" ? "JPG" : "PNG"}로 변환할 준비가 됐어요.`
        : preflight.message;
  const runLabel =
    preflight?.ok === true
      ? `${preflight.outputCount}페이지 이미지로 변환하기 →`
      : "PDF를 이미지로 변환하기 →";

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

      {file === undefined ? (
        <section
          className={`${styles.emptyDropzone} ${dragging ? styles.dragging : ""}`}
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
          <div className={styles.dropIcon} aria-hidden="true">
            <span>＋</span>
          </div>
          <div className={styles.dropCopy}>
            <p className={styles.eyebrow}>LOCAL PDF TO IMAGE</p>
            <h2 id="pdf-to-image-workbench-title">변환할 PDF를 놓거나 선택하세요</h2>
            <p>PDF 한 개 · 1바이트–50MB · 최대 100페이지 출력</p>
          </div>
          <div className={styles.dropActions}>
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
          </div>
          <div className={styles.localBadge}>
            <span aria-hidden="true">✓</span> 업로드 없음 · 내 기기에서 처리
          </div>
        </section>
      ) : (
        <div className={styles.workbench}>
          <div className={styles.workbenchHeader}>
            <div>
              <p className={styles.eyebrow}>LOCAL PDF TO IMAGE</p>
              <h2 id="pdf-to-image-workbench-title">PDF 이미지 변환 작업대</h2>
            </div>
            <div className={styles.headerActions}>
              <button type="button" onClick={() => inputRef.current?.click()} disabled={busy}>
                PDF 교체
              </button>
              <button type="button" onClick={reset} disabled={busy}>
                처음부터
              </button>
            </div>
          </div>

          <div className={styles.workspace}>
            <section className={styles.filePanel} aria-label="선택한 PDF">
              <div className={styles.panelTitle}>
                <strong>선택한 PDF</strong>
                <span>1</span>
              </div>
              <div className={styles.fileList}>
                <article className={styles.fileRow}>
                  <span className={styles.fileIndex}>01</span>
                  <div className={styles.fileCopy}>
                    <strong>{file.name}</strong>
                    <span>{formatBytes(file.size)}</span>
                  </div>
                </article>
              </div>
              <div className={styles.inspectionCard}>
                <strong>{inspecting ? "페이지 확인 중…" : "PDF 정보"}</strong>
                <p>
                  {inspection !== undefined
                    ? `${inspection.pageCount}페이지 · 썸네일 없이 크기만 확인했어요.`
                    : "페이지 수와 크기를 기기 안에서만 확인해요."}
                </p>
              </div>
              <p className={styles.fileTotal}>선택 {formatBytes(file.size)} · 한도 50MB</p>
            </section>

            <aside className={styles.settingsPanel} aria-label="PDF 이미지 변환 설정">
              <div className={styles.panelTitle}>
                <strong>설정</strong>
                <span>LOCAL</span>
              </div>

              <div className={styles.toImageSettings}>
                <fieldset className={styles.optionGroup}>
                  <legend>변환할 페이지</legend>
                  <label>
                    <input
                      type="radio"
                      name="pdf-to-image-pages"
                      checked={selectionMode === "every-page"}
                      disabled={busy}
                      onChange={() => {
                        applySettingChange("모든 PDF 페이지를 이미지로 변환해요.");
                        setSelectionMode("every-page");
                      }}
                    />
                    <span>
                      <strong>모든 페이지</strong>
                      <small>PDF 전체를 페이지 순서대로 변환</small>
                    </span>
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="pdf-to-image-pages"
                      checked={selectionMode === "extract"}
                      disabled={busy}
                      onChange={() => {
                        applySettingChange("입력한 페이지만 이미지로 변환해요.");
                        setSelectionMode("extract");
                      }}
                    />
                    <span>
                      <strong>지정 페이지</strong>
                      <small>예: 1-3, 5 형식으로 필요한 페이지만 선택</small>
                    </span>
                  </label>
                  {selectionMode === "extract" ? (
                    <div className={styles.rangeField}>
                      <label htmlFor="pdf-to-image-page-range">페이지 범위</label>
                      <input
                        id="pdf-to-image-page-range"
                        type="text"
                        value={pageRange}
                        disabled={busy}
                        aria-invalid={!parsedPageRange.ok || preflight?.ok === false}
                        aria-describedby="pdf-to-image-page-range-help"
                        onChange={(event) => {
                          applySettingChange("페이지 범위를 바꿘어요.");
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

                <fieldset className={`${styles.segmentGroup} ${styles.twoColumnSegment}`}>
                  <legend>출력 형식</legend>
                  <div>
                    <label>
                      <input
                        type="radio"
                        name="pdf-to-image-format"
                        checked={format === "jpeg"}
                        disabled={busy}
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
                        disabled={busy}
                        onChange={() => {
                          applySettingChange("PNG로 변환해요.");
                          setFormat("png");
                        }}
                      />
                      PNG
                    </label>
                  </div>
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
                          disabled={busy}
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
                      disabled={busy}
                      aria-label={`JPG 품질 ${quality}`}
                      aria-valuetext={`${quality}`}
                      onChange={(event) => {
                        applySettingChange("JPG 품질을 바꿘어요.");
                        setQuality(Number(event.target.value));
                      }}
                    />
                    <div aria-hidden="true">
                      <span>40</span>
                      <span>95</span>
                    </div>
                  </fieldset>
                ) : null}

                <p
                  id="pdf-to-image-validation"
                  className={
                    preflight?.ok === false ? styles.validationError : styles.validationNotice
                  }
                >
                  {validationMessage}
                </p>

                <div className={styles.privacyNotice}>
                  <span aria-hidden="true">✓</span>
                  <p>
                    <strong>파일은 업로드하지 않아요</strong>
                    브라우저 Worker가 기기 안에서만 렌더링합니다.
                  </p>
                </div>
              </div>
            </aside>

            <section className={styles.resultPanel} aria-label="PDF 이미지 변환 결과">
              <div className={styles.resultIcon} aria-hidden="true">
                {result?.mime === "application/zip"
                  ? "ZIP"
                  : result?.format === "png"
                    ? "PNG"
                    : "JPG"}
              </div>
              <div className={styles.resultCopy}>
                <strong>
                  {result !== undefined
                    ? result.outputFileCount === 1
                      ? "이미지 1개 준비 완료"
                      : `이미지 ${result.outputFileCount}개 ZIP 준비 완료`
                    : processing
                      ? progressLabel(progress)
                      : inspecting
                        ? "PDF 페이지 확인 중"
                        : "결과가 여기에 준비돼요"}
                </strong>
                <p>
                  {result !== undefined
                    ? `${formatBytes(result.byteLength)} · ${formatDuration(result.timing.totalMs)}`
                    : "페이지를 한 장씩 처리해 메모리 사용을 제한해요."}
                </p>
              </div>
              <div
                className={styles.progressTrack}
                role="progressbar"
                aria-label="PDF 이미지 변환 진행률"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progressPercent}
                aria-valuetext={progressText}
              >
                <span style={{ width: `${progressPercent}%` }} />
              </div>
              {result !== undefined ? (
                <div className={styles.resultCaveats}>
                  <p>텍스트는 더 이상 검색하거나 선택할 수 없어요.</p>
                  <p>주석·양식은 렌더링된 모습으로 평면화돼요.</p>
                  <p>브라우저 캔버스에서 색상 프로필이 정규화될 수 있어요.</p>
                </div>
              ) : null}
            </section>
          </div>

          <div className={styles.actionBar}>
            <div className={styles.statusCopy} role="status" aria-live="polite" aria-atomic="true">
              <strong>{preflight?.ok === false && !busy ? preflight.message : message}</strong>
              <span>
                {processing
                  ? progressLabel(progress)
                  : inspecting
                    ? "PDF 페이지 확인 중"
                    : inspection !== undefined
                      ? `${inspection.pageCount}페이지 PDF · ${dpi}DPI ${format === "jpeg" ? "JPG" : "PNG"}`
                      : `선택 ${formatBytes(file.size)}`}
              </span>
            </div>
            <div className={`${styles.actionButtons} ${styles.toImageActionButtons}`}>
              {processing ? (
                <button className={styles.secondaryButton} type="button" onClick={cancelProcessing}>
                  작업 중단
                </button>
              ) : inspecting ? (
                <button className={styles.secondaryButton} type="button" onClick={cancelInspection}>
                  페이지 확인 중단
                </button>
              ) : result !== undefined ? (
                <>
                  <button className={styles.secondaryButton} type="button" onClick={reset}>
                    새 작업
                  </button>
                  <button
                    className={styles.secondaryButton}
                    type="button"
                    onClick={() => void startProcessing()}
                  >
                    같은 설정으로 다시 실행
                  </button>
                  <button className={styles.runButton} type="button" onClick={downloadResult}>
                    {result.outputFileCount === 1 ? "이미지 다운로드 ↓" : "ZIP 다운로드 ↓"}
                  </button>
                </>
              ) : (
                <button
                  className={styles.runButton}
                  type="button"
                  disabled={preflight?.ok !== true || !runtimeSupported}
                  aria-describedby="pdf-to-image-validation"
                  onClick={() => void startProcessing()}
                >
                  {runLabel}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

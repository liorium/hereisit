"use client";

import {
  type PdfCompressScannedJobHandle,
  type PdfCompressScannedProgress,
  type PdfCompressScannedResult,
  type PdfCompressScannedSpecV1,
  runPdfCompressScannedJob,
  supportsBrowserPdfCompressScannedRuntime,
} from "@hereisit/browser-runtime/pdf-compress-scanned";
import { inspectPdfFile } from "@hereisit/browser-runtime/pdf-inspection";
import type { PdfInspectionHandle, PdfInspectionResult } from "@hereisit/tool-contracts";
import { type DragEvent, useCallback, useEffect, useRef, useState } from "react";
import { downloadUrl, formatBytes, formatDuration } from "../lib/files";
import { PDF_COMPRESS_SCANNED_WARNING } from "../lib/site";
import styles from "./pdf-workbench.module.css";

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_PAGE_COUNT = 100;
const INITIAL_MESSAGE = "파일을 선택하면 페이지를 확인할게요.";
const UNSUPPORTED_BROWSER_MESSAGE = "이 브라우저는 로컬 스캔 PDF 압축을 지원하지 않아요.";
const PAGE_LIMIT_MESSAGE = "PDF는 1페이지부터 100페이지까지 압축할 수 있어요.";

type Preset = PdfCompressScannedSpecV1["preset"];
type PdfCompressScannedResultMetadata = Omit<PdfCompressScannedResult, "bytes">;

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

export function PdfCompressWorkbench() {
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
  const [result, setResult] = useState<PdfCompressScannedResultMetadata>();

  const inputRef = useRef<HTMLInputElement>(null);
  const inspectionHandleRef = useRef<PdfInspectionHandle | undefined>(undefined);
  const jobHandleRef = useRef<PdfCompressScannedJobHandle | undefined>(undefined);
  const resultBlobRef = useRef<Blob | undefined>(undefined);
  const resultUrlRef = useRef<string | undefined>(undefined);
  const runRef = useRef(0);
  const saveOperationRef = useRef(0);
  const savingRef = useRef(false);
  const busy = inspecting || processing;
  const visibleMessage = hydrated && !runtimeSupported ? UNSUPPORTED_BROWSER_MESSAGE : message;

  const clearResult = useCallback((updateState = true) => {
    resultBlobRef.current = undefined;
    const resultUrl = resultUrlRef.current;
    resultUrlRef.current = undefined;
    if (resultUrl !== undefined) URL.revokeObjectURL(resultUrl);
    if (updateState) {
      setResult(undefined);
      setProgress(undefined);
    }
  }, []);

  const invalidateActiveWork = useCallback(
    (updateState = true) => {
      const runId = runRef.current + 1;
      runRef.current = runId;
      inspectionHandleRef.current?.cancel();
      inspectionHandleRef.current = undefined;
      jobHandleRef.current?.cancel();
      jobHandleRef.current = undefined;
      saveOperationRef.current += 1;
      savingRef.current = false;
      clearResult(updateState);
      if (updateState) {
        setInspecting(false);
        setProcessing(false);
      }
      return runId;
    },
    [clearResult],
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
      if (candidates.length !== 1) {
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
        nextFile.size > MAX_FILE_BYTES
      ) {
        setMessage("PDF 파일은 1바이트 이상 50MB 이하여야 해요.");
        return;
      }

      void inspectSelectedFile(nextFile);
    },
    [inspectSelectedFile, runtimeSupported],
  );

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
    setProcessing(true);
    setProgress({ phase: "validating", fraction: 0 });
    setMessage("압축 설정과 파일을 확인하고 있어요.");

    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (runRef.current !== runId) return;

    let handle: PdfCompressScannedJobHandle | undefined;
    try {
      handle = runPdfCompressScannedJob(
        selectedFile,
        { version: 1, preset: selectedPreset },
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
        const { bytes, ...resultMetadata } = outcome.value;
        const blob = new Blob([bytes], { type: "application/pdf" });
        const url = URL.createObjectURL(blob);
        resultBlobRef.current = blob;
        resultUrlRef.current = url;
        setResult(resultMetadata);
        setProgress({ phase: "finalizing", fraction: 1 });
        setMessage("압축 PDF를 준비했어요.");
      } else if (outcome.status === "cancelled") {
        setProgress(undefined);
        setMessage("PDF 압축을 중단했어요.");
      } else {
        setProgress(undefined);
        const noReductionMessage =
          selectedPreset === "balanced"
            ? "균형 150DPI 설정으로는 파일 용량을 1% 이상 줄이지 못했어요. 최소 용량 96DPI를 시도해 보세요."
            : "사용 가능한 설정으로는 파일 용량을 줄이지 못했어요. 원본을 그대로 사용하는 것을 권장해요.";
        const memoryLimitMessage =
          selectedPreset === "balanced"
            ? "균형 150DPI에서는 페이지가 너무 커요. 최소 용량 96DPI로 낮춰 다시 시도해 주세요."
            : "사용 가능한 최소 96DPI에서도 이 PDF를 안전하게 처리할 수 없어요. 원본을 그대로 사용하거나 페이지 크기나 페이지 수를 줄인 PDF를 다시 준비해 주세요.";
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
        setProgress(undefined);
        setMessage("스캔 PDF 압축 작업기를 시작하지 못했어요. 다시 시도해 주세요.");
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
    setMessage("PDF 압축을 중단했어요.");
  };

  const cancelInspection = () => {
    invalidateActiveWork();
    setInspection(undefined);
    setMessage("PDF 페이지 확인을 중단했어요.");
  };

  const saveResult = () => {
    const blob = resultBlobRef.current;
    const resultUrl = resultUrlRef.current;
    if (
      result === undefined ||
      resultUrl === undefined ||
      blob === undefined ||
      savingRef.current
    ) {
      return;
    }

    const runId = runRef.current;
    const saveOperation = saveOperationRef.current + 1;
    saveOperationRef.current = saveOperation;
    savingRef.current = true;
    const isCurrentSave = () =>
      saveOperationRef.current === saveOperation &&
      runRef.current === runId &&
      resultBlobRef.current === blob &&
      resultUrlRef.current === resultUrl;

    try {
      if (!isCurrentSave()) return;
      downloadUrl(resultUrl, result.suggestedName);
      if (isCurrentSave()) setMessage("결과 파일을 저장했어요.");
    } finally {
      if (saveOperationRef.current === saveOperation) savingRef.current = false;
    }
  };

  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragging(false);
    if (!busy) chooseFile(event.dataTransfer.files);
  };

  const pageCount = inspection?.pageCount;
  const runLabel =
    pageCount === undefined ? "PDF 용량 줄이기 →" : `${pageCount}페이지 PDF 용량 줄이기 →`;
  const progressText = result === undefined ? progressLabel(progress) : "압축 완료";
  const progressPercent = result === undefined ? Math.round((progress?.fraction ?? 0) * 100) : 100;
  const savings =
    result === undefined
      ? undefined
      : Math.round(((result.sourceByteLength - result.byteLength) / result.sourceByteLength) * 100);

  return (
    <section className={styles.shell} aria-labelledby="pdf-compress-workbench-title">
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

      <div className={`${styles.workbench} ${styles.compressionWorkbench}`}>
        <div className={styles.workbenchHeader}>
          <div>
            <p className={styles.eyebrow}>PDF COMPRESSOR</p>
            <h2 id="pdf-compress-workbench-title">스캔 PDF 용량 줄이기</h2>
          </div>
          {file === undefined ? null : (
            <div className={styles.headerActions}>
              <button type="button" onClick={() => inputRef.current?.click()} disabled={busy}>
                PDF 교체
              </button>
              <button type="button" onClick={reset} disabled={busy}>
                처음부터
              </button>
            </div>
          )}
        </div>

        <section className={styles.workspace} aria-label="PDF 압축 작업 공간">
          <section className={styles.filePanel} aria-label="원본 PDF">
            <div className={styles.panelTitle}>
              <strong>원본 PDF</strong>
              <span>{file === undefined ? "1 FILE" : "1"}</span>
            </div>
            {file === undefined ? (
              <section
                className={`${styles.compressionPicker} ${dragging ? styles.dragging : ""}`}
                aria-label="PDF 파일 선택"
                onDragEnter={(event) => {
                  event.preventDefault();
                  if (!busy) setDragging(true);
                }}
                onDragOver={(event) => event.preventDefault()}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node))
                    setDragging(false);
                }}
                onDrop={onDrop}
              >
                <div className={styles.compressionPickerIcon} aria-hidden="true">
                  PDF
                </div>
                <p>PDF 1개 · 1바이트~50MB · 최대 100페이지 · 파일은 이 기기에서만 처리돼요.</p>
                <button
                  className={styles.primaryButton}
                  type="button"
                  disabled={!hydrated || !runtimeSupported}
                  onClick={() => inputRef.current?.click()}
                >
                  PDF 선택
                </button>
              </section>
            ) : (
              <>
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
                    {inspection === undefined
                      ? "페이지 수를 이 기기에서만 확인해요."
                      : `${inspection.pageCount}페이지 · 페이지 수만 압축 준비에 사용해요.`}
                  </p>
                </div>
                <p className={styles.fileTotal}>선택 {formatBytes(file.size)} · 한도 50MB</p>
              </>
            )}
          </section>

          <aside className={styles.settingsPanel} aria-label="PDF 압축 설정">
            <div className={styles.panelTitle}>
              <strong>압축 수준</strong>
              <span>LOCAL</span>
            </div>
            <div className={styles.compressionSettings}>
              <fieldset className={styles.presetGroup}>
                <legend>압축 수준 선택</legend>
                <label>
                  <input
                    type="radio"
                    name="pdf-compress-preset"
                    checked={preset === "balanced"}
                    disabled={busy}
                    onChange={() => selectPreset("balanced")}
                  />
                  <span>
                    <span className={styles.presetHeading}>
                      <strong>균형 150DPI</strong>
                      <em>추천</em>
                    </span>
                    <small>글자 가독성과 용량의 균형을 맞춰요.</small>
                  </span>
                </label>
                <label>
                  <input
                    type="radio"
                    name="pdf-compress-preset"
                    checked={preset === "minimum"}
                    disabled={busy}
                    onChange={() => selectPreset("minimum")}
                  />
                  <span>
                    <span className={styles.presetHeading}>
                      <strong>최소 용량 96DPI</strong>
                      <em>작게</em>
                    </span>
                    <small>용량을 더 줄이지만 작은 글자가 흐려질 수 있어요.</small>
                  </span>
                </label>
              </fieldset>

              <p className={styles.compressionWarning}>{PDF_COMPRESS_SCANNED_WARNING}</p>
              <div className={styles.privacyNotice}>
                <span aria-hidden="true">✓</span>
                <p>
                  <strong>파일은 이 기기에서만 처리돼요.</strong>
                  파일은 서버로 전송되지 않습니다.
                </p>
              </div>
            </div>
          </aside>

          <section className={styles.resultPanel} aria-label="PDF 압축 결과">
            <div className={styles.resultIcon} aria-hidden="true">
              PDF
            </div>
            <div className={styles.resultCopy}>
              <strong>
                {result !== undefined
                  ? "압축 PDF 준비 완료"
                  : processing
                    ? progressLabel(progress)
                    : inspecting
                      ? "PDF 페이지 확인 중"
                      : visibleMessage}
              </strong>
              <p>원본보다 1% 이상 작을 때만 새 PDF를 제공해요.</p>
            </div>
            <div
              className={styles.progressTrack}
              role="progressbar"
              aria-label="PDF 압축 진행률"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progressPercent}
              aria-valuetext={progressText}
            >
              <span style={{ width: `${progressPercent}%` }} />
            </div>
            {result === undefined ? null : (
              <>
                <strong className={styles.savingsSummary}>{savings}% 절약</strong>
                <dl className={styles.compressionResultDetails} aria-label="압축 결과 상세">
                  <div>
                    <dt>설정</dt>
                    <dd>{presetLabel(result.preset)}</dd>
                  </div>
                  <div>
                    <dt>원본</dt>
                    <dd>{formatBytes(result.sourceByteLength)}</dd>
                  </div>
                  <div>
                    <dt>결과</dt>
                    <dd>{formatBytes(result.byteLength)}</dd>
                  </div>
                  <div>
                    <dt>절약</dt>
                    <dd>{savings}%</dd>
                  </div>
                  <div>
                    <dt>처리 시간</dt>
                    <dd>{formatDuration(result.timing.totalMs)}</dd>
                  </div>
                </dl>
                <p className={styles.compressionResultWarning}>{PDF_COMPRESS_SCANNED_WARNING}</p>
              </>
            )}
          </section>
        </section>

        <div className={styles.actionBar}>
          <div className={styles.statusCopy} role="status" aria-live="polite" aria-atomic="true">
            <strong>{visibleMessage}</strong>
            <span>
              {processing
                ? progressLabel(progress)
                : inspecting
                  ? "PDF 페이지 확인 중"
                  : inspection === undefined
                    ? file === undefined
                      ? "PDF를 선택하세요."
                      : "PDF 페이지 수를 확인할 수 없어요."
                    : `${inspection.pageCount}페이지 PDF · ${presetLabel(preset)}`}
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
                <button
                  className={styles.runButton}
                  type="button"
                  onClick={() => void saveResult()}
                >
                  PDF 다운로드 ↓
                </button>
              </>
            ) : (
              <button
                className={styles.runButton}
                type="button"
                disabled={inspection === undefined || !runtimeSupported}
                onClick={() => void startProcessing()}
              >
                {runLabel}
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

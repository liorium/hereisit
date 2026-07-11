"use client";

import { runPdfJob, supportsBrowserPdfRuntime } from "@hereisit/browser-runtime/pdf";
import { parsePageSelection } from "@hereisit/pdf-tool";
import type {
  PdfJobHandle,
  PdfPhase,
  PdfPipelineResult,
  PdfPipelineSpecV1,
} from "@hereisit/tool-contracts";
import { type DragEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { downloadUrl, formatBytes, formatDuration, isAbortError } from "../lib/files";
import type { PdfToolIntent } from "../lib/site";
import styles from "./pdf-workbench.module.css";

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const LOW_MEMORY_TOTAL_BYTES = 60 * 1024 * 1024;
const STANDARD_TOTAL_BYTES = 100 * 1024 * 1024;

interface PdfWorkItem {
  id: string;
  file: File;
}

const INTENT_CONFIG: Record<
  PdfToolIntent,
  {
    emptyTitle: string;
    selectLabel: string;
    workbenchTitle: string;
    accept: string;
    fileDescription: string;
    maximumFiles: number;
    multiple: boolean;
  }
> = {
  merge: {
    emptyTitle: "합칠 PDF를 놓거나 선택하세요",
    selectLabel: "PDF 파일 선택",
    workbenchTitle: "PDF 합치기 작업대",
    accept: "application/pdf,.pdf",
    fileDescription: "PDF · 파일당 50MB · 최대 20개",
    maximumFiles: 20,
    multiple: true,
  },
  split: {
    emptyTitle: "나눌 PDF를 놓거나 선택하세요",
    selectLabel: "PDF 선택",
    workbenchTitle: "PDF 페이지 분할 작업대",
    accept: "application/pdf,.pdf",
    fileDescription: "PDF 한 개 · 최대 50MB · 페이지별 분리 최대 200페이지",
    maximumFiles: 1,
    multiple: false,
  },
  "image-to-pdf": {
    emptyTitle: "PDF로 만들 이미지를 놓거나 선택하세요",
    selectLabel: "JPG·PNG 이미지 선택",
    workbenchTitle: "이미지 PDF 작업대",
    accept: "image/jpeg,image/png,.jpg,.jpeg,.png",
    fileDescription: "JPG·PNG · 파일당 50MB · 압축 해제 메모리 자동 제한",
    maximumFiles: 100,
    multiple: true,
  },
};

function makeId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function isPdf(file: File): boolean {
  return file.type === "application/pdf" || (file.type === "" && /\.pdf$/i.test(file.name));
}

function isPdfImage(file: File): boolean {
  return (
    file.type === "image/jpeg" ||
    file.type === "image/png" ||
    (file.type === "" && /\.(?:jpe?g|png)$/i.test(file.name))
  );
}

function phaseLabel(phase: PdfPhase | undefined): string {
  if (phase === "validating") return "파일 확인 중";
  if (phase === "loading") return "페이지 읽는 중";
  if (phase === "processing") return "페이지 처리 중";
  if (phase === "serializing") return "결과 파일 만드는 중";
  if (phase === "finalizing") return "마무리 중";
  return "준비됨";
}

function resultBlob(result: PdfPipelineResult): Blob {
  return new Blob([result.bytes], { type: result.mime });
}

export function PdfWorkbench({ intent }: { intent: PdfToolIntent }) {
  const config = INTENT_CONFIG[intent];
  const [items, setItems] = useState<PdfWorkItem[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [runtimeSupported, setRuntimeSupported] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [message, setMessage] = useState("파일을 선택하면 바로 준비할게요.");
  const [phase, setPhase] = useState<PdfPhase>();
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<PdfPipelineResult>();
  const [resultUrl, setResultUrl] = useState<string>();
  const [splitMode, setSplitMode] = useState<"every-page" | "extract">("every-page");
  const [pageRange, setPageRange] = useState("1-3, 5");
  const [imagePageSize, setImagePageSize] = useState<"a4" | "image">("a4");
  const [inputLimit, setInputLimit] = useState(LOW_MEMORY_TOTAL_BYTES);
  const inputRef = useRef<HTMLInputElement>(null);
  const itemsRef = useRef(items);
  const handleRef = useRef<PdfJobHandle | undefined>(undefined);
  const resultUrlRef = useRef<string | undefined>(undefined);
  const resultBlobRef = useRef<Blob | undefined>(undefined);
  const runRef = useRef(0);
  const busy = processing;

  const totalBytes = useMemo(
    () => items.reduce((total, item) => total + item.file.size, 0),
    [items],
  );
  const parsedPageRange = useMemo(() => parsePageSelection(pageRange), [pageRange]);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const revokeResultUrl = useCallback(() => {
    resultBlobRef.current = undefined;
    if (resultUrlRef.current === undefined) return;
    URL.revokeObjectURL(resultUrlRef.current);
    resultUrlRef.current = undefined;
    setResultUrl(undefined);
  }, []);

  const clearResult = useCallback(() => {
    revokeResultUrl();
    setResult(undefined);
    setProgress(0);
    setPhase(undefined);
  }, [revokeResultUrl]);

  useEffect(() => {
    setHydrated(true);
    setRuntimeSupported(supportsBrowserPdfRuntime());
    const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    setInputLimit(
      memory !== undefined && memory > 4 ? STANDARD_TOTAL_BYTES : LOW_MEMORY_TOTAL_BYTES,
    );
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
      runRef.current += 1;
      handleRef.current?.cancel();
      if (resultUrlRef.current !== undefined) URL.revokeObjectURL(resultUrlRef.current);
    },
    [],
  );

  const addFiles = useCallback(
    (fileList: FileList | readonly File[]) => {
      const candidates = Array.from(fileList);
      const existing = intent === "split" ? [] : itemsRef.current;
      const accepted: PdfWorkItem[] = [];
      let remainingBytes = Math.max(
        0,
        inputLimit - existing.reduce((total, item) => total + item.file.size, 0),
      );
      const available = Math.max(0, config.maximumFiles - existing.length);

      for (const file of candidates) {
        const supported = intent === "image-to-pdf" ? isPdfImage(file) : isPdf(file);
        if (
          accepted.length >= available ||
          !supported ||
          file.size < 1 ||
          file.size > MAX_FILE_BYTES ||
          file.size > remainingBytes
        ) {
          continue;
        }
        accepted.push({ id: makeId(), file });
        remainingBytes -= file.size;
      }

      if (accepted.length > 0) {
        const next = [...existing, ...accepted];
        itemsRef.current = next;
        setItems(next);
        clearResult();
        setMessage(`${accepted.length}개 파일을 준비했어요.`);
      }
      const rejected = candidates.length - accepted.length;
      if (rejected > 0) {
        setMessage(
          `${accepted.length}개를 추가했어요. ${rejected}개는 형식·50MB·총 ${formatBytes(inputLimit)}·개수 제한으로 제외했어요.`,
        );
      }
    },
    [clearResult, config.maximumFiles, inputLimit, intent],
  );

  const removeItem = (id: string) => {
    if (busy) return;
    const next = itemsRef.current.filter((item) => item.id !== id);
    itemsRef.current = next;
    setItems(next);
    clearResult();
    setMessage(next.length === 0 ? "파일을 선택하면 바로 준비할게요." : "파일을 제거했어요.");
  };

  const moveItem = (index: number, direction: -1 | 1) => {
    if (busy) return;
    const target = index + direction;
    if (target < 0 || target >= itemsRef.current.length) return;
    const next = [...itemsRef.current];
    const item = next[index];
    if (item === undefined) return;
    next.splice(index, 1);
    next.splice(target, 0, item);
    itemsRef.current = next;
    setItems(next);
    clearResult();
    setMessage(`${item.file.name}을 ${target + 1}번째로 이동했어요.`);
  };

  const reset = () => {
    runRef.current += 1;
    handleRef.current?.cancel();
    handleRef.current = undefined;
    itemsRef.current = [];
    setItems([]);
    setProcessing(false);
    clearResult();
    setMessage("파일을 선택하면 바로 준비할게요.");
  };

  const buildSpec = (): PdfPipelineSpecV1 | undefined => {
    if (intent === "merge") return { version: 1, operation: "merge" };
    if (intent === "image-to-pdf") {
      return {
        version: 1,
        operation: "images-to-pdf",
        page: imagePageSize === "a4" ? { size: "a4", margin: 24 } : { size: "image", margin: 0 },
      };
    }
    if (splitMode === "every-page") {
      return { version: 1, operation: "split", selection: { mode: "every-page" } };
    }
    if (!parsedPageRange.ok) {
      setMessage(parsedPageRange.message);
      return undefined;
    }
    return {
      version: 1,
      operation: "split",
      selection: { mode: "extract", pages: [...parsedPageRange.pages] },
    };
  };

  const startProcessing = async () => {
    if (busy || !runtimeSupported) return;
    if (intent === "merge" && itemsRef.current.length < 2) {
      setMessage("합칠 PDF를 2개 이상 선택해 주세요.");
      return;
    }
    if (itemsRef.current.length === 0) return;
    const spec = buildSpec();
    if (spec === undefined) return;

    const runId = runRef.current + 1;
    runRef.current = runId;
    clearResult();
    setProcessing(true);
    setProgress(0);
    setPhase("validating");
    setMessage("파일을 기기 안에서 처리하고 있어요.");

    let handle: PdfJobHandle | undefined;
    try {
      handle = runPdfJob(
        itemsRef.current.map((item) => item.file),
        spec,
        {
          onProgress: (event) => {
            if (runRef.current !== runId) return;
            setPhase(event.phase);
            setProgress((current) => Math.max(current, event.fraction));
          },
        },
      );
      handleRef.current = handle;
      const outcome = await handle.result;
      if (runRef.current !== runId) return;
      if (outcome.status === "fulfilled") {
        const blob = resultBlob(outcome.value);
        const url = URL.createObjectURL(blob);
        resultBlobRef.current = blob;
        resultUrlRef.current = url;
        setResultUrl(url);
        setResult({ ...outcome.value, bytes: new ArrayBuffer(0) });
        setProgress(1);
        setPhase("finalizing");
        setMessage(
          outcome.value.mime === "application/zip"
            ? `${outcome.value.outputDocumentCount}개 페이지 분할을 완료했어요.`
            : `${outcome.value.outputPageCount}페이지 PDF를 완성했어요.`,
        );
      } else if (outcome.status === "cancelled") {
        setMessage("PDF 작업을 중단했어요.");
      } else {
        setMessage(outcome.error.message);
      }
    } catch {
      if (runRef.current === runId) {
        setMessage("PDF 작업기를 시작하지 못했어요. 최신 브라우저에서 다시 시도해 주세요.");
      }
    } finally {
      if (runRef.current === runId) {
        if (handleRef.current === handle) handleRef.current = undefined;
        setProcessing(false);
      }
    }
  };

  const cancelProcessing = () => {
    runRef.current += 1;
    handleRef.current?.cancel();
    handleRef.current = undefined;
    setProcessing(false);
    setMessage("PDF 작업을 중단했어요.");
  };

  const saveResult = async () => {
    const blob = resultBlobRef.current;
    if (result === undefined || resultUrl === undefined || blob === undefined) return;
    let shareData: ShareData | undefined;
    let canShare = false;
    if (typeof navigator.share === "function" && typeof navigator.canShare === "function") {
      const file = new File([blob], result.suggestedName, { type: result.mime });
      shareData = { files: [file] };
      try {
        canShare = navigator.canShare(shareData);
      } catch {
        canShare = false;
      }
    }
    if (canShare && shareData !== undefined) {
      try {
        await navigator.share(shareData);
        setMessage("결과를 공유 메뉴로 보냈어요.");
        return;
      } catch (error) {
        if (isAbortError(error)) return;
      }
    }
    downloadUrl(resultUrl, result.suggestedName);
    setMessage("결과 파일을 저장했어요.");
  };

  const changeSplitMode = (mode: "every-page" | "extract") => {
    setSplitMode(mode);
    clearResult();
    setMessage(
      mode === "every-page"
        ? "각 페이지를 별도 PDF로 나눠 ZIP으로 만들어요."
        : "입력한 페이지만 모아 새 PDF를 만들어요.",
    );
  };

  const changeImagePageSize = (size: "a4" | "image") => {
    setImagePageSize(size);
    clearResult();
    setMessage(
      size === "a4"
        ? "사진 방향에 맞는 A4 페이지를 사용해요."
        : "이미지 비율에 맞춰 페이지를 만들어요.",
    );
  };

  const runLabel =
    intent === "merge"
      ? `${items.length}개 PDF 합치기 →`
      : intent === "split"
        ? splitMode === "every-page"
          ? "PDF 페이지별로 나누기 →"
          : "선택 페이지 추출하기 →"
        : `${items.length}개 이미지로 PDF 만들기 →`;

  const canRun =
    runtimeSupported &&
    !busy &&
    items.length > 0 &&
    (intent !== "merge" || items.length >= 2) &&
    (intent !== "split" || splitMode !== "extract" || parsedPageRange.ok);

  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragging(false);
    if (!busy) addFiles(event.dataTransfer.files);
  };

  return (
    <section className={styles.shell} aria-labelledby="pdf-workbench-title">
      <input
        ref={inputRef}
        className={styles.hiddenInput}
        type="file"
        accept={config.accept}
        multiple={config.multiple}
        tabIndex={-1}
        disabled={!hydrated || busy || !runtimeSupported}
        onChange={(event) => {
          if (event.target.files !== null) addFiles(event.target.files);
          event.target.value = "";
        }}
      />

      {items.length === 0 ? (
        <section
          className={`${styles.emptyDropzone} ${dragging ? styles.dragging : ""}`}
          aria-labelledby="pdf-workbench-title"
          onDragEnter={(event) => {
            event.preventDefault();
            setDragging(true);
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
            <p className={styles.eyebrow}>LOCAL PDF WORKBENCH</p>
            <h2 id="pdf-workbench-title">{config.emptyTitle}</h2>
            <p>
              {config.fileDescription} · 총 {formatBytes(inputLimit)}
            </p>
          </div>
          <div className={styles.dropActions}>
            <button
              className={styles.primaryButton}
              type="button"
              disabled={!hydrated || !runtimeSupported}
              onClick={() => inputRef.current?.click()}
            >
              {config.selectLabel}
            </button>
            <p className={styles.status} role="status" aria-live="polite" aria-atomic="true">
              {!hydrated
                ? "PDF 도구를 준비하고 있어요…"
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
              <p className={styles.eyebrow}>LOCAL PDF WORKBENCH</p>
              <h2 id="pdf-workbench-title">{config.workbenchTitle}</h2>
            </div>
            <div className={styles.headerActions}>
              {intent !== "split" ? (
                <button type="button" onClick={() => inputRef.current?.click()} disabled={busy}>
                  ＋ 추가
                </button>
              ) : null}
              <button type="button" onClick={reset} disabled={busy}>
                처음부터
              </button>
            </div>
          </div>

          <div className={styles.workspace}>
            <section className={styles.filePanel} aria-label="선택한 파일">
              <div className={styles.panelTitle}>
                <strong>파일 순서</strong>
                <span>{items.length}</span>
              </div>
              <div className={styles.fileList}>
                {items.map((item, index) => (
                  <article className={styles.fileRow} key={item.id}>
                    <span className={styles.fileIndex}>{String(index + 1).padStart(2, "0")}</span>
                    <div className={styles.fileCopy}>
                      <strong>{item.file.name}</strong>
                      <span>{formatBytes(item.file.size)}</span>
                    </div>
                    <div className={styles.fileActions}>
                      {intent !== "split" ? (
                        <>
                          <button
                            type="button"
                            aria-label={`${item.file.name} 위로 이동`}
                            disabled={busy || index === 0}
                            onClick={() => moveItem(index, -1)}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            aria-label={`${item.file.name} 아래로 이동`}
                            disabled={busy || index === items.length - 1}
                            onClick={() => moveItem(index, 1)}
                          >
                            ↓
                          </button>
                        </>
                      ) : null}
                      <button
                        type="button"
                        aria-label={`${item.file.name} 제거`}
                        disabled={busy}
                        onClick={() => removeItem(item.id)}
                      >
                        ×
                      </button>
                    </div>
                  </article>
                ))}
              </div>
              <p className={styles.fileTotal}>
                총 {formatBytes(totalBytes)} · 기기별 한도 {formatBytes(inputLimit)}
              </p>
            </section>

            <aside className={styles.settingsPanel} aria-label="PDF 설정">
              <div className={styles.panelTitle}>
                <strong>설정</strong>
                <span>LOCAL</span>
              </div>

              {intent === "merge" ? (
                <div className={styles.settingCard}>
                  <strong>선택한 순서대로 합치기</strong>
                  <p>왼쪽 목록의 01번부터 모든 페이지를 차례로 복사해요.</p>
                </div>
              ) : null}

              {intent === "split" ? (
                <fieldset className={styles.optionGroup}>
                  <legend>나눌 방식</legend>
                  <label>
                    <input
                      type="radio"
                      name="split-mode"
                      checked={splitMode === "every-page"}
                      disabled={busy}
                      onChange={() => changeSplitMode("every-page")}
                    />
                    <span>
                      <strong>페이지별 분리</strong>
                      <small>각 페이지를 PDF로 만들고 ZIP으로 저장</small>
                    </span>
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="split-mode"
                      checked={splitMode === "extract"}
                      disabled={busy}
                      onChange={() => changeSplitMode("extract")}
                    />
                    <span>
                      <strong>페이지 추출</strong>
                      <small>필요한 페이지만 한 PDF로 저장</small>
                    </span>
                  </label>
                  {splitMode === "extract" ? (
                    <div className={styles.rangeField}>
                      <label htmlFor="pdf-page-range">페이지 범위</label>
                      <input
                        id="pdf-page-range"
                        type="text"
                        value={pageRange}
                        disabled={busy}
                        aria-invalid={!parsedPageRange.ok}
                        aria-describedby="pdf-page-range-help"
                        onChange={(event) => {
                          setPageRange(event.target.value);
                          clearResult();
                        }}
                      />
                      <small id="pdf-page-range-help">
                        {parsedPageRange.ok
                          ? `${parsedPageRange.pages.length}페이지를 선택했어요.`
                          : parsedPageRange.message}
                      </small>
                    </div>
                  ) : null}
                </fieldset>
              ) : null}

              {intent === "image-to-pdf" ? (
                <fieldset className={styles.optionGroup}>
                  <legend>페이지 크기</legend>
                  <label>
                    <input
                      type="radio"
                      name="page-size"
                      checked={imagePageSize === "a4"}
                      disabled={busy}
                      onChange={() => changeImagePageSize("a4")}
                    />
                    <span>
                      <strong>A4 자동 방향</strong>
                      <small>사진 방향에 맞춰 여백을 넣어요</small>
                    </span>
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="page-size"
                      checked={imagePageSize === "image"}
                      disabled={busy}
                      onChange={() => changeImagePageSize("image")}
                    />
                    <span>
                      <strong>이미지에 맞춤</strong>
                      <small>이미지 비율 그대로 페이지를 만들어요</small>
                    </span>
                  </label>
                </fieldset>
              ) : null}

              <div className={styles.privacyNotice}>
                <span aria-hidden="true">✓</span>
                <p>
                  <strong>파일은 업로드하지 않아요</strong>
                  브라우저 Worker가 기기 안에서만 처리합니다.
                </p>
              </div>
            </aside>

            <section className={styles.resultPanel} aria-label="PDF 결과 미리보기">
              <div className={styles.resultIcon} aria-hidden="true">
                PDF
              </div>
              <div className={styles.resultCopy}>
                <strong>
                  {result !== undefined
                    ? result.mime === "application/zip"
                      ? `${result.outputDocumentCount}개 PDF 준비 완료`
                      : `${result.outputPageCount}페이지 PDF 준비 완료`
                    : processing
                      ? phaseLabel(phase)
                      : "결과가 여기에 준비돼요"}
                </strong>
                <p>
                  {result !== undefined
                    ? `${formatBytes(result.byteLength)} · ${formatDuration(result.timing.totalMs)}`
                    : "파일 내용이나 이름을 서버로 보내지 않습니다."}
                </p>
              </div>
              <div
                className={styles.progressTrack}
                role="progressbar"
                aria-label="PDF 작업 진행률"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(progress * 100)}
              >
                <span style={{ width: `${Math.round(progress * 100)}%` }} />
              </div>
              {result?.warnings.includes("SIGNATURES_INVALIDATED") ? (
                <p className={styles.resultWarning}>
                  새 PDF에서는 기존 전자서명이 유효하지 않아요. 북마크·양식은 유지되지 않을 수
                  있어요.
                </p>
              ) : null}
              {result?.warnings.includes("IMAGE_COLOR_MAY_CHANGE") ? (
                <p className={styles.resultWarning}>
                  광색역·16비트 이미지는 PDF에서 색감이나 정밀도가 달라질 수 있어요.
                </p>
              ) : null}
            </section>
          </div>

          <div className={styles.actionBar}>
            <div className={styles.statusCopy} role="status" aria-live="polite" aria-atomic="true">
              <strong>{message}</strong>
              <span>
                {processing
                  ? `${phaseLabel(phase)} · ${Math.round(progress * 100)}%`
                  : `선택 ${items.length}개 · ${formatBytes(totalBytes)}`}
              </span>
            </div>
            <div className={styles.actionButtons}>
              {processing ? (
                <button className={styles.secondaryButton} type="button" onClick={cancelProcessing}>
                  중단
                </button>
              ) : result !== undefined ? (
                <>
                  <button className={styles.secondaryButton} type="button" onClick={reset}>
                    새 작업
                  </button>
                  <button
                    className={styles.runButton}
                    type="button"
                    onClick={() => void saveResult()}
                  >
                    {result.mime === "application/zip"
                      ? `결과 ${result.outputDocumentCount}개 ZIP으로 받기 ↓`
                      : "PDF 저장·공유 ↓"}
                  </button>
                </>
              ) : (
                <button
                  className={styles.runButton}
                  type="button"
                  disabled={!canRun}
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

"use client";

import {
  inspectPdfFile,
  runPdfJob,
  supportsBrowserPdfRuntime,
} from "@hereisit/browser-runtime/pdf";
import {
  runPdfThumbnailJob,
  supportsBrowserPdfThumbnailRuntime,
} from "@hereisit/browser-runtime/pdf-thumbnail";
import {
  createPdfPagePlan,
  movePdfPage,
  type PdfPagePlan,
  removePdfPage,
  rotatePdfPage,
} from "@hereisit/pdf-tool";
import type {
  PdfInspectionHandle,
  PdfJobHandle,
  PdfPhase,
  PdfPipelineResult,
  PdfThumbnailJobHandle,
} from "@hereisit/tool-contracts";
import type { AvailableToolId } from "@hereisit/tool-registry/catalog";
import { type DragEvent, useCallback, useEffect, useRef, useState } from "react";
import { downloadUrl, formatBytes } from "../lib/files";
import { reportDownloadRequested, startProductUsageRun } from "../lib/product-analytics";
import { getToolImplementation } from "../lib/tool-implementations";
import { usePendingToolFiles } from "../lib/use-pending-tool-files";
import styles from "./pdf-organize-workbench.module.css";

type ThumbnailState =
  | { status: "pending" }
  | { status: "failed" }
  | { status: "ready"; url: string; width: number; height: number };

function isPdf(file: File): boolean {
  return file.type === "application/pdf" || (file.type === "" && /\.pdf$/i.test(file.name));
}

function phaseLabel(phase: PdfPhase | undefined): string {
  if (phase === "validating") return "파일 확인 중";
  if (phase === "loading") return "페이지 읽는 중";
  if (phase === "processing") return "페이지 정리 중";
  if (phase === "serializing") return "결과 PDF 만드는 중";
  if (phase === "finalizing") return "마무리 중";
  return "준비 중";
}

function movePageToIndex(plan: PdfPagePlan, from: number, to: number): PdfPagePlan {
  let next = plan;
  let index = from;
  while (index !== to) {
    const direction = index < to ? 1 : -1;
    next = movePdfPage(next, index, direction);
    index += direction;
  }
  return next;
}

export function PdfOrganizeWorkbench({ toolId }: { toolId: AvailableToolId }) {
  const implementation = getToolImplementation(toolId);
  if (
    toolId !== "pdf.organize" ||
    implementation.intent !== "organize" ||
    implementation.bundleProfile !== "pdf-organize"
  ) {
    throw new Error(`PdfOrganizeWorkbench tool mismatch: ${toolId}`);
  }
  const { maxFileBytes } = implementation.sourceFileLimits;
  const [hydrated, setHydrated] = useState(false);
  const [runtimeSupported, setRuntimeSupported] = useState(false);
  const [thumbnailSupported, setThumbnailSupported] = useState(false);
  const [file, setFile] = useState<File>();
  const [sourcePageCount, setSourcePageCount] = useState(0);
  const [pagePlan, setPagePlan] = useState<PdfPagePlan>([]);
  const [thumbnails, setThumbnails] = useState<ReadonlyMap<number, ThumbnailState>>(new Map());
  const [inspecting, setInspecting] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [phase, setPhase] = useState<PdfPhase>();
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<PdfPipelineResult>();
  const [resultUrl, setResultUrl] = useState<string>();
  const [message, setMessage] = useState("PDF를 선택하면 바로 준비할게요.");
  const inputRef = useRef<HTMLInputElement>(null);
  const stageHeadingRef = useRef<HTMLHeadingElement>(null);
  const fileRef = useRef<File | undefined>(undefined);
  const pagePlanRef = useRef<PdfPagePlan>([]);
  const inspectionRef = useRef<PdfInspectionHandle | undefined>(undefined);
  const thumbnailRef = useRef<PdfThumbnailJobHandle | undefined>(undefined);
  const jobRef = useRef<PdfJobHandle | undefined>(undefined);
  const resultUrlRef = useRef<string | undefined>(undefined);
  const thumbnailUrlsRef = useRef(new Set<string>());
  const productRunRef = useRef<ReturnType<typeof startProductUsageRun> | null>(null);
  const runRef = useRef(0);
  const draggedSourcePageRef = useRef<number | undefined>(undefined);
  const busy = inspecting || processing;
  const stage = result
    ? "result"
    : processing
      ? "processing"
      : inspecting
        ? "inspecting"
        : file && pagePlan.length > 0
          ? "editing"
          : "select";

  useEffect(() => {
    fileRef.current = file;
  }, [file]);

  useEffect(() => {
    pagePlanRef.current = pagePlan;
  }, [pagePlan]);

  useEffect(() => {
    setHydrated(true);
    setRuntimeSupported(supportsBrowserPdfRuntime());
    setThumbnailSupported(supportsBrowserPdfThumbnailRuntime());
  }, []);

  useEffect(() => {
    if (stage === "select") return;
    stageHeadingRef.current?.focus();
  }, [stage]);

  const clearResult = useCallback(() => {
    if (resultUrlRef.current !== undefined) {
      URL.revokeObjectURL(resultUrlRef.current);
      resultUrlRef.current = undefined;
    }
    setResult(undefined);
    setResultUrl(undefined);
    setProgress(0);
    setPhase(undefined);
  }, []);

  const clearThumbnails = useCallback(() => {
    thumbnailRef.current?.cancel();
    thumbnailRef.current = undefined;
    for (const url of thumbnailUrlsRef.current) URL.revokeObjectURL(url);
    thumbnailUrlsRef.current.clear();
    setThumbnails(new Map());
  }, []);

  const invalidateActiveWork = useCallback(() => {
    runRef.current += 1;
    inspectionRef.current?.cancel();
    inspectionRef.current = undefined;
    thumbnailRef.current?.cancel();
    thumbnailRef.current = undefined;
    jobRef.current?.cancel();
    jobRef.current = undefined;
    productRunRef.current?.cancelled();
    productRunRef.current = null;
  }, []);

  useEffect(
    () => () => {
      invalidateActiveWork();
      if (resultUrlRef.current !== undefined) URL.revokeObjectURL(resultUrlRef.current);
      for (const url of thumbnailUrlsRef.current) URL.revokeObjectURL(url);
      thumbnailUrlsRef.current.clear();
    },
    [invalidateActiveWork],
  );

  const startThumbnails = useCallback(
    (selectedFile: File, runId: number, pageCount: number) => {
      const pending = new Map<number, ThumbnailState>();
      for (let sourcePage = 1; sourcePage <= pageCount; sourcePage += 1) {
        pending.set(sourcePage, { status: "pending" });
      }
      setThumbnails(pending);
      if (!thumbnailSupported) {
        setThumbnails(
          new Map(
            Array.from({ length: pageCount }, (_, index) => [
              index + 1,
              { status: "failed" } as const,
            ]),
          ),
        );
        setMessage("미리보기 없이 페이지 번호로 정리할 수 있어요.");
        return;
      }

      const handle = runPdfThumbnailJob(selectedFile, {
        onThumbnail(update) {
          if (runRef.current !== runId) return;
          setThumbnails((current) => {
            const next = new Map(current);
            if (update.status === "failed") {
              next.set(update.sourcePage, { status: "failed" });
            } else {
              const url = URL.createObjectURL(new Blob([update.bytes], { type: update.mime }));
              thumbnailUrlsRef.current.add(url);
              next.set(update.sourcePage, {
                status: "ready",
                url,
                width: update.width,
                height: update.height,
              });
            }
            return next;
          });
        },
      });
      thumbnailRef.current = handle;
      void handle.result.then((outcome) => {
        if (runRef.current !== runId || thumbnailRef.current !== handle) return;
        thumbnailRef.current = undefined;
        if (outcome.status === "fulfilled") {
          const unavailable = outcome.value.failedPageCount + outcome.value.omittedPageCount;
          setMessage(
            unavailable > 0
              ? `일부 미리보기 ${unavailable}개는 메모리를 위해 생략했어요.`
              : `${pageCount}페이지 미리보기를 준비했어요.`,
          );
        } else if (outcome.status === "rejected") {
          setThumbnails(
            (current) =>
              new Map(
                Array.from(current, ([sourcePage, thumbnail]) => [
                  sourcePage,
                  thumbnail.status === "pending" ? ({ status: "failed" } as const) : thumbnail,
                ]),
              ),
          );
          setMessage("일부 미리보기를 만들지 못했지만 페이지 정리는 계속할 수 있어요.");
        }
      });
    },
    [thumbnailSupported],
  );

  const selectFile = useCallback(
    (selectedFile: File) => {
      if (
        !isPdf(selectedFile) ||
        !Number.isSafeInteger(selectedFile.size) ||
        selectedFile.size < 1 ||
        selectedFile.size > maxFileBytes
      ) {
        setMessage("PDF 한 개를 선택해 주세요. 파일은 50MB 이하여야 해요.");
        return;
      }
      invalidateActiveWork();
      clearResult();
      clearThumbnails();
      const runId = runRef.current;
      setFile(selectedFile);
      setSourcePageCount(0);
      setPagePlan([]);
      pagePlanRef.current = [];
      setInspecting(true);
      setMessage("PDF 페이지를 이 기기에서 확인하고 있어요.");

      const handle = inspectPdfFile(selectedFile);
      inspectionRef.current = handle;
      void handle.result
        .then((outcome) => {
          if (runRef.current !== runId) return;
          if (outcome.status !== "fulfilled") {
            setFile(undefined);
            setMessage(
              outcome.status === "rejected" ? outcome.error.message : "페이지 확인을 중단했어요.",
            );
            return;
          }
          if (outcome.value.pageCount < 1 || outcome.value.pageCount > 500) {
            setFile(undefined);
            setMessage("PDF는 최대 500페이지까지 정리할 수 있어요.");
            return;
          }
          const plan = createPdfPagePlan(outcome.value.pageCount);
          setSourcePageCount(outcome.value.pageCount);
          setPagePlan(plan);
          pagePlanRef.current = plan;
          setMessage(`${outcome.value.pageCount}페이지를 불러왔어요. 미리보기를 만드는 중이에요.`);
          startThumbnails(selectedFile, runId, outcome.value.pageCount);
        })
        .finally(() => {
          if (runRef.current !== runId) return;
          if (inspectionRef.current === handle) inspectionRef.current = undefined;
          setInspecting(false);
        });
    },
    [clearResult, clearThumbnails, invalidateActiveWork, maxFileBytes, startThumbnails],
  );

  usePendingToolFiles({
    toolId,
    ready: hydrated && runtimeSupported && !busy,
    acceptFiles(files) {
      const selected = files[0];
      if (selected !== undefined) selectFile(selected);
    },
    onReselectRequired: setMessage,
  });

  const reset = () => {
    invalidateActiveWork();
    clearResult();
    clearThumbnails();
    setFile(undefined);
    setSourcePageCount(0);
    setPagePlan([]);
    pagePlanRef.current = [];
    setInspecting(false);
    setProcessing(false);
    setMessage("PDF를 선택하면 바로 준비할게요.");
  };

  const cancelInspection = () => {
    invalidateActiveWork();
    clearThumbnails();
    setFile(undefined);
    setSourcePageCount(0);
    setPagePlan([]);
    setInspecting(false);
    setMessage("페이지 확인을 중단했어요.");
  };

  const updatePlan = (next: PdfPagePlan, nextMessage: string) => {
    pagePlanRef.current = next;
    setPagePlan(next);
    clearResult();
    setMessage(nextMessage);
  };

  const movePage = (index: number, direction: -1 | 1) => {
    const item = pagePlanRef.current[index];
    if (item === undefined) return;
    const next = movePdfPage(pagePlanRef.current, index, direction);
    if (next === pagePlanRef.current) return;
    updatePlan(next, `원본 ${item.sourcePage}페이지를 ${index + direction + 1}번째로 옮겼어요.`);
  };

  const rotatePage = (index: number) => {
    const item = pagePlanRef.current[index];
    if (item === undefined) return;
    updatePlan(
      rotatePdfPage(pagePlanRef.current, index, 1),
      `원본 ${item.sourcePage}페이지를 시계 방향으로 90도 돌렸어요.`,
    );
  };

  const deletePage = (index: number) => {
    const item = pagePlanRef.current[index];
    if (item === undefined || pagePlanRef.current.length === 1) return;
    updatePlan(
      removePdfPage(pagePlanRef.current, index),
      `원본 ${item.sourcePage}페이지를 결과에서 뺐어요.`,
    );
  };

  const resetPlan = () => {
    if (sourcePageCount < 1) return;
    updatePlan(createPdfPagePlan(sourcePageCount), "페이지 순서와 회전을 초기화했어요.");
  };

  const dropPage = (targetIndex: number) => {
    const sourcePage = draggedSourcePageRef.current;
    draggedSourcePageRef.current = undefined;
    if (sourcePage === undefined) return;
    const from = pagePlanRef.current.findIndex((item) => item.sourcePage === sourcePage);
    if (from < 0 || from === targetIndex) return;
    const next = movePageToIndex(pagePlanRef.current, from, targetIndex);
    updatePlan(next, `원본 ${sourcePage}페이지를 ${targetIndex + 1}번째로 옮겼어요.`);
  };

  const startProcessing = async () => {
    const selectedFile = fileRef.current;
    const plan = pagePlanRef.current;
    if (processing || selectedFile === undefined || plan.length < 1) return;
    const productRun = startProductUsageRun(toolId);
    productRunRef.current = productRun;
    thumbnailRef.current?.cancel();
    thumbnailRef.current = undefined;
    setThumbnails(
      (current) =>
        new Map(
          Array.from(current, ([sourcePage, thumbnail]) => [
            sourcePage,
            thumbnail.status === "pending" ? ({ status: "failed" } as const) : thumbnail,
          ]),
        ),
    );
    const runId = runRef.current + 1;
    runRef.current = runId;
    clearResult();
    setProcessing(true);
    setProgress(0);
    setPhase("validating");
    setMessage("PDF를 이 기기에서 정리하고 있어요.");

    let handle: PdfJobHandle | undefined;
    try {
      handle = runPdfJob(
        [selectedFile],
        {
          version: 1,
          operation: "organize",
          pages: plan.map((page) => ({ ...page })),
        },
        {
          onProgress(event) {
            if (runRef.current !== runId) return;
            setPhase(event.phase);
            setProgress((current) => Math.max(current, event.fraction));
          },
        },
      );
      jobRef.current = handle;
      const outcome = await handle.result;
      if (runRef.current !== runId) return;
      if (outcome.status === "fulfilled") {
        productRun.succeeded();
        const url = URL.createObjectURL(
          new Blob([outcome.value.bytes], { type: outcome.value.mime }),
        );
        resultUrlRef.current = url;
        setResultUrl(url);
        setResult({ ...outcome.value, bytes: new ArrayBuffer(0) });
        setProgress(1);
        setPhase("finalizing");
        setMessage("페이지 정리를 완료했어요.");
      } else if (outcome.status === "cancelled") {
        productRun.cancelled();
        setMessage("PDF 정리를 중단했어요.");
      } else {
        productRun.failed(outcome.error.code);
        setMessage(outcome.error.message);
      }
    } catch {
      if (runRef.current === runId) {
        productRun.failed("WORKER_CRASH");
        setMessage("PDF 작업기를 시작하지 못했어요. 최신 브라우저에서 다시 시도해 주세요.");
      }
    } finally {
      if (runRef.current === runId) {
        if (jobRef.current === handle) jobRef.current = undefined;
        if (productRunRef.current === productRun) productRunRef.current = null;
        setProcessing(false);
      }
    }
  };

  const cancelProcessing = () => {
    productRunRef.current?.cancelled();
    productRunRef.current = null;
    runRef.current += 1;
    jobRef.current?.cancel();
    jobRef.current = undefined;
    setProcessing(false);
    setMessage("PDF 정리를 중단했어요.");
  };

  const downloadResult = () => {
    const url = resultUrlRef.current;
    if (result === undefined || resultUrl === undefined || url !== resultUrl) return;
    try {
      reportDownloadRequested(toolId);
      downloadUrl(url, result.suggestedName);
      setMessage("다운로드를 시작했어요.");
    } catch {
      setMessage("다운로드를 시작하지 못했어요. 다시 시도해 주세요.");
    }
  };

  const onFileDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    if (busy) return;
    const selected = event.dataTransfer.files[0];
    if (selected !== undefined) selectFile(selected);
  };

  return (
    <section className={styles.shell} aria-labelledby="pdf-organize-stage-title">
      <input
        ref={inputRef}
        className={styles.hiddenInput}
        type="file"
        accept="application/pdf,.pdf"
        tabIndex={-1}
        disabled={!hydrated || !runtimeSupported || busy}
        onChange={(event) => {
          const selected = event.target.files?.[0];
          if (selected !== undefined) selectFile(selected);
          event.target.value = "";
        }}
      />

      {stage === "select" ? (
        <fieldset
          className={styles.selectStage}
          onDragOver={(event) => event.preventDefault()}
          onDrop={onFileDrop}
        >
          <legend className={styles.hiddenInput}>PDF 파일 선택</legend>
          <h2 id="pdf-organize-stage-title">정리할 PDF를 선택하세요</h2>
          <p>PDF 1개 · 최대 50MB · 최대 500페이지</p>
          <button
            className={styles.primaryButton}
            type="button"
            disabled={!hydrated || !runtimeSupported}
            onClick={() => inputRef.current?.click()}
          >
            정리할 PDF 선택
          </button>
          <p className={styles.localNotice}>파일은 이 기기에서만 처리돼요.</p>
        </fieldset>
      ) : stage === "inspecting" ? (
        <section className={styles.centerStage}>
          <h2 id="pdf-organize-stage-title" ref={stageHeadingRef} tabIndex={-1}>
            페이지 확인 중
          </h2>
          <p>{message}</p>
          <button className={styles.secondaryButton} type="button" onClick={cancelInspection}>
            중단
          </button>
        </section>
      ) : stage === "processing" ? (
        <section className={styles.centerStage}>
          <h2 id="pdf-organize-stage-title" ref={stageHeadingRef} tabIndex={-1}>
            PDF 정리하는 중
          </h2>
          <p>{phaseLabel(phase)}</p>
          <div
            className={styles.progressTrack}
            role="progressbar"
            aria-label="PDF 페이지 정리 진행률"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
          >
            <span style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <button className={styles.secondaryButton} type="button" onClick={cancelProcessing}>
            중단
          </button>
        </section>
      ) : result !== undefined ? (
        <section className={styles.resultStage}>
          <div className={styles.resultMark} aria-hidden="true">
            ✓
          </div>
          <h2 id="pdf-organize-stage-title" ref={stageHeadingRef} tabIndex={-1}>
            페이지 정리 완료
          </h2>
          <strong>
            원본 {sourcePageCount}페이지 → 결과 {result.outputPageCount}페이지
          </strong>
          <p>{formatBytes(result.byteLength)}</p>
          {result.warnings.includes("SIGNATURES_INVALIDATED") ? (
            <p className={styles.warning}>
              기존 전자서명은 유효하지 않으며 북마크·양식은 유지되지 않을 수 있어요.
            </p>
          ) : null}
          <button className={styles.primaryButton} type="button" onClick={downloadResult}>
            PDF 다운로드 ↓
          </button>
          <button className={styles.textButton} type="button" onClick={reset}>
            다른 PDF 정리
          </button>
        </section>
      ) : (
        <section className={styles.editStage}>
          <header className={styles.editHeader}>
            <div>
              <h2 id="pdf-organize-stage-title" ref={stageHeadingRef} tabIndex={-1}>
                페이지 순서 정리
              </h2>
              <p>
                {file?.name} · {file === undefined ? "" : formatBytes(file.size)} ·{" "}
                {pagePlan.length}
                페이지
              </p>
            </div>
            <div className={styles.headerActions}>
              <button type="button" onClick={() => inputRef.current?.click()}>
                PDF 교체
              </button>
              <button type="button" onClick={resetPlan}>
                초기화
              </button>
            </div>
          </header>

          <ol className={styles.pageGrid} aria-label="PDF 페이지 순서">
            {pagePlan.map((page, index) => {
              const thumbnail = thumbnails.get(page.sourcePage) ?? { status: "pending" };
              return (
                <li
                  className={styles.pageCard}
                  key={page.sourcePage}
                  aria-label={`결과 ${index + 1}번째, 원본 ${page.sourcePage}페이지, 회전 ${page.rotateBy}도`}
                  draggable
                  onDragStart={() => {
                    draggedSourcePageRef.current = page.sourcePage;
                  }}
                  onDragEnd={() => {
                    draggedSourcePageRef.current = undefined;
                  }}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    dropPage(index);
                  }}
                >
                  <div className={styles.cardTopline}>
                    <strong>{index + 1}</strong>
                    <span>원본 {page.sourcePage}페이지</span>
                  </div>
                  <div className={styles.previewFrame}>
                    {thumbnail.status === "ready" ? (
                      // biome-ignore lint/performance/noImgElement: local object URL thumbnail
                      <img
                        src={thumbnail.url}
                        alt=""
                        draggable={false}
                        width={thumbnail.width}
                        height={thumbnail.height}
                        style={{ transform: `rotate(${page.rotateBy}deg)` }}
                      />
                    ) : (
                      <span>
                        {thumbnail.status === "pending" ? "미리보기 생성 중" : "미리보기 없음"}
                      </span>
                    )}
                  </div>
                  <p>회전 {page.rotateBy}°</p>
                  <div className={styles.pageActions}>
                    <button
                      type="button"
                      aria-label={`원본 ${page.sourcePage}페이지 위로 이동`}
                      disabled={index === 0}
                      onClick={() => movePage(index, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label={`원본 ${page.sourcePage}페이지 아래로 이동`}
                      disabled={index === pagePlan.length - 1}
                      onClick={() => movePage(index, 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      aria-label={`원본 ${page.sourcePage}페이지 시계 방향으로 회전`}
                      onClick={() => rotatePage(index)}
                    >
                      ↻
                    </button>
                    <button
                      type="button"
                      aria-label={`원본 ${page.sourcePage}페이지 삭제`}
                      disabled={pagePlan.length === 1}
                      onClick={() => deletePage(index)}
                    >
                      ×
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>

          <footer className={styles.editFooter}>
            <p className={styles.localNotice}>파일은 이 기기에서만 처리돼요.</p>
            <button
              className={styles.primaryButton}
              type="button"
              onClick={() => void startProcessing()}
            >
              {pagePlan.length}페이지로 PDF 만들기
            </button>
          </footer>
        </section>
      )}

      <p className={styles.status} role="status" aria-live="polite" aria-atomic="true">
        {!hydrated
          ? "PDF 도구를 준비하고 있어요."
          : runtimeSupported
            ? message
            : "최신 Safari, Chrome, Firefox 또는 Edge에서 사용할 수 있어요."}
      </p>
    </section>
  );
}

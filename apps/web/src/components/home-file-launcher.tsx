"use client";

import { availableToolEntries, type FileKind } from "@hereisit/tool-registry/catalog";
import type { ToolRecommendation } from "@hereisit/tool-registry/discovery";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type ChangeEvent,
  type DragEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  type FileRecommendationGroup,
  type FileRecommendationPlan,
  planFileRecommendations,
} from "../lib/file-recommendations";
import {
  detectFileSelection,
  type FileDetectionItem,
  LauncherFileLimitError,
} from "../lib/file-selection-detection";
import { launcherStatusMessage } from "../lib/home-file-launcher-state";
import { replacePendingToolSelection } from "../lib/pending-tool-selection";
import styles from "./home-file-launcher.module.css";

type LauncherState =
  | { mode: "idle" }
  | { mode: "detecting"; completed: number; total: number }
  | { mode: "result"; itemCount: number; plan: FileRecommendationPlan }
  | { mode: "error"; message: string };

const KIND_LABELS: Partial<Record<FileKind, string>> = {
  "image/jpeg": "JPG 이미지",
  "image/png": "PNG 이미지",
  "image/webp": "WebP 이미지",
  "image/gif": "GIF 이미지",
  "image/tiff": "TIFF 이미지",
  "image/svg+xml": "SVG 이미지",
  "image/heic": "HEIC 이미지",
  "image/heif": "HEIF 이미지",
  "application/pdf": "PDF 문서",
  "text/plain": "텍스트 파일",
  "application/json": "JSON 파일",
  "application/zip": "ZIP 파일",
};

function kindLabel(kind: FileRecommendationGroup["kind"]): string {
  if (kind === "mixed") return "함께 처리할 수 있는 파일";
  return KIND_LABELS[kind] ?? "같은 형식의 파일";
}

function readinessCopy(recommendation: ToolRecommendation): string {
  if (recommendation.readiness === "ready") return "바로 시작할 수 있어요.";
  if (recommendation.readiness === "needs-more") {
    return `도구 화면에서 ${recommendation.missingFiles}개 파일을 더 선택해 주세요.`;
  }
  return `한 번에 최대 ${recommendation.maximumFiles}개까지 가능해요. 파일을 나눠 주세요.`;
}

export function HomeFileLauncher(): ReactNode {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const handoffErrorRef = useRef<HTMLDivElement>(null);
  const generationRef = useRef(0);
  const detectedItemsRef = useRef<readonly FileDetectionItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const [state, setState] = useState<LauncherState>({ mode: "idle" });
  const [handoffError, setHandoffError] = useState<string>();

  useEffect(
    () => () => {
      generationRef.current += 1;
      detectedItemsRef.current = [];
      if (inputRef.current !== null) inputRef.current.value = "";
    },
    [],
  );

  function resetSelection(): void {
    generationRef.current += 1;
    detectedItemsRef.current = [];
    if (inputRef.current !== null) inputRef.current.value = "";
    setDragging(false);
    setHandoffError(undefined);
    setState({ mode: "idle" });
  }

  async function inspectSelection(files: readonly File[]): Promise<void> {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    detectedItemsRef.current = [];
    if (inputRef.current !== null) inputRef.current.value = "";
    setDragging(false);
    setHandoffError(undefined);

    if (files.length === 0) {
      setState({ mode: "idle" });
      return;
    }

    setState({ mode: "detecting", completed: 0, total: files.length });
    try {
      const detected = await detectFileSelection(files, {
        isCurrent: () => generationRef.current === generation,
        onProgress: ({ completed, total }) => {
          if (generationRef.current === generation) {
            setState({ mode: "detecting", completed, total });
          }
        },
      });
      if (detected === null || generationRef.current !== generation) return;
      detectedItemsRef.current = detected;
      setState({
        mode: "result",
        itemCount: detected.length,
        plan: planFileRecommendations(detected),
      });
    } catch (error) {
      if (generationRef.current !== generation) return;
      generationRef.current += 1;
      detectedItemsRef.current = [];
      setState({
        mode: "error",
        message:
          error instanceof LauncherFileLimitError
            ? `파일은 한 번에 최대 ${error.maximum}개까지 선택할 수 있어요. 파일을 나눠 주세요.`
            : "파일 형식을 확인하지 못했어요. 다른 파일을 선택해 주세요.",
      });
    }
  }

  function handleInputChange(event: ChangeEvent<HTMLInputElement>): void {
    const files = Array.from(event.currentTarget.files ?? []);
    void inspectSelection(files);
  }

  function handleDrop(event: DragEvent<HTMLFieldSetElement>): void {
    event.preventDefault();
    void inspectSelection(Array.from(event.dataTransfer.files));
  }

  function chooseRecommendation(
    group: FileRecommendationGroup,
    recommendation: ToolRecommendation,
  ): void {
    if (recommendation.readiness === "too-many") return;
    const canonicalTool = availableToolEntries.find(({ id }) => id === recommendation.tool.id);
    const liveItems = detectedItemsRef.current;
    const groupItemsAreLive = group.items.every((item) =>
      liveItems.some(
        (candidate) => candidate.file === item.file && candidate.detectedKind === item.detectedKind,
      ),
    );
    if (canonicalTool === undefined || group.items.length === 0 || !groupItemsAreLive) {
      setHandoffError("파일을 다시 선택해 주세요");
      requestAnimationFrame(() => handoffErrorRef.current?.focus());
      return;
    }

    replacePendingToolSelection(canonicalTool.id, group.items);
    router.push(canonicalTool.route);
  }

  const liveMessage = launcherStatusMessage(state);

  return (
    <section className={styles.section} aria-labelledby="file-launcher-title">
      <div className={styles.heading}>
        <p className="eyebrow">START WITH A FILE</p>
        <h2 id="file-launcher-title">파일을 고르면 맞는 도구를 찾아드려요.</h2>
        <p>업로드하지 않고 파일 앞부분만 기기 안에서 확인합니다.</p>
      </div>

      <fieldset
        aria-label="파일 선택 영역"
        className={styles.dropzone}
        data-dragging={dragging}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(event) => {
          const nextTarget = event.relatedTarget;
          if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
            setDragging(false);
          }
        }}
        onDragOver={(event) => event.preventDefault()}
        onDrop={handleDrop}
      >
        <input
          accept="image/jpeg,image/png,image/webp,image/gif,image/tiff,image/svg+xml,image/heic,image/heif,application/pdf,.jpg,.jpeg,.png,.webp,.gif,.tif,.tiff,.svg,.heic,.heif,.pdf"
          className={styles.fileInput}
          id="home-file-input"
          multiple
          onChange={handleInputChange}
          ref={inputRef}
          tabIndex={-1}
          type="file"
        />
        <strong>여기에 파일을 놓으세요</strong>
        <span>이미지와 PDF · 한 번에 최대 100개</span>
        <button
          className={styles.selectButton}
          onClick={() => inputRef.current?.click()}
          type="button"
        >
          파일 선택
        </button>
      </fieldset>

      {liveMessage === null ? null : (
        <p aria-atomic="true" aria-live="polite" className={styles.status} role="status">
          {liveMessage}
        </p>
      )}

      {state.mode === "error" ? (
        <p className={styles.correction} role="alert">
          {state.message}
        </p>
      ) : null}

      {state.mode === "result" ? (
        <div className={styles.results}>
          {state.plan.state === "unsupported" ? (
            <p className={styles.correction}>
              지원하는 파일 형식을 찾지 못했어요. 다른 파일을 선택하거나 모든 도구를 둘러보세요.
            </p>
          ) : (
            state.plan.groups.map((group) => (
              <section className={styles.group} key={group.kind}>
                <div className={styles.groupHeading}>
                  <h3>{kindLabel(group.kind)}</h3>
                  <span>{group.items.length}개</span>
                </div>
                <div className={styles.recommendations}>
                  <article className={styles.recommendation} data-primary="true">
                    <div>
                      <span className={styles.primaryLabel}>가장 잘 맞는 도구</span>
                      <strong>{group.primaryRecommendation.tool.name}</strong>
                      <p>{group.primaryRecommendation.tool.shortDescription}</p>
                      <small data-readiness={group.primaryRecommendation.readiness}>
                        {readinessCopy(group.primaryRecommendation)}
                      </small>
                    </div>
                    <button
                      aria-label={`${group.primaryRecommendation.tool.name} 도구 선택`}
                      disabled={group.primaryRecommendation.readiness === "too-many"}
                      onClick={() => chooseRecommendation(group, group.primaryRecommendation)}
                      type="button"
                    >
                      이 도구로 시작
                    </button>
                  </article>

                  {group.alternateRecommendations.length > 0 ? (
                    <details className={styles.alternates}>
                      <summary>다른 작업 {group.alternateRecommendations.length}개 보기</summary>
                      <div className={styles.alternateList}>
                        {group.alternateRecommendations.map((recommendation) => (
                          <article className={styles.recommendation} key={recommendation.tool.id}>
                            <div>
                              <strong>{recommendation.tool.name}</strong>
                              <p>{recommendation.tool.shortDescription}</p>
                              <small data-readiness={recommendation.readiness}>
                                {readinessCopy(recommendation)}
                              </small>
                            </div>
                            <button
                              aria-label={`${recommendation.tool.name} 도구 선택`}
                              disabled={recommendation.readiness === "too-many"}
                              onClick={() => chooseRecommendation(group, recommendation)}
                              type="button"
                            >
                              도구 선택
                            </button>
                          </article>
                        ))}
                      </div>
                    </details>
                  ) : null}
                </div>
              </section>
            ))
          )}

          {state.plan.unknownCount > 0 ? (
            <p className={styles.correction}>
              {state.plan.unknownCount}개 파일의 형식은 확인하지 못했어요. 해당 파일은 다른 파일로
              바꿔 주세요.
            </p>
          ) : null}

          <div className={styles.secondaryActions}>
            <button
              onClick={() => {
                resetSelection();
                inputRef.current?.click();
              }}
              type="button"
            >
              다른 파일 선택
            </button>
            <Link href="/tools" prefetch={false}>
              파일 없이 도구 찾기
            </Link>
          </div>
        </div>
      ) : null}

      {handoffError !== undefined ? (
        <div className={styles.errorSummary} ref={handoffErrorRef} role="alert" tabIndex={-1}>
          {handoffError}
        </div>
      ) : null}
    </section>
  );
}

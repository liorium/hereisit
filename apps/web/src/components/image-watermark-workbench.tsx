"use client";

import {
  runImageWatermarkBatch,
  supportsBrowserImageWatermarkRuntime,
} from "@hereisit/browser-runtime/image-watermark";
import { dedupeArchiveNames } from "@hereisit/image-tool";
import type {
  ImageWatermarkBatchHandle,
  ImageWatermarkPhase,
  ImageWatermarkPosition,
  ImageWatermarkResult,
  ImageWatermarkRuntimeEvent,
  ImageWatermarkSpecV1,
} from "@hereisit/tool-contracts";
import {
  type ChangeEvent,
  type DragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  createZipArchive,
  downloadUrl,
  formatBytes,
  formatDuration,
  isAbortError,
} from "../lib/files";
import styles from "./image-workbench.module.css";

const SOURCE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
const LOGO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_FILES = 100;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_INPUT_BYTES = 250 * 1024 * 1024;
const MAX_LOGO_BYTES = 10 * 1024 * 1024;

const POSITIONS: readonly { value: ImageWatermarkPosition; label: string }[] = [
  { value: "top-left", label: "왼쪽 위" },
  { value: "top-center", label: "가운데 위" },
  { value: "top-right", label: "오른쪽 위" },
  { value: "middle-left", label: "왼쪽 가운데" },
  { value: "center", label: "정가운데" },
  { value: "middle-right", label: "오른쪽 가운데" },
  { value: "bottom-left", label: "왼쪽 아래" },
  { value: "bottom-center", label: "가운데 아래" },
  { value: "bottom-right", label: "오른쪽 아래" },
];

type WatermarkMode = "text" | "logo";
type OutputFormat = "source" | "jpeg" | "png" | "webp";
type ItemStatus = "ready" | "queued" | "processing" | "completed" | "failed" | "cancelled";

interface WorkItem {
  id: string;
  file: File;
  previewUrl: string;
  result?: ImageWatermarkResult;
  resultUrl?: string;
  status: ItemStatus;
  phase?: ImageWatermarkPhase;
  progress: number;
  error?: string;
}

interface LogoSelection {
  file: File;
  previewUrl: string;
}

function makeId(): string {
  try {
    return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  } catch {
    return `${Date.now()}-${Math.random()}`;
  }
}

function isAcceptedSource(file: File): boolean {
  return (
    SOURCE_TYPES.has(file.type) ||
    (file.type === "" && /\.(?:jpe?g|png|webp|heic|heif)$/i.test(file.name))
  );
}

function isAcceptedLogo(file: File): boolean {
  return (
    LOGO_TYPES.has(file.type) || (file.type === "" && /\.(?:jpe?g|png|webp)$/i.test(file.name))
  );
}

function validWatermarkText(value: string): boolean {
  const normalized = value.trim().normalize("NFC");
  const characters = Array.from(normalized);
  return (
    normalized.length > 0 &&
    characters.length <= 80 &&
    characters.every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (
        code > 31 &&
        code !== 127 &&
        (code < 0x80 || code > 0x9f) &&
        code !== 0x2028 &&
        code !== 0x2029 &&
        (code < 0x202a || code > 0x202e) &&
        (code < 0x2066 || code > 0x2069)
      );
    })
  );
}

function resultBlob(result: ImageWatermarkResult): Blob {
  return new Blob([result.bytes], { type: result.mime });
}

function resetItem(item: WorkItem, status: ItemStatus = "ready", error?: string): WorkItem {
  const next: WorkItem = {
    id: item.id,
    file: item.file,
    previewUrl: item.previewUrl,
    status,
    progress: 0,
  };
  if (error !== undefined) next.error = error;
  return next;
}

function phaseLabel(phase?: ImageWatermarkPhase): string {
  if (phase === "validating") return "확인 중";
  if (phase === "decoding") return "이미지 읽는 중";
  if (phase === "compositing") return "워터마크 넣는 중";
  if (phase === "encoding") return "다시 인코딩 중";
  if (phase === "finalizing") return "마무리 중";
  return "대기 중";
}

function buildSpec(options: {
  mode: WatermarkMode;
  text: string;
  color: string;
  sizePercent: number;
  position: ImageWatermarkPosition;
  marginPercent: number;
  opacityPercent: number;
  outputFormat: OutputFormat;
  quality: number;
}): ImageWatermarkSpecV1 {
  const output: ImageWatermarkSpecV1["output"] =
    options.outputFormat === "png"
      ? { format: "png" }
      : options.outputFormat === "jpeg"
        ? { format: "jpeg", quality: options.quality, matte: "#ffffff" }
        : options.outputFormat === "webp"
          ? { format: "webp", quality: options.quality }
          : { format: "source", quality: options.quality };

  return {
    version: 1,
    watermark:
      options.mode === "text"
        ? {
            kind: "text",
            text: options.text,
            color: options.color,
            sizePercent: options.sizePercent,
          }
        : { kind: "logo", widthPercent: options.sizePercent },
    position: options.position,
    marginPercent: options.marginPercent,
    opacity: options.opacityPercent / 100,
    output,
    autoOrient: true,
    metadata: "strip",
  };
}

export function ImageWatermarkWorkbench() {
  const [items, setItems] = useState<WorkItem[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [logo, setLogo] = useState<LogoSelection>();
  const [mode, setMode] = useState<WatermarkMode>("text");
  const [text, setText] = useState("© HereIsIt");
  const [color, setColor] = useState("#111827");
  const [sizePercent, setSizePercent] = useState(12);
  const [position, setPosition] = useState<ImageWatermarkPosition>("bottom-right");
  const [marginPercent, setMarginPercent] = useState(3);
  const [opacityPercent, setOpacityPercent] = useState(55);
  const [outputFormat, setOutputFormat] = useState<OutputFormat>("source");
  const [quality, setQuality] = useState(90);
  const [processing, setProcessing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [runtimeSupported, setRuntimeSupported] = useState(false);
  const [message, setMessage] = useState("이미지를 선택하면 바로 준비할게요.");
  const [logoMessage, setLogoMessage] = useState<string>();

  const sourceInputRef = useRef<HTMLInputElement>(null);
  const logoInputRef = useRef<HTMLInputElement>(null);
  const batchRef = useRef<ImageWatermarkBatchHandle | undefined>(undefined);
  const logoRef = useRef<LogoSelection | undefined>(undefined);
  const activeGenerationRef = useRef(0);
  const itemsRef = useRef(items);
  const ownedUrlsRef = useRef(new Set<string>());
  const archiveLeasesRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const busy = processing || archiving;

  const commitItems = useCallback((update: (current: WorkItem[]) => WorkItem[]) => {
    const next = update(itemsRef.current);
    itemsRef.current = next;
    setItems(next);
  }, []);

  const createOwnedUrl = useCallback((blob: Blob): string => {
    const url = URL.createObjectURL(blob);
    ownedUrlsRef.current.add(url);
    return url;
  }, []);

  const revokeOwnedUrl = useCallback((url: string | undefined) => {
    if (url === undefined || !ownedUrlsRef.current.delete(url)) return;
    URL.revokeObjectURL(url);
  }, []);

  const releaseArchiveUrls = useCallback(() => {
    for (const [url, timeoutId] of archiveLeasesRef.current) {
      clearTimeout(timeoutId);
      revokeOwnedUrl(url);
    }
    archiveLeasesRef.current.clear();
  }, [revokeOwnedUrl]);

  useEffect(() => {
    setHydrated(true);
    setRuntimeSupported(supportsBrowserImageWatermarkRuntime());
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
      activeGenerationRef.current += 1;
      batchRef.current?.cancel();
      for (const timeoutId of archiveLeasesRef.current.values()) clearTimeout(timeoutId);
      archiveLeasesRef.current.clear();
      for (const url of ownedUrlsRef.current) URL.revokeObjectURL(url);
      ownedUrlsRef.current.clear();
    },
    [],
  );

  const invalidateResults = useCallback(
    (nextMessage = "설정이 바뀌었어요. 새 설정으로 다시 처리해 주세요.") => {
      activeGenerationRef.current += 1;
      releaseArchiveUrls();
      let changed = false;
      for (const item of itemsRef.current) {
        if (item.resultUrl !== undefined) {
          revokeOwnedUrl(item.resultUrl);
          changed = true;
        }
        if (item.status !== "ready" || item.error !== undefined) changed = true;
      }
      if (!changed) return;
      commitItems((current) => current.map((item) => resetItem(item)));
      setMessage(nextMessage);
    },
    [commitItems, releaseArchiveUrls, revokeOwnedUrl],
  );

  const addFiles = useCallback(
    (fileList: FileList | readonly File[]) => {
      if (!hydrated || !runtimeSupported || busy) return;
      const candidates = Array.from(fileList);
      const currentBytes = itemsRef.current.reduce((total, item) => total + item.file.size, 0);
      let remainingBytes = Math.max(0, MAX_TOTAL_INPUT_BYTES - currentBytes);
      const available = Math.max(0, MAX_FILES - itemsRef.current.length);
      const accepted: File[] = [];

      for (const file of candidates) {
        if (
          accepted.length >= available ||
          !isAcceptedSource(file) ||
          file.size < 1 ||
          file.size > MAX_FILE_BYTES ||
          file.size > remainingBytes
        ) {
          continue;
        }
        accepted.push(file);
        remainingBytes -= file.size;
      }

      if (accepted.length > 0) invalidateResults("파일이 바뀌었어요. 다시 처리해 주세요.");
      const additions = accepted.map<WorkItem>((file) => ({
        id: makeId(),
        file,
        previewUrl: createOwnedUrl(file),
        status: "ready",
        progress: 0,
      }));

      if (additions.length > 0) {
        commitItems((current) => [...current, ...additions]);
        setSelectedId((current) => current ?? additions[0]?.id);
        setMessage(`${additions.length}개 이미지를 준비했어요.`);
      }

      const rejected = candidates.length - additions.length;
      if (rejected > 0) {
        setMessage(
          `${additions.length}개를 추가했어요. ${rejected}개는 형식·파일당 50MB·총 250MB·개수 제한으로 제외했어요.`,
        );
      }
    },
    [busy, commitItems, createOwnedUrl, hydrated, invalidateResults, runtimeSupported],
  );

  const selected = useMemo(
    () => items.find((item) => item.id === selectedId) ?? items[0],
    [items, selectedId],
  );
  const completedItems = useMemo(
    () => items.filter((item) => item.status === "completed" && item.result !== undefined),
    [items],
  );
  const textIsValid = validWatermarkText(text);
  const logoIsValid = logo !== undefined;
  const canRun =
    hydrated &&
    runtimeSupported &&
    items.length > 0 &&
    !busy &&
    (mode === "text" ? textIsValid : logoIsValid);

  const applyRuntimeEvent = useCallback(
    (event: ImageWatermarkRuntimeEvent, generation: number) => {
      if (activeGenerationRef.current !== generation) return;
      if (event.type === "batch-progress") {
        setMessage(`${event.completed}/${event.total}개 완료 · 기기 안에서 처리 중이에요.`);
        return;
      }
      if (event.type === "item-progress") {
        commitItems((current) =>
          current.map((item) =>
            item.id === event.itemId
              ? {
                  ...item,
                  status: "processing",
                  phase: event.phase,
                  progress: event.fraction,
                }
              : item,
          ),
        );
        return;
      }

      const previous = itemsRef.current.find((item) => item.id === event.itemId);
      revokeOwnedUrl(previous?.resultUrl);
      if (event.result.status === "fulfilled") {
        const result = event.result.value;
        const resultUrl = createOwnedUrl(resultBlob(result));
        commitItems((current) =>
          current.map((item) =>
            item.id === event.itemId
              ? {
                  ...resetItem(item, "completed"),
                  result,
                  resultUrl,
                  progress: 1,
                }
              : item,
          ),
        );
        return;
      }

      const error =
        event.result.status === "cancelled" ? "작업을 중단했어요." : event.result.error.message;
      const status: ItemStatus = event.result.status === "cancelled" ? "cancelled" : "failed";
      commitItems((current) =>
        current.map((item) => (item.id === event.itemId ? resetItem(item, status, error) : item)),
      );
    },
    [commitItems, createOwnedUrl, revokeOwnedUrl],
  );

  const startProcessing = async () => {
    if (!canRun) return;
    releaseArchiveUrls();
    const sourceItems = itemsRef.current.map((item) => ({ id: item.id, file: item.file }));
    const generation = activeGenerationRef.current + 1;
    activeGenerationRef.current = generation;
    for (const item of itemsRef.current) revokeOwnedUrl(item.resultUrl);
    const queued = itemsRef.current.map((item) => resetItem(item, "queued"));
    itemsRef.current = queued;
    setItems(queued);
    setProcessing(true);
    setMessage(`${sourceItems.length}개 이미지에 워터마크를 넣고 있어요.`);

    const spec = buildSpec({
      mode,
      text,
      color,
      sizePercent,
      position,
      marginPercent,
      opacityPercent,
      outputFormat,
      quality,
    });

    let handle: ImageWatermarkBatchHandle | undefined;
    try {
      handle = runImageWatermarkBatch(
        sourceItems.map((item) => ({
          itemId: item.id,
          file: item.file,
          spec: structuredClone(spec),
        })),
        {
          concurrency: "auto",
          ...(mode === "logo" && logoRef.current !== undefined
            ? { logoFile: logoRef.current.file }
            : {}),
          onEvent: (event) => applyRuntimeEvent(event, generation),
        },
      );
      batchRef.current = handle;
      const results = await handle.result;
      if (activeGenerationRef.current !== generation) return;
      const completed = results.filter((result) => result.status === "fulfilled").length;
      const cancelled = results.filter((result) => result.status === "cancelled").length;
      const failed = results.length - completed - cancelled;
      if (completed === results.length) {
        setMessage(`${completed}개 이미지 워터마크 처리를 완료했어요.`);
      } else if (completed > 0) {
        setMessage(`${completed}개 완료, ${failed + cancelled}개는 처리하지 못했어요.`);
      } else if (cancelled > 0) {
        setMessage("작업을 중단했어요.");
      } else {
        setMessage("이미지를 처리하지 못했어요. 각 파일의 안내를 확인해 주세요.");
      }
    } catch {
      if (activeGenerationRef.current !== generation) return;
      commitItems((current) =>
        current.map((item) => resetItem(item, "failed", "브라우저 작업기를 시작하지 못했어요.")),
      );
      setMessage("이미지 워터마크 작업을 시작하지 못했어요. 브라우저 설정을 확인해 주세요.");
    } finally {
      if (activeGenerationRef.current === generation) {
        if (batchRef.current === handle) batchRef.current = undefined;
        setProcessing(false);
      }
    }
  };

  const cancelProcessing = () => {
    activeGenerationRef.current += 1;
    batchRef.current?.cancel();
    batchRef.current = undefined;
    setProcessing(false);
    const completed = itemsRef.current.filter((item) => item.status === "completed").length;
    commitItems((current) =>
      current.map((item) =>
        item.status === "completed" ? item : resetItem(item, "cancelled", "작업을 중단했어요."),
      ),
    );
    setMessage(
      completed > 0
        ? `작업을 중단했어요. 완료된 결과 ${completed}개는 저장할 수 있어요.`
        : "작업을 중단했어요.",
    );
  };

  const saveItem = async (item: WorkItem) => {
    if (item.result === undefined || item.resultUrl === undefined) return;
    const generation = activeGenerationRef.current;
    let shareData: ShareData | undefined;
    let canShare = false;
    if (typeof navigator.share === "function" && typeof navigator.canShare === "function") {
      shareData = {
        files: [
          new File([item.result.bytes], item.result.suggestedName, { type: item.result.mime }),
        ],
      };
      try {
        canShare = navigator.canShare(shareData);
      } catch {
        canShare = false;
      }
    }

    if (canShare && shareData !== undefined) {
      try {
        await navigator.share(shareData);
        if (activeGenerationRef.current === generation) setMessage("결과를 공유 메뉴로 보냈어요.");
        return;
      } catch (error) {
        if (isAbortError(error) || activeGenerationRef.current !== generation) return;
      }
    }

    const current = itemsRef.current.find((candidate) => candidate.id === item.id);
    if (
      activeGenerationRef.current !== generation ||
      current?.resultUrl !== item.resultUrl ||
      current.result === undefined
    ) {
      return;
    }
    downloadUrl(item.resultUrl, item.result.suggestedName);
    setMessage("결과 파일을 저장했어요.");
  };

  const downloadAll = async () => {
    if (completedItems.length < 2 || archiving) return;
    const generation = activeGenerationRef.current;
    setArchiving(true);
    setMessage("ZIP 파일을 만들고 있어요.");
    try {
      const names = dedupeArchiveNames(
        completedItems.flatMap((item) =>
          item.result === undefined ? [] : [item.result.suggestedName],
        ),
      );
      let nameIndex = 0;
      const archive = await createZipArchive(
        completedItems.flatMap((item) => {
          if (item.result === undefined) return [];
          const name = names[nameIndex] ?? item.result.suggestedName;
          nameIndex += 1;
          return [{ name, bytes: item.result.bytes }];
        }),
      );
      if (activeGenerationRef.current !== generation) return;
      const url = createOwnedUrl(archive);
      try {
        downloadUrl(url, "hereisit-watermarked-images.zip");
        const timeoutId = setTimeout(() => {
          if (!archiveLeasesRef.current.delete(url)) return;
          revokeOwnedUrl(url);
        }, 10_000);
        archiveLeasesRef.current.set(url, timeoutId);
      } catch (error) {
        revokeOwnedUrl(url);
        throw error;
      }
      setMessage(`${completedItems.length}개 결과를 ZIP으로 만들었어요.`);
    } catch {
      if (activeGenerationRef.current === generation) {
        setMessage("ZIP 파일을 만들지 못했어요. 개별 결과를 저장해 주세요.");
      }
    } finally {
      if (activeGenerationRef.current === generation) setArchiving(false);
    }
  };

  const removeItem = (id: string) => {
    if (busy) return;
    invalidateResults("파일이 바뀌었어요. 다시 처리해 주세요.");
    const target = itemsRef.current.find((item) => item.id === id);
    if (target === undefined) return;
    revokeOwnedUrl(target.previewUrl);
    revokeOwnedUrl(target.resultUrl);
    const next = itemsRef.current.filter((item) => item.id !== id);
    itemsRef.current = next;
    setItems(next);
    setSelectedId((current) => (current === id ? next[0]?.id : current));
    if (next.length === 0) setMessage("이미지를 선택하면 바로 준비할게요.");
  };

  const replaceLogo = (file: File | undefined) => {
    invalidateResults("로고가 바뀌었어요. 다시 처리해 주세요.");
    revokeOwnedUrl(logoRef.current?.previewUrl);
    logoRef.current = undefined;
    setLogo(undefined);
    setLogoMessage(undefined);
    if (file === undefined) return;
    if (!isAcceptedLogo(file)) {
      setLogoMessage("로고는 JPG, PNG 또는 WebP 파일을 선택해 주세요.");
      return;
    }
    if (file.size < 1 || file.size > MAX_LOGO_BYTES) {
      setLogoMessage("로고는 비어 있지 않은 10MB 이하 파일이어야 해요.");
      return;
    }
    const selection = { file, previewUrl: createOwnedUrl(file) };
    logoRef.current = selection;
    setLogo(selection);
    setLogoMessage("선택한 로고는 작업할 때 한 번만 읽어요.");
  };

  const reset = () => {
    activeGenerationRef.current += 1;
    batchRef.current?.cancel();
    batchRef.current = undefined;
    releaseArchiveUrls();
    for (const url of ownedUrlsRef.current) URL.revokeObjectURL(url);
    ownedUrlsRef.current.clear();
    itemsRef.current = [];
    setItems([]);
    setSelectedId(undefined);
    logoRef.current = undefined;
    setLogo(undefined);
    setLogoMessage(undefined);
    setMode("text");
    setText("© HereIsIt");
    setColor("#111827");
    setSizePercent(12);
    setPosition("bottom-right");
    setMarginPercent(3);
    setOpacityPercent(55);
    setOutputFormat("source");
    setQuality(90);
    setProcessing(false);
    setArchiving(false);
    setDragging(false);
    setMessage("이미지를 선택하면 바로 준비할게요.");
    if (sourceInputRef.current !== null) sourceInputRef.current.value = "";
    if (logoInputRef.current !== null) logoInputRef.current.value = "";
  };

  const changeSetting = (change: () => void) => {
    invalidateResults();
    change();
  };

  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragging(false);
    if (!busy) addFiles(event.dataTransfer.files);
  };

  const onSourceChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files !== null) addFiles(event.target.files);
    event.target.value = "";
  };

  return (
    <section className={styles.shell} aria-labelledby="image-watermark-workbench-title">
      <input
        ref={sourceInputRef}
        className={styles.hiddenInput}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif"
        multiple
        tabIndex={-1}
        disabled={!hydrated || busy || !runtimeSupported}
        onChange={onSourceChange}
      />
      <input
        ref={logoInputRef}
        className={styles.hiddenInput}
        type="file"
        accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
        tabIndex={-1}
        disabled={busy}
        onChange={(event) => {
          replaceLogo(event.target.files?.[0]);
          event.target.value = "";
        }}
      />

      {items.length === 0 ? (
        <section
          className={`${styles.emptyDropzone} ${dragging ? styles.dragging : ""}`}
          aria-labelledby="image-watermark-workbench-title"
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
          <div>
            <p className={styles.dropEyebrow}>LOCAL IMAGE WATERMARK</p>
            <h2 id="image-watermark-workbench-title">워터마크를 넣을 이미지를 선택하세요</h2>
            <p>JPG, PNG, WebP, HEIC · 파일당 50MB · 총 250MB · 최대 100개</p>
          </div>
          <div className={styles.dropActions}>
            <button
              className={styles.primaryButton}
              type="button"
              disabled={!hydrated || !runtimeSupported}
              onClick={() => sourceInputRef.current?.click()}
            >
              이미지 선택
            </button>
            <span className={styles.pasteHint}>원본은 바뀌지 않아요</span>
            <p className={styles.emptyStatus} role="status" aria-live="polite" aria-atomic="true">
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
              <p className={styles.dropEyebrow}>LOCAL IMAGE WATERMARK</p>
              <h2 id="image-watermark-workbench-title">이미지 워터마크 작업대</h2>
            </div>
            <div className={styles.headerActions}>
              <button type="button" disabled={busy} onClick={() => sourceInputRef.current?.click()}>
                ＋ 추가
              </button>
              <button type="button" disabled={busy} onClick={reset}>
                처음부터
              </button>
            </div>
          </div>

          {hydrated && !runtimeSupported ? (
            <div className={styles.runtimeWarning} role="alert">
              현재 브라우저는 로컬 이미지 워터마크 Worker를 지원하지 않습니다. 최신 Safari, Chrome,
              Firefox 또는 Edge를 사용해 주세요.
            </div>
          ) : null}

          <div className={styles.workspaceGrid}>
            <aside className={styles.filePanel} aria-label="선택한 이미지">
              <div className={styles.panelTitle}>
                <strong>파일</strong>
                <span>{items.length}</span>
              </div>
              <div className={styles.fileList}>
                {items.map((item) => (
                  <div
                    className={`${styles.fileRow} ${selected?.id === item.id ? styles.selectedFile : ""}`}
                    key={item.id}
                  >
                    <button
                      className={styles.fileSelect}
                      type="button"
                      onClick={() => setSelectedId(item.id)}
                    >
                      {/* biome-ignore lint/performance/noImgElement: local object URL thumbnail */}
                      <img src={item.previewUrl} alt="" />
                      <span className={styles.fileCopy}>
                        <strong>{item.file.name}</strong>
                        <small>
                          {item.status === "processing"
                            ? `${phaseLabel(item.phase)} · ${Math.round(item.progress * 100)}%`
                            : item.status === "completed"
                              ? "완료"
                              : item.status === "failed"
                                ? "처리 실패"
                                : item.status === "cancelled"
                                  ? "취소됨"
                                  : formatBytes(item.file.size)}
                        </small>
                      </span>
                    </button>
                    <button
                      className={styles.removeButton}
                      type="button"
                      aria-label={`${item.file.name} 제거`}
                      disabled={busy}
                      onClick={() => removeItem(item.id)}
                    >
                      ×
                    </button>
                    {item.status === "processing" ? (
                      <span
                        className={styles.rowProgress}
                        style={{ width: `${Math.round(item.progress * 100)}%` }}
                      />
                    ) : null}
                  </div>
                ))}
              </div>
            </aside>

            <section className={styles.previewPanel} aria-label="원본과 워터마크 결과">
              <div className={styles.previewTopline}>
                <span>{selected?.file.name}</span>
                <span>{selected === undefined ? "" : formatBytes(selected.file.size)}</span>
              </div>
              <div
                className={`${styles.previewStage} ${selected?.resultUrl !== undefined ? styles.withResult : ""}`}
              >
                {selected !== undefined ? (
                  <figure>
                    {/* biome-ignore lint/performance/noImgElement: local object URL preview */}
                    <img src={selected.previewUrl} alt={`${selected.file.name} 원본`} />
                    <figcaption>
                      {selected.result === undefined
                        ? "원본"
                        : `원본 ${selected.result.width}×${selected.result.height}`}
                    </figcaption>
                  </figure>
                ) : null}
                {selected?.resultUrl !== undefined && selected.result !== undefined ? (
                  <figure>
                    {/* biome-ignore lint/performance/noImgElement: local generated result */}
                    <img src={selected.resultUrl} alt={`${selected.file.name} 워터마크 결과`} />
                    <figcaption>
                      <strong>
                        결과 {selected.result.width}×{selected.result.height}
                      </strong>{" "}
                      · {formatBytes(selected.result.byteLength)} ·{" "}
                      {formatDuration(selected.result.timing.totalMs)}
                    </figcaption>
                    <button
                      className={styles.inlineDownload}
                      type="button"
                      onClick={() => void saveItem(selected)}
                    >
                      선택 파일 받기 ↓
                    </button>
                  </figure>
                ) : null}
                {selected?.resultUrl === undefined ? (
                  <div className={styles.previewMemoryNotice}>
                    <strong>설정을 고른 뒤 직접 실행하세요.</strong>
                    <span>자동 저장하지 않으며 결과는 이 탭 안에만 보관해요.</span>
                  </div>
                ) : null}
              </div>
              {selected?.result !== undefined ? (
                <p className={styles.previewMemoryNotice}>
                  <strong>
                    {selected.result.width}×{selected.result.height}
                  </strong>
                  <span>메타데이터는 제거되며 결과는 다시 인코딩됩니다.</span>
                </p>
              ) : null}
              {selected?.error !== undefined ? (
                <p className={styles.itemError} role="alert">
                  {selected.error}
                </p>
              ) : null}
            </section>

            <aside
              className={`${styles.settingsPanel} ${styles.watermarkSettings}`}
              aria-label="워터마크 설정"
            >
              <div className={styles.panelTitle}>
                <strong>설정</strong>
                <span>image.watermark@1</span>
              </div>

              <fieldset className={styles.settingsGroup} disabled={busy}>
                <legend>워터마크 종류</legend>
                <div className={styles.modeTabs}>
                  <label className={mode === "text" ? styles.activeMode : ""}>
                    <input
                      type="radio"
                      name="watermark-mode"
                      checked={mode === "text"}
                      onChange={() =>
                        changeSetting(() => {
                          setMode("text");
                          setSizePercent((current) => Math.min(30, Math.max(4, current)));
                        })
                      }
                    />
                    문구
                  </label>
                  <label className={mode === "logo" ? styles.activeMode : ""}>
                    <input
                      type="radio"
                      name="watermark-mode"
                      checked={mode === "logo"}
                      onChange={() =>
                        changeSetting(() => {
                          setMode("logo");
                          setSizePercent((current) => Math.min(50, Math.max(5, current)));
                        })
                      }
                    />
                    로고 이미지
                  </label>
                </div>

                {mode === "text" ? (
                  <div className={styles.textControlGrid}>
                    <label className={styles.textField}>
                      <span>워터마크 문구</span>
                      <input
                        value={text}
                        aria-invalid={!textIsValid}
                        onChange={(event) => {
                          const value = event.target.value;
                          changeSetting(() => setText(value));
                        }}
                      />
                    </label>
                    <label className={styles.colorField}>
                      <span>문구 색상</span>
                      <input
                        type="color"
                        value={color}
                        onChange={(event) => {
                          const value = event.target.value;
                          changeSetting(() => setColor(value));
                        }}
                      />
                    </label>
                    {!textIsValid ? (
                      <p className={styles.itemError}>문구는 줄바꿈 없이 1~80자로 입력해 주세요.</p>
                    ) : null}
                  </div>
                ) : (
                  <div className={styles.logoPicker}>
                    {logo !== undefined ? (
                      <>
                        {/* biome-ignore lint/performance/noImgElement: local object URL logo preview */}
                        <img src={logo.previewUrl} alt="선택한 워터마크 로고" />
                      </>
                    ) : null}
                    <div>
                      <button type="button" onClick={() => logoInputRef.current?.click()}>
                        {logo === undefined ? "로고 선택" : "로고 바꾸기"}
                      </button>
                      {logo !== undefined ? (
                        <button type="button" onClick={() => replaceLogo(undefined)}>
                          로고 제거
                        </button>
                      ) : null}
                    </div>
                    <p
                      data-watermark-logo-hint
                      className={
                        logoMessage === undefined && logo === undefined ? styles.itemError : ""
                      }
                    >
                      {logoMessage ?? "JPG, PNG 또는 WebP 로고를 선택해 주세요. 최대 10MB"}
                    </p>
                  </div>
                )}
              </fieldset>

              <fieldset className={styles.settingsGroup} disabled={busy}>
                <legend>위치</legend>
                <div className={styles.positionGrid}>
                  {POSITIONS.map((option) => (
                    <label
                      className={`${styles.positionOption} ${position === option.value ? styles.selectedPosition : ""}`}
                      key={option.value}
                    >
                      <input
                        type="radio"
                        name="watermark-position"
                        value={option.value}
                        checked={position === option.value}
                        onChange={() => changeSetting(() => setPosition(option.value))}
                      />
                      <span>{option.label}</span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <fieldset className={styles.settingsGroup} disabled={busy}>
                <legend>크기와 투명도</legend>
                <label className={styles.rangeValueRow}>
                  <span>{mode === "text" ? "문구 크기" : "로고 크기"}</span>
                  <strong>{sizePercent}%</strong>
                  <input
                    type="range"
                    min={mode === "text" ? 4 : 5}
                    max={mode === "text" ? 30 : 50}
                    value={sizePercent}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      changeSetting(() => setSizePercent(value));
                    }}
                  />
                </label>
                <label className={styles.rangeValueRow}>
                  <span>여백</span>
                  <strong>{marginPercent}%</strong>
                  <input
                    type="range"
                    min="0"
                    max="10"
                    value={marginPercent}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      changeSetting(() => setMarginPercent(value));
                    }}
                  />
                </label>
                <label className={styles.rangeValueRow}>
                  <span>불투명도</span>
                  <strong>{opacityPercent}%</strong>
                  <input
                    type="range"
                    min="5"
                    max="100"
                    value={opacityPercent}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      changeSetting(() => setOpacityPercent(value));
                    }}
                  />
                </label>
              </fieldset>

              <fieldset className={styles.settingsGroup} disabled={busy}>
                <legend>출력</legend>
                <label className={styles.selectField}>
                  <span>출력 형식</span>
                  <select
                    value={outputFormat}
                    onChange={(event) => {
                      const value = event.target.value as OutputFormat;
                      changeSetting(() => setOutputFormat(value));
                    }}
                  >
                    <option value="source">원본 형식</option>
                    <option value="jpeg">JPG</option>
                    <option value="png">PNG</option>
                    <option value="webp">WebP</option>
                  </select>
                </label>
                <label className={styles.rangeValueRow}>
                  <span>품질</span>
                  <strong>{quality}</strong>
                  <input
                    type="range"
                    min="40"
                    max="95"
                    value={quality}
                    disabled={outputFormat === "png"}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      changeSetting(() => setQuality(value));
                    }}
                  />
                </label>
              </fieldset>

              <div className={styles.privacyNotice}>
                <span aria-hidden="true">✓</span>
                <p className={styles.privacyCopy}>
                  <strong>파일은 서버로 전송되지 않아요.</strong>
                  원본은 그대로예요. 촬영 위치와 기기 정보는 결과에 넣지 않으며 새 파일로 만드는
                  과정에서 용량이나 색상이 달라질 수 있어요.
                </p>
              </div>
            </aside>
          </div>

          <div className={styles.actionBar}>
            <div className={styles.statusCopy} role="status" aria-live="polite" aria-atomic="true">
              <strong>{message}</strong>
              <span>
                {completedItems.length > 0
                  ? `${completedItems.length}/${items.length}개 결과 준비됨`
                  : "업로드 없음 · 결과는 명시적으로 저장할 때만 내려받아요."}
              </span>
            </div>
            <div className={styles.actionButtons}>
              {processing ? (
                <button className={styles.cancelButton} type="button" onClick={cancelProcessing}>
                  작업 중단
                </button>
              ) : (
                <button
                  className={styles.runButton}
                  type="button"
                  disabled={!canRun}
                  onClick={() => void startProcessing()}
                >
                  {items.length}개 이미지에 워터마크 넣기 →
                </button>
              )}
              {completedItems.length === 1 ? (
                <button
                  className={styles.secondaryButton}
                  type="button"
                  onClick={() => void saveItem(completedItems[0] as WorkItem)}
                >
                  결과 저장·공유 ↓
                </button>
              ) : null}
              {completedItems.length > 1 ? (
                <button
                  className={styles.secondaryButton}
                  type="button"
                  disabled={archiving}
                  onClick={() => void downloadAll()}
                >
                  결과 {completedItems.length}개 ZIP으로 받기 ↓
                </button>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

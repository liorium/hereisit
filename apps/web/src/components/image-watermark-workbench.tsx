"use client";

import {
  runImageWatermarkBatch,
  supportsBrowserImageWatermarkRuntime,
} from "@hereisit/browser-runtime/image-watermark";
import { useEffect, useRef, useState } from "react";
import styles from "./image-workbench.module.css";

export function ImageWatermarkWorkbench() {
  const [runtimeSupported, setRuntimeSupported] = useState<boolean>();
  // Keep the public batch entry in this route graph so its dedicated Worker stays route-isolated.
  const batchRunnerRef = useRef(runImageWatermarkBatch);

  useEffect(() => {
    setRuntimeSupported(
      supportsBrowserImageWatermarkRuntime() && typeof batchRunnerRef.current === "function",
    );
  }, []);

  return (
    <section className={styles.shell} aria-labelledby="image-watermark-workbench-title">
      <section className={styles.emptyDropzone} aria-labelledby="image-watermark-workbench-title">
        <div className={styles.dropIcon} aria-hidden="true">
          <span>＋</span>
        </div>
        <div>
          <p className={styles.dropEyebrow}>LOCAL IMAGE WATERMARK</p>
          <h2 id="image-watermark-workbench-title">이미지 워터마크 작업대</h2>
          <p>문구 또는 로고 워터마크를 기기 안에서 처리할 준비를 하고 있어요.</p>
        </div>
        <div className={styles.dropActions}>
          <p className={styles.emptyStatus} role="status" aria-live="polite" aria-atomic="true">
            {runtimeSupported === undefined
              ? "도구를 준비하고 있어요…"
              : runtimeSupported
                ? "워터마크 작업 환경을 확인했어요. 설정 화면은 준비 중이에요."
                : "최신 Safari, Chrome, Firefox 또는 Edge에서 사용할 수 있어요."}
          </p>
        </div>
        <div className={styles.localBadge}>
          <span aria-hidden="true">✓</span> 업로드 없음 · 내 기기에서 처리
        </div>
      </section>
    </section>
  );
}

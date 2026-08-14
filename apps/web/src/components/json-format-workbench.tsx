"use client";

import { useRef, useState } from "react";
import {
  type JsonFormatErrorCode,
  type JsonFormatMode,
  transformJsonText,
} from "../lib/json-format";
import styles from "./json-format-workbench.module.css";

type OutputState = { mode: JsonFormatMode; text: string } | null;
type Feedback =
  | { tone: "success"; message: string }
  | { tone: "error"; code: JsonFormatErrorCode | "COPY_FAILED"; message: string }
  | null;

const errorMessages: Record<JsonFormatErrorCode, string> = {
  EMPTY_INPUT: "JSON을 입력해 주세요.",
  INPUT_TOO_LARGE: "JSON은 1MB 이하로 입력해 주세요.",
  INVALID_JSON: "올바른 JSON 형식이 아니에요. 괄호, 쉼표와 따옴표를 확인해 주세요.",
  NESTING_TOO_DEEP: "JSON 중첩은 100단계 이하로 줄여 주세요.",
  OUTPUT_TOO_LARGE: "정리한 결과가 4MB를 넘어요. 입력을 나누어 다시 시도해 주세요.",
};

export function JsonFormatWorkbench() {
  const [source, setSource] = useState("");
  const [output, setOutput] = useState<OutputState>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);

  function run(mode: JsonFormatMode): void {
    const result = transformJsonText(source, mode);
    if (!result.ok) {
      setOutput(null);
      setFeedback({ tone: "error", code: result.code, message: errorMessages[result.code] });
      requestAnimationFrame(() => errorRef.current?.focus());
      return;
    }

    setOutput({ mode, text: result.output });
    setFeedback({
      tone: "success",
      message: mode === "pretty" ? "JSON을 읽기 좋게 정리했어요." : "JSON 공백을 줄였어요.",
    });
  }

  async function copyResult(): Promise<void> {
    if (output === null) return;
    try {
      await navigator.clipboard.writeText(output.text);
      setFeedback({ tone: "success", message: "결과를 복사했어요." });
    } catch {
      setFeedback({
        tone: "error",
        code: "COPY_FAILED",
        message: "복사하지 못했어요. 결과를 직접 선택해 복사해 주세요.",
      });
      requestAnimationFrame(() => errorRef.current?.focus());
    }
  }

  function downloadResult(): void {
    if (output === null) return;
    const url = URL.createObjectURL(
      new Blob([output.text], { type: "application/json;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = output.mode === "pretty" ? "formatted.json" : "minified.json";
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  function reset(): void {
    setSource("");
    setOutput(null);
    setFeedback(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  return (
    <div className={styles.workbench}>
      <div className={styles.field}>
        <div className={styles.fieldHeading}>
          <label htmlFor="json-source">JSON 입력</label>
          <span>최대 1MB</span>
        </div>
        <textarea
          aria-describedby={feedback?.tone === "error" ? "json-format-feedback" : undefined}
          id="json-source"
          onChange={(event) => {
            setSource(event.currentTarget.value);
            setOutput(null);
            setFeedback(null);
          }}
          placeholder={'예: {"name":"HereIsIt"}'}
          ref={inputRef}
          spellCheck={false}
          value={source}
        />
      </div>

      <fieldset aria-label="JSON 작업" className={styles.actions}>
        <button className={styles.primary} onClick={() => run("pretty")} type="button">
          정리하기
        </button>
        <button onClick={() => run("minify")} type="button">
          공백 줄이기
        </button>
        <button onClick={reset} type="button">
          지우기
        </button>
      </fieldset>

      {feedback?.tone === "error" ? (
        <p
          className={styles.error}
          id="json-format-feedback"
          ref={errorRef}
          role="alert"
          tabIndex={-1}
        >
          {feedback.message}
        </p>
      ) : (
        <p aria-live="polite" className={styles.status} role="status">
          {feedback?.message ?? "입력한 내용은 이 브라우저에서만 처리해요."}
        </p>
      )}

      {output === null ? null : (
        <div className={styles.field}>
          <div className={styles.fieldHeading}>
            <label htmlFor="json-result">결과</label>
            <span>{output.mode === "pretty" ? "정리됨" : "공백 축소됨"}</span>
          </div>
          <textarea id="json-result" readOnly spellCheck={false} value={output.text} />
          <fieldset aria-label="결과 작업" className={styles.resultActions}>
            <button onClick={copyResult} type="button">
              결과 복사
            </button>
            <button onClick={downloadResult} type="button">
              JSON 다운로드
            </button>
          </fieldset>
        </div>
      )}
    </div>
  );
}

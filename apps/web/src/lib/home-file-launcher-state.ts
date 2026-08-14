export type LauncherStatusState =
  | { mode: "idle" }
  | { mode: "detecting"; completed: number; total: number }
  | { mode: "result"; itemCount: number }
  | { mode: "error" };

export function launcherStatusMessage(state: LauncherStatusState): string | null {
  if (state.mode === "detecting") return `${state.completed}/${state.total}개 형식 확인 중`;
  if (state.mode === "result") return `${state.itemCount}개 파일 형식 확인 완료`;
  if (state.mode === "error") return null;
  return "파일을 선택하면 기기 안에서 형식만 확인해요.";
}

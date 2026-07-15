export interface FocusAndRevealTarget {
  focus(options?: FocusOptions): void;
  scrollIntoView(options?: boolean | ScrollIntoViewOptions): void;
}

export function focusAndRevealTab(tab: FocusAndRevealTarget | null): void {
  if (tab === null) return;
  tab.focus({ preventScroll: true });
  tab.scrollIntoView({ behavior: "auto", block: "nearest", inline: "nearest" });
}

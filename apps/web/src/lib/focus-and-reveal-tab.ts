export interface FocusAndRevealTarget {
  focus(options?: FocusOptions): void;
  getBoundingClientRect(): Pick<DOMRect, "left" | "right">;
  parentElement: FocusAndRevealScrollport | null;
}

interface FocusAndRevealScrollport {
  getBoundingClientRect(): Pick<DOMRect, "left" | "right">;
  scrollBy(options?: ScrollToOptions): void;
}

export function focusAndRevealTab(tab: FocusAndRevealTarget | null): void {
  if (tab === null) return;
  tab.focus({ preventScroll: true });
  const scrollport = tab.parentElement;
  if (scrollport === null) return;

  const tabBounds = tab.getBoundingClientRect();
  const scrollportBounds = scrollport.getBoundingClientRect();
  const hiddenLeft = tabBounds.left - scrollportBounds.left;
  if (hiddenLeft < 0) {
    scrollport.scrollBy({ behavior: "auto", left: hiddenLeft });
    return;
  }

  const hiddenRight = tabBounds.right - scrollportBounds.right;
  if (hiddenRight > 0) scrollport.scrollBy({ behavior: "auto", left: hiddenRight });
}

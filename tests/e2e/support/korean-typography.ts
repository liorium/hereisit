import { expect, type Locator, type Page } from "@playwright/test";

type WrapStyle = "balance" | "pretty";

type KoreanLayoutOptions = {
  forbiddenLastLines?: readonly string[];
  textWrap: WrapStyle;
};

export async function seedToolPreferences(
  page: Page,
  favorites: readonly string[] = [],
  recent: readonly string[] = [],
): Promise<void> {
  await page.addInitScript(
    ({ favoriteIds, recentIds }) => {
      window.localStorage.setItem("hereisit.favorite-tools.v1", JSON.stringify(favoriteIds));
      window.localStorage.setItem("hereisit.recent-tools.v1", JSON.stringify(recentIds));
    },
    { favoriteIds: favorites, recentIds: recent },
  );
}

export async function expectNoDocumentOverflow(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
}

export async function expectKoreanTextLayout(
  locator: Locator,
  options: KoreanLayoutOptions,
): Promise<void> {
  await expect(locator).toHaveCount(1);
  const report = await locator.evaluate((element, expectedWrap) => {
    const root = element as HTMLElement;
    const style = getComputedStyle(root);
    const rootRect = root.getBoundingClientRect();
    const runs: Array<{ end: number; node: Text; start: number }> = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let fullText = "";
    let current = walker.nextNode();
    while (current !== null) {
      const node = current as Text;
      const parent = node.parentElement;
      if (parent !== null) {
        const parentStyle = getComputedStyle(parent);
        if (parentStyle.display !== "none" && parentStyle.visibility !== "hidden") {
          const start = fullText.length;
          fullText += node.data;
          runs.push({ end: fullText.length, node, start });
        }
      }
      current = walker.nextNode();
    }

    function boundaryAt(offset: number): { node: Text; offset: number } | null {
      const run = runs.find(({ end, start }) => offset >= start && offset <= end);
      if (run === undefined) return null;
      return { node: run.node, offset: Math.min(offset - run.start, run.node.data.length) };
    }

    function rangeFor(start: number, end: number): Range | null {
      const first = boundaryAt(start);
      const last = boundaryAt(end);
      if (first === null || last === null) return null;
      const range = document.createRange();
      range.setStart(first.node, first.offset);
      range.setEnd(last.node, last.offset);
      return range;
    }

    function visibleRects(range: Range): DOMRect[] {
      return Array.from(range.getClientRects()).filter(
        (rect) =>
          rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom > rootRect.top + 0.5 &&
          rect.top < rootRect.bottom - 0.5 &&
          rect.right > rootRect.left + 0.5 &&
          rect.left < rootRect.right - 0.5,
      );
    }

    function lineTops(rects: readonly DOMRect[]): number[] {
      const tops: number[] = [];
      for (const rect of [...rects].sort((left, right) => left.top - right.top)) {
        if (!tops.some((top) => Math.abs(top - rect.top) <= 1)) tops.push(rect.top);
      }
      return tops;
    }

    function intrinsicWidth(text: string): number {
      const probe = document.createElement("span");
      probe.textContent = text;
      probe.style.position = "fixed";
      probe.style.visibility = "hidden";
      probe.style.whiteSpace = "nowrap";
      probe.style.font = style.font;
      probe.style.letterSpacing = style.letterSpacing;
      document.body.append(probe);
      const width = probe.getBoundingClientRect().width;
      probe.remove();
      return width;
    }

    const splitWords: string[] = [];
    const wordSegments = new Intl.Segmenter("ko", { granularity: "word" }).segment(fullText);
    for (const part of wordSegments) {
      if (!part.isWordLike || !/[가-힣]/u.test(part.segment)) continue;
      const range = rangeFor(part.index, part.index + part.segment.length);
      if (range === null) continue;
      const lines = lineTops(visibleRects(range));
      if (lines.length > 1 && intrinsicWidth(part.segment) <= root.clientWidth + 1) {
        splitWords.push(part.segment);
      }
    }

    const visualLines: Array<{ text: string; top: number }> = [];
    const graphemes = new Intl.Segmenter("ko", { granularity: "grapheme" }).segment(fullText);
    for (const part of graphemes) {
      const range = rangeFor(part.index, part.index + part.segment.length);
      if (range === null) continue;
      const rect = visibleRects(range)[0];
      if (rect === undefined) continue;
      let line = visualLines.find(({ top }) => Math.abs(top - rect.top) <= 1);
      if (line === undefined) {
        line = { text: "", top: rect.top };
        visualLines.push(line);
      }
      line.text += part.segment;
    }
    visualLines.sort((left, right) => left.top - right.top);

    return {
      clientWidth: root.clientWidth,
      lastLine: visualLines.at(-1)?.text.trim() ?? "",
      overflowWrap: style.overflowWrap,
      scrollWidth: root.scrollWidth,
      splitWords,
      supportsTextWrap:
        CSS.supports("text-wrap", expectedWrap) || CSS.supports("text-wrap-style", expectedWrap),
      textWrap: [
        style.getPropertyValue("text-wrap"),
        style.getPropertyValue("text-wrap-style"),
      ].join(" "),
      wordBreak: style.wordBreak,
    };
  }, options.textWrap);

  expect(report.wordBreak).toBe("keep-all");
  expect(report.overflowWrap).toBe("break-word");
  if (report.supportsTextWrap) expect(report.textWrap).toContain(options.textWrap);
  expect(report.splitWords).toEqual([]);
  expect(options.forbiddenLastLines ?? []).not.toContain(report.lastLine);
  expect(report.scrollWidth).toBeLessThanOrEqual(report.clientWidth + 1);
}

export async function expectUnbrokenPhrase(locator: Locator, text: string): Promise<void> {
  await expect(locator).toHaveText(text);
  const report = await locator.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const tops: number[] = [];
    for (const rect of Array.from(range.getClientRects())) {
      if (!tops.some((top) => Math.abs(top - rect.top) <= 1)) tops.push(rect.top);
    }
    const parent = element.parentElement as HTMLElement | null;
    const parentStyle = parent === null ? null : getComputedStyle(parent);
    const parentWidth =
      parent === null || parentStyle === null
        ? 0
        : parent.clientWidth -
          Number.parseFloat(parentStyle.paddingLeft) -
          Number.parseFloat(parentStyle.paddingRight);
    return {
      lineCount: tops.length,
      parentWidth,
      whiteSpace: getComputedStyle(element).whiteSpace,
      width: element.getBoundingClientRect().width,
    };
  });
  expect(report.whiteSpace).toBe("nowrap");
  expect(report.lineCount).toBe(1);
  expect(report.width).toBeLessThanOrEqual(report.parentWidth + 1);
}

export async function expectCardTextClearOfFavorite(
  article: Locator,
  options: { absoluteFavorite: boolean; clamped: boolean },
): Promise<void> {
  await article.scrollIntoViewIfNeeded();
  const report = await article.evaluate((element) => {
    const card = element as HTMLElement;
    const link = card.querySelector(":scope > a") as HTMLElement | null;
    const button = card.querySelector(":scope > button") as HTMLElement | null;
    const description = link?.querySelector("span:nth-child(2)") as HTMLElement | null;
    if (link === null || button === null || description === null) return null;
    const buttonRect = button.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const linkRect = link.getBoundingClientRect();
    const textRects = Array.from(link.querySelectorAll("span:nth-child(-n+2)")).flatMap((span) => {
      const range = document.createRange();
      range.selectNodeContents(span);
      return Array.from(range.getClientRects());
    });
    const intersects = textRects.some(
      (rect) =>
        rect.right > buttonRect.left + 0.5 &&
        rect.left < buttonRect.right - 0.5 &&
        rect.bottom > buttonRect.top + 0.5 &&
        rect.top < buttonRect.bottom - 0.5,
    );
    const center = document.elementFromPoint(
      buttonRect.left + buttonRect.width / 2,
      buttonRect.top + buttonRect.height / 2,
    );
    const descriptionStyle = getComputedStyle(description);
    return {
      buttonHeight: buttonRect.height,
      buttonPosition: getComputedStyle(button).position,
      buttonWidth: buttonRect.width,
      centerHitsButton: center !== null && button.contains(center),
      descriptionClamp: descriptionStyle.webkitLineClamp,
      linkFillsCard:
        Math.abs(linkRect.left - cardRect.left) <= 2 &&
        Math.abs(linkRect.right - cardRect.right) <= 2,
      textIntersectsButton: intersects,
    };
  });

  expect(report).not.toBeNull();
  expect(report?.buttonWidth ?? 0).toBeGreaterThanOrEqual(44);
  expect(report?.buttonHeight ?? 0).toBeGreaterThanOrEqual(44);
  expect(report?.centerHitsButton).toBe(true);
  expect(report?.textIntersectsButton).toBe(false);
  expect(report?.buttonPosition).toBe(options.absoluteFavorite ? "absolute" : "static");
  expect(report?.descriptionClamp === "2").toBe(options.clamped);
  if (options.absoluteFavorite) expect(report?.linkFillsCard).toBe(true);
}

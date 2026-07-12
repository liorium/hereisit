export type PageSelectionResult =
  | { ok: true; pages: readonly number[] }
  | { ok: false; message: string };

const MAX_SELECTED_PAGES = 500;

function parsePageSelectionInInputOrder(value: string, maxPage?: number): PageSelectionResult {
  const input = value.trim();
  if (input.length === 0) {
    return { ok: false, message: "페이지 범위를 입력해 주세요." };
  }

  const pages = new Set<number>();
  for (const rawToken of input.split(",")) {
    const token = rawToken.trim();
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(token);
    if (match === null) {
      return { ok: false, message: "예: 1-3, 5, 8-10 형식으로 입력해 주세요." };
    }

    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 1 ||
      end < 1 ||
      start > end
    ) {
      return { ok: false, message: "페이지 번호는 1 이상이며 시작이 끝보다 클 수 없어요." };
    }
    if (end > MAX_SELECTED_PAGES) {
      return { ok: false, message: "한 번에 최대 500페이지까지 선택할 수 있어요." };
    }
    if (maxPage !== undefined && end > maxPage) {
      return { ok: false, message: `이 PDF는 ${maxPage}페이지까지 있어요.` };
    }
    if (end - start + 1 > MAX_SELECTED_PAGES) {
      return { ok: false, message: "한 번에 최대 500페이지까지 선택할 수 있어요." };
    }

    for (let page = start; page <= end; page += 1) {
      pages.add(page);
      if (pages.size > MAX_SELECTED_PAGES) {
        return { ok: false, message: "한 번에 최대 500페이지까지 선택할 수 있어요." };
      }
    }
  }

  return { ok: true, pages: Array.from(pages) };
}

export function parsePageSelection(value: string, maxPage?: number): PageSelectionResult {
  const result = parsePageSelectionInInputOrder(value, maxPage);
  return result.ok
    ? { ok: true, pages: [...result.pages].sort((left, right) => left - right) }
    : result;
}

export function parseOrderedPageSelection(value: string, maxPage?: number): PageSelectionResult {
  return parsePageSelectionInInputOrder(value, maxPage);
}

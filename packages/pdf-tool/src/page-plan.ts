export const MAX_PDF_PAGE_PLAN_ITEMS = 500;

export type PdfPageRotation = 0 | 90 | 180 | 270;
export type PdfPageMoveDirection = -1 | 1;
export type PdfPageRotateDirection = -1 | 1;

export interface PdfPagePlanItem {
  sourcePage: number;
  rotateBy: PdfPageRotation;
}

export type PdfPagePlan = readonly PdfPagePlanItem[];

function assertPageCount(pageCount: number): void {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > MAX_PDF_PAGE_PLAN_ITEMS) {
    throw new RangeError(`페이지 수는 1부터 ${MAX_PDF_PAGE_PLAN_ITEMS} 사이여야 합니다.`);
  }
}

function assertPlanIndex(plan: PdfPagePlan, index: number): void {
  if (!Number.isSafeInteger(index) || index < 0 || index >= plan.length) {
    throw new RangeError("페이지 위치가 작업 범위를 벗어났습니다.");
  }
}

export function createPdfPagePlan(pageCount: number): PdfPagePlan {
  assertPageCount(pageCount);
  return Array.from({ length: pageCount }, (_, index) => ({
    sourcePage: index + 1,
    rotateBy: 0,
  }));
}

export function movePdfPage(
  plan: PdfPagePlan,
  index: number,
  direction: PdfPageMoveDirection,
): PdfPagePlan {
  assertPlanIndex(plan, index);
  const target = index + direction;
  if (target < 0 || target >= plan.length) return plan;

  const next = [...plan];
  const item = next[index];
  if (item === undefined) return plan;
  next.splice(index, 1);
  next.splice(target, 0, item);
  return next;
}

export function rotatePdfPage(
  plan: PdfPagePlan,
  index: number,
  direction: PdfPageRotateDirection,
): PdfPagePlan {
  assertPlanIndex(plan, index);
  const item = plan[index];
  if (item === undefined) return plan;
  const rotateBy = ((item.rotateBy + direction * 90 + 360) % 360) as PdfPageRotation;
  const next = [...plan];
  next[index] = { ...item, rotateBy };
  return next;
}

export function removePdfPage(plan: PdfPagePlan, index: number): PdfPagePlan {
  assertPlanIndex(plan, index);
  if (plan.length === 1) return plan;
  return plan.filter((_, currentIndex) => currentIndex !== index);
}

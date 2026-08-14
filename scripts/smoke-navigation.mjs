import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const DEFAULT_BASE_URL = "https://hereisit.app";
const ROUTE_PATHS = [
  "/",
  "/tools",
  "/my-tools",
  "/workflows",
  "/image/compress",
  "/pdf/organize",
  "/data/json",
];
const EXPECTED_CONTENT_SECURITY_POLICY =
  "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' blob: data:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; script-src 'self' 'unsafe-inline'; connect-src 'self'; manifest-src 'self'";
const EXPECTED_PERMISSIONS_POLICY = "camera=(), geolocation=(), microphone=(), payment=(), usb=()";

function normalizeBaseUrl(value) {
  const url = new URL(value);
  assert.ok(["http:", "https:"].includes(url.protocol), "origin: HTTP(S) required");
  return url.origin;
}

function assertSecurityHeaders(headers) {
  assert.equal(
    headers["content-security-policy"],
    EXPECTED_CONTENT_SECURITY_POLICY,
    "header: Content-Security-Policy",
  );
  assert.equal(
    headers["permissions-policy"],
    EXPECTED_PERMISSIONS_POLICY,
    "header: Permissions-Policy",
  );
  assert.equal(headers["x-content-type-options"], "nosniff", "header: nosniff");
  assert.equal(headers["x-frame-options"], "DENY", "header: DENY");
  assert.equal(headers["referrer-policy"], "no-referrer", "header: no-referrer");
}

async function assertDirectRoutes(context, baseUrl) {
  for (const routePath of ROUTE_PATHS) {
    const expectedUrl = `${baseUrl}${routePath}`;
    const response = await context.request.get(expectedUrl, { maxRedirects: 0 });
    assert.equal(response.status(), 200, `route: ${routePath} status`);
    assert.equal(response.url(), expectedUrl, `route: ${routePath} unchanged URL`);
    assertSecurityHeaders(response.headers());
    console.log(`[route] ${routePath} 200`);
  }
}

async function gotoRoute(page, baseUrl, routePath) {
  const expectedUrl = `${baseUrl}${routePath}`;
  const response = await page.goto(expectedUrl);
  assert.ok(response !== null, `browser route: ${routePath} response`);
  assert.equal(response.status(), 200, `browser route: ${routePath} status`);
  assert.equal(response.url(), expectedUrl, `browser route: ${routePath} unchanged URL`);
  assert.equal(page.url(), expectedUrl, `browser route: ${routePath} current URL`);
  assertSecurityHeaders(response.headers());
}

async function assertHeader(page) {
  await page.getByRole("link", { name: "HereIsIt 홈", exact: true }).waitFor();
  const navigation = page.getByRole("navigation", { name: "주요 탐색" });
  assert.equal(await navigation.count(), 1, "header: primary navigation");
  assert.equal(
    await navigation.getByRole("button", { name: "모든 도구", exact: true }).count(),
    1,
    "header: all tools",
  );
  assert.equal(
    await navigation.getByRole("link", { name: "워크플로", exact: true }).count(),
    0,
    "header: no unfinished workflow destination",
  );
  assert.equal(
    await navigation.getByRole("link", { name: "내 도구", exact: true }).count(),
    1,
    "header: my tools",
  );

  const searchTrigger = navigation.getByRole("button", { name: "검색", exact: true });
  assert.equal(await searchTrigger.count(), 1, "header: search trigger");
  await searchTrigger.click();
  const searchPanel = page.getByTestId("desktop-search");
  await searchPanel.waitFor({ state: "visible" });
  assert.equal(
    await searchPanel.getByRole("combobox", { name: "도구 검색" }).count(),
    1,
    "header: search combobox",
  );
  console.log("[assertion] approved header and search panel");
}

async function assertHome(page) {
  assert.equal(
    await page.getByRole("button", { name: "파일 선택", exact: true }).count(),
    1,
    "home: file launcher",
  );

  const tablist = page.getByRole("tablist", { name: "도구 분야" });
  const tabs = tablist.getByRole("tab");
  assert.equal(await tabs.count(), 8, "home: eight domain tabs");
  const selectedTab = tablist.getByRole("tab", { selected: true });
  assert.equal(await selectedTab.count(), 1, "home: one selected tab");
  const selectedTabId = await selectedTab.getAttribute("id");
  assert.ok(selectedTabId, "home: selected tab ID");
  const panel = page.getByRole("tabpanel");
  assert.equal(await panel.count(), 1, "home: one tabpanel");
  assert.equal(
    await panel.getAttribute("aria-labelledby"),
    selectedTabId,
    "home: tabpanel labelled by selected tab",
  );
  assert.equal(
    await page.getByRole("region", { name: "파일 작업 영역" }).count(),
    0,
    "home: no file workbench",
  );
  assert.equal(
    await page.getByRole("region", { name: "편집 작업 공간" }).count(),
    0,
    "home: no workspace workbench",
  );
  assert.equal(
    await page.getByRole("region", { name: "빠른 작업 영역" }).count(),
    0,
    "home: no quick workbench",
  );
  console.log("[assertion] home launcher, tabs, and processor-free state");
}

async function assertAvailableCatalog(page) {
  const available = page.getByRole("region", { name: "사용 가능한 도구" });
  await available.waitFor({ state: "visible" });
  assert.equal(await available.locator("article").count(), 12, "catalog: twelve available tools");
  console.log("[assertion] available catalog has 12 tools");
}

async function assertPlannedCatalog(page, baseUrl) {
  await gotoRoute(page, baseUrl, "/tools?planned=1");
  const planned = page.getByRole("region", { name: "준비 중인 도구" });
  await planned.waitFor({ state: "visible" });
  assert.ok((await planned.locator("article").count()) > 0, "catalog: planned cards present");
  assert.equal(
    await planned.locator("article a, article button").count(),
    0,
    "catalog: inert planned cards",
  );
  console.log("[assertion] planned catalog cards are inert");
}

async function assertRobots(page, routePath) {
  assert.equal(
    await page.locator('meta[name="robots"]').getAttribute("content"),
    "noindex, follow",
    `robots: ${routePath} noindex follow`,
  );
  console.log(`[assertion] ${routePath} robots`);
}

async function assertDetailShell(
  page,
  title,
  workAreaLabel,
  expectedExecutionDisclosure,
  expectedNextActions,
) {
  await page.getByRole("heading", { level: 1, name: title, exact: true }).waitFor();
  assert.equal(
    await page.getByRole("navigation", { name: "현재 위치" }).count(),
    1,
    "detail: breadcrumb",
  );
  assert.equal(
    await page
      .getByRole("region", { name: "처리 방식" })
      .getByText(expectedExecutionDisclosure, { exact: true })
      .count(),
    1,
    "detail: execution disclosure",
  );
  assert.equal(
    await page.getByRole("region", { name: workAreaLabel }).count(),
    1,
    "detail: work area",
  );
  const nextActions = page.getByRole("region", { name: "다음 작업" }).getByRole("link");
  assert.equal(await nextActions.count(), 3, "detail: three next actions");
  for (const [index, href] of expectedNextActions.entries()) {
    assert.equal(
      await nextActions.nth(index).getAttribute("href"),
      href,
      "detail: ordered next action",
    );
  }
  for (const oldStepCopy of ["3 STEPS", "선택하고, 처리하고, 저장하세요."]) {
    assert.equal(
      await page.getByText(oldStepCopy, { exact: true }).count(),
      0,
      "detail: no legacy three-step block",
    );
  }
  console.log(`[assertion] ${workAreaLabel} shell`);
}

assert.ok(process.argv.length <= 3, "origin: at most one argument");
const baseUrl = normalizeBaseUrl(process.argv[2] ?? DEFAULT_BASE_URL);
const browser = await chromium.launch({ headless: true });
let context;

try {
  context = await browser.newContext({ acceptDownloads: true });
  await assertDirectRoutes(context, baseUrl);

  const violations = [];
  let automaticDownloads = 0;
  let failedRequests = 0;
  let pageErrors = 0;
  context.on("request", (request) => {
    if (new URL(request.url()).origin !== baseUrl) violations.push("cross-origin");
    if (!["GET", "HEAD"].includes(request.method())) violations.push("write-method");
    if (request.postDataBuffer() !== null) violations.push("request-body");
    if (request.redirectedFrom() !== null) violations.push("redirect");
  });
  context.on("requestfailed", () => {
    failedRequests += 1;
  });

  const page = await context.newPage();
  page.on("download", () => {
    automaticDownloads += 1;
  });
  page.on("pageerror", () => {
    pageErrors += 1;
  });

  await gotoRoute(page, baseUrl, "/");
  await assertHeader(page);
  await assertHome(page);

  await gotoRoute(page, baseUrl, "/tools");
  await assertAvailableCatalog(page);
  await assertPlannedCatalog(page, baseUrl);

  await gotoRoute(page, baseUrl, "/my-tools");
  await assertRobots(page, "/my-tools");

  await gotoRoute(page, baseUrl, "/workflows");
  await assertRobots(page, "/workflows");

  await gotoRoute(page, baseUrl, "/image/compress");
  await assertDetailShell(page, "이미지 용량 줄이기", "파일 작업 영역", "처리 방식 자동 확인", [
    "/image/resize",
    "/image/convert",
    "/image/watermark",
  ]);

  await gotoRoute(page, baseUrl, "/pdf/organize");
  await assertDetailShell(page, "PDF 페이지 정리", "편집 작업 공간", "이 기기에서 처리", [
    "/pdf/merge",
    "/pdf/split",
    "/pdf/watermark",
  ]);

  await gotoRoute(page, baseUrl, "/data/json");
  await assertDetailShell(page, "JSON 정리·검사", "빠른 작업 영역", "이 기기에서 처리", [
    "/image/convert",
    "/pdf/to-image",
    "/pdf/image-to-pdf",
  ]);

  assert.deepEqual(violations, [], "network: read-only same-origin requests");
  assert.equal(failedRequests, 0, "network: no failed requests");
  assert.equal(pageErrors, 0, "browser: no page errors");
  assert.equal(automaticDownloads, 0, "browser: no automatic downloads");
  console.log("[assertion] read-only navigation smoke passed");
} finally {
  await context?.close();
  await browser.close();
}

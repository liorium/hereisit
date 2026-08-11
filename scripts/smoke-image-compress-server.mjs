import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { canonicalJson, parseCliArguments, writeCanonicalJsonAtomic } from "./image-lab-common.mjs";
import { runProcessingStagingBrowserSmoke } from "./support/processing-staging-smoke-runtime.mjs";

const PROCESSING_STAGING_ORIGIN = "https://processing-staging.hereisit.pages.dev";
const PROCESSING_PRODUCTION_ORIGIN = "https://hereisit.app";
const WEB_ANALYTICS_COLLECTION_URL = "https://cloudflareinsights.com/cdn-cgi/rum";
const SESSION_STORAGE_KEY = "hereisit.processing-session.v1";
const PUBLIC_BUCKET_ZERO_SESSION_ID = "eb8f99c7-54e5-48f0-9233-218cc5b7ffef";
const JOB_UUID_SEGMENT = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const SESSION_UUID_SEGMENT = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const SESSION_UUID_PATTERN = new RegExp(`^${SESSION_UUID_SEGMENT}$`);
const privateSourceName = "stack-source-private.jpg";
const expectedDownloadName = "stack-source-private-hereisit.jpg";
const jobIdPattern = new RegExp(`/v1/jobs/${JOB_UUID_SEGMENT}`, "g");
const inputPathPattern = new RegExp(`^/v1/jobs/${JOB_UUID_SEGMENT}/input$`);
const downloadedPathPattern = new RegExp(`^/v1/jobs/${JOB_UUID_SEGMENT}/downloaded$`);
const stableFailure = "processing staging smoke failed";
const safeFailures = new Set([
  `${stableFailure} [browser-launch]`,
  `${stableFailure} [public-context]`,
  `${stableFailure} [public-navigation]`,
  `${stableFailure} [public-policy]`,
  `${stableFailure} [public-ui]`,
  `${stableFailure} [public-invariants]`,
  `${stableFailure} [maintainer-context]`,
  `${stableFailure} [maintainer-navigation]`,
  `${stableFailure} [maintainer-policy]`,
  `${stableFailure} [maintainer-policy-invalid]`,
  `${stableFailure} [maintainer-policy-missing]`,
  `${stableFailure} [maintainer-policy-status]`,
  `${stableFailure} [maintainer-policy-identity]`,
  `${stableFailure} [maintainer-policy-execution]`,
  `${stableFailure} [maintainer-policy-reason]`,
  `${stableFailure} [maintainer-ui]`,
  `${stableFailure} [preset-selection]`,
  `${stableFailure} [file-selection]`,
  `${stableFailure} [job-submit]`,
  `${stableFailure} [job-completion]`,
  `${stableFailure} [job-create-network]`,
  `${stableFailure} [job-create-network-rate-limit]`,
  `${stableFailure} [job-create-session-rate-limit]`,
  `${stableFailure} [job-create-application-unscoped-rate-limit]`,
  `${stableFailure} [job-create-quota]`,
  `${stableFailure} [job-create-upstream-rate-limit]`,
  `${stableFailure} [job-create-unknown-rate-limit]`,
  `${stableFailure} [job-create-503]`,
  `${stableFailure} [job-create-missing]`,
  `${stableFailure} [download-handoff]`,
  `${stableFailure} [browser-download]`,
  `${stableFailure} [download-ack]`,
  `${stableFailure} [maintainer-console]`,
  `${stableFailure} [maintainer-page-error]`,
  `${stableFailure} [maintainer-source-leak]`,
  `${stableFailure} [maintainer-input-options]`,
  `${stableFailure} [maintainer-input-put]`,
  `${stableFailure} [maintainer-input-length]`,
  `${stableFailure} [maintainer-download-ack-count]`,
  `${stableFailure} [maintainer-download-ack-status]`,
  `${stableFailure} [public-server-context]`,
  `${stableFailure} [public-server-navigation]`,
  `${stableFailure} [public-server-ui]`,
  `${stableFailure} [public-server-console]`,
  `${stableFailure} [public-server-page-error]`,
  `${stableFailure} [public-server-source-leak]`,
  `${stableFailure} [public-server-input-options]`,
  `${stableFailure} [public-server-input-put]`,
  `${stableFailure} [public-server-input-length]`,
  `${stableFailure} [public-server-download-ack-count]`,
  `${stableFailure} [public-server-download-ack-status]`,
]);

async function runSmokeStage(stage, action) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof Error && safeFailures.has(error.message)) throw error;
    throw new Error(`${stableFailure} [${stage}]`);
  }
}

export function projectSmokeRequest({ method, url, bodyBytes }) {
  const path = new URL(url).pathname.replace(jobIdPattern, "/v1/jobs/[job]");
  return {
    method,
    path,
    ...(bodyBytes === undefined ? {} : { bodyBytes }),
  };
}

export function summarizeSmokeRequests(requests) {
  return requests.map((value) => {
    const separator = value.indexOf(" ");
    const projected = projectSmokeRequest({
      method: value.slice(0, separator),
      url: value.slice(separator + 1),
    });
    return `${projected.method} ${projected.path}`;
  });
}

export function classifyJobCreateRateLimit({ scope, body }) {
  if (scope === "network" || scope === "session") return scope;
  const errorCode =
    body !== null &&
    typeof body === "object" &&
    body.contract === "tool-job@1" &&
    body.error !== null &&
    typeof body.error === "object"
      ? body.error.code
      : null;
  if (errorCode === "RATE_LIMITED") return "application-unscoped";
  if (errorCode === "QUOTA_EXCEEDED") return "quota";
  return "upstream";
}

async function inspectJobCreateRateLimit(response) {
  let scope;
  try {
    scope = await response.headerValue("x-hereisit-rate-limit-scope");
  } catch {
    scope = response.headers()["x-hereisit-rate-limit-scope"];
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    // An upstream 429 may not use the HereIsIt JSON contract.
  }
  return classifyJobCreateRateLimit({ scope, body });
}

function assertOrigin(value, label) {
  const url = new URL(value);
  const localHttp =
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  if (url.protocol !== "https:" && !localHttp) {
    throw new TypeError(`${label} must be HTTP(S)`);
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError(`${label} must be an origin`);
  }
  return url.origin;
}

function assertQuietPage(page, state) {
  page.on("console", (message) => {
    const text = message.text();
    if (message.type() === "error") state.consoleError = true;
    if (text.includes(privateSourceName)) state.sourceFilenameLeak = true;
  });
  page.on("pageerror", () => {
    state.pageError = true;
  });
  page.on("requestfailed", () => {
    state.requestFailed = true;
  });
}

function injectSession(context, pageOrigin, sessionId) {
  return context.addInitScript(
    ({ origin, injectedSessionId, storageKey }) => {
      if (location.origin === origin) localStorage.setItem(storageKey, injectedSessionId);
    },
    { origin: pageOrigin, injectedSessionId: sessionId, storageKey: SESSION_STORAGE_KEY },
  );
}

function observePolicies(page, state) {
  page.on("response", (response) => {
    if (new URL(response.url()).pathname !== "/v1/policy") return;
    state.policyReads.push(
      response
        .json()
        .then((body) => {
          state.policies.push({
            status: response.status(),
            maintainer: body?.maintainer,
            execution: body?.execution,
            reason: body?.reason,
          });
        })
        .catch(() => {
          state.invalidPolicy = true;
        }),
    );
  });
}

async function assertPolicies(state, expected) {
  await Promise.all(state.policyReads);
  let detail = null;
  if (state.invalidPolicy) detail = "invalid";
  else if (state.policies.length < 1) detail = "missing";
  else if (state.policies.some((policy) => policy.status !== 200)) detail = "status";
  else if (state.policies.some((policy) => policy.maintainer !== expected.maintainer)) {
    detail = "identity";
  } else if (state.policies.some((policy) => policy.execution !== expected.execution)) {
    detail = "execution";
  } else if (state.policies.some((policy) => policy.reason !== expected.reason)) {
    detail = "reason";
  }
  if (detail !== null) {
    const stage = expected.maintainer ? `maintainer-policy-${detail}` : "public-policy";
    throw new Error(`${stableFailure} [${stage}]`);
  }
}

async function assertNonMaintainerLocal(browser, pageOrigin, timeoutMs) {
  const context = await runSmokeStage("public-context", () => browser.newContext());
  await runSmokeStage("public-context", () =>
    injectSession(context, pageOrigin, PUBLIC_BUCKET_ZERO_SESSION_ID),
  );
  const page = await runSmokeStage("public-context", () => context.newPage());
  await runSmokeStage("public-context", () =>
    page.route(WEB_ANALYTICS_COLLECTION_URL, (route) => route.fulfill({ status: 204 })),
  );
  const cdp = await runSmokeStage("public-context", () => context.newCDPSession(page));
  await runSmokeStage("public-context", () => cdp.send("Network.enable"));
  const state = {
    jobRequest: false,
    consoleError: false,
    pageError: false,
    requestFailed: false,
    sourceFilenameLeak: false,
    invalidPolicy: false,
    policies: [],
    policyReads: [],
  };
  assertQuietPage(page, state);
  observePolicies(page, state);
  cdp.on("Network.requestWillBeSent", ({ request: { method: _method, url } }) => {
    if (new URL(url).pathname.startsWith("/v1/jobs")) state.jobRequest = true;
  });
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes(privateSourceName)) state.sourceFilenameLeak = true;
  });
  try {
    await runSmokeStage("public-navigation", () =>
      page.goto(`${pageOrigin}/image/compress`, {
        waitUntil: "networkidle",
        timeout: timeoutMs,
      }),
    );
    await assertPolicies(state, {
      maintainer: false,
      execution: "local",
      reason: "LOCAL_FALLBACK_REQUIRED",
    });
    await runSmokeStage("public-ui", () =>
      page.locator('[data-policy="local"]').waitFor({ timeout: timeoutMs }),
    );
    await page.waitForTimeout(250);
    if (
      state.jobRequest ||
      state.consoleError ||
      state.pageError ||
      state.requestFailed ||
      state.sourceFilenameLeak
    ) {
      throw new Error(`${stableFailure} [public-invariants]`);
    }
  } finally {
    await context.close().catch(() => undefined);
  }
}

async function assertServerJob(
  browser,
  pageOrigin,
  { sessionId, expectedMaintainer, stagePrefix, sourcePath, timeoutMs },
) {
  const contextStage = `${stagePrefix}-context`;
  const context = await runSmokeStage(contextStage, () =>
    browser.newContext({ acceptDownloads: true }),
  );
  await runSmokeStage(contextStage, () => injectSession(context, pageOrigin, sessionId));
  const page = await runSmokeStage(contextStage, () => context.newPage());
  await runSmokeStage(contextStage, () =>
    page.route(WEB_ANALYTICS_COLLECTION_URL, (route) => route.fulfill({ status: 204 })),
  );
  const cdp = await runSmokeStage(contextStage, () => context.newCDPSession(page));
  await runSmokeStage(contextStage, () => cdp.send("Network.enable"));
  const state = {
    consoleError: false,
    pageError: false,
    sourceFilenameLeak: false,
    inputOptions: 0,
    inputPuts: 0,
    jobCreateNetworkFailures: 0,
    jobCreateStatuses: [],
    jobCreateRateLimitScopes: [],
    jobCreateRateLimitInspections: [],
    downloadAcknowledgements: 0,
    downloadAcknowledged: false,
    invalidPolicy: false,
    policies: [],
    policyReads: [],
    workerRequests: 0,
    inputPutAccepted: false,
  };
  assertQuietPage(page, state);
  observePolicies(page, state);
  cdp.on("Network.requestWillBeSent", ({ request: { method, url } }) => {
    const path = new URL(url).pathname;
    if (method === "OPTIONS" && inputPathPattern.test(path)) state.inputOptions += 1;
  });
  page.on("request", (request) => {
    const url = request.url();
    const path = new URL(url).pathname;
    if (url.includes(privateSourceName)) state.sourceFilenameLeak = true;
    if (path.startsWith("/v1/jobs")) state.workerRequests += 1;
    if (inputPathPattern.test(path) && request.method() === "PUT") state.inputPuts += 1;
    if (downloadedPathPattern.test(path) && request.method() === "POST") {
      state.downloadAcknowledgements += 1;
    }
  });
  page.on("requestfailed", (request) => {
    if (new URL(request.url()).pathname === "/v1/jobs" && request.method() === "POST") {
      state.jobCreateNetworkFailures += 1;
    }
  });
  page.on("response", (response) => {
    const request = response.request();
    if (new URL(response.url()).pathname === "/v1/jobs" && request.method() === "POST") {
      state.jobCreateStatuses.push(response.status());
      if (response.status() === 429) {
        state.jobCreateRateLimitScopes.push(response.headers()["x-hereisit-rate-limit-scope"]);
        state.jobCreateRateLimitInspections.push(inspectJobCreateRateLimit(response));
      }
    }
    if (
      inputPathPattern.test(new URL(response.url()).pathname) &&
      request.method() === "PUT" &&
      response.status() === 204
    ) {
      state.inputPutAccepted = true;
    }
    if (
      downloadedPathPattern.test(new URL(response.url()).pathname) &&
      request.method() === "POST" &&
      response.ok()
    ) {
      state.downloadAcknowledged = true;
    }
  });
  try {
    await runSmokeStage(`${stagePrefix}-navigation`, () =>
      page.goto(`${pageOrigin}/image/compress`, {
        waitUntil: "networkidle",
        timeout: timeoutMs,
      }),
    );
    await assertPolicies(state, {
      maintainer: expectedMaintainer,
      execution: "server",
      reason: null,
    });
    await runSmokeStage(`${stagePrefix}-ui`, () =>
      page.locator('[data-policy="server"]').waitFor({ timeout: timeoutMs }),
    );
    const source = await readFile(sourcePath);
    await runSmokeStage("file-selection", () =>
      page.locator('input[type="file"]').setInputFiles({
        name: privateSourceName,
        mimeType: "image/jpeg",
        buffer: source,
      }),
    );
    await runSmokeStage("preset-selection", () =>
      page.getByText("압축 설정 · 추천", { exact: true }).click(),
    );
    await runSmokeStage("preset-selection", () =>
      page.getByRole("radio", { name: /최소 용량/ }).check(),
    );
    await runSmokeStage("job-submit", () =>
      page.getByRole("button", { name: "용량 줄이기", exact: true }).click(),
    );
    const downloadButton = page.getByRole("button", { name: "결과 다운로드 ↓" });
    await runSmokeStage("job-completion", () => downloadButton.waitFor({ timeout: timeoutMs }));
    await assertPolicies(state, {
      maintainer: expectedMaintainer,
      execution: "server",
      reason: null,
    });
    if (state.inputOptions !== 1) {
      if (state.jobCreateNetworkFailures > 0) {
        throw new Error(`${stableFailure} [job-create-network]`);
      }
      const createStatus = state.jobCreateStatuses.at(-1);
      if (createStatus === 429) {
        const classification = (await Promise.all(state.jobCreateRateLimitInspections)).at(-1);
        if (classification === "network") {
          throw new Error(`${stableFailure} [job-create-network-rate-limit]`);
        }
        if (classification === "session") {
          throw new Error(`${stableFailure} [job-create-session-rate-limit]`);
        }
        if (classification === "application-unscoped") {
          throw new Error(`${stableFailure} [job-create-application-unscoped-rate-limit]`);
        }
        if (classification === "quota") {
          throw new Error(`${stableFailure} [job-create-quota]`);
        }
        if (classification === "upstream") {
          throw new Error(`${stableFailure} [job-create-upstream-rate-limit]`);
        }
        throw new Error(`${stableFailure} [job-create-unknown-rate-limit]`);
      }
      if (createStatus === 503) throw new Error(`${stableFailure} [job-create-503]`);
      if (createStatus === undefined) throw new Error(`${stableFailure} [job-create-missing]`);
    }
    if (state.inputOptions !== 1) {
      throw new Error(`${stableFailure} [${stagePrefix}-input-options]`);
    }
    if (state.inputPuts !== 1) throw new Error(`${stableFailure} [${stagePrefix}-input-put]`);
    if (!state.inputPutAccepted) {
      throw new Error(`${stableFailure} [${stagePrefix}-input-length]`);
    }
    const downloadPromise = page.waitForEvent("download", { timeout: timeoutMs });
    const acknowledgementPromise = page.waitForResponse(
      (response) =>
        downloadedPathPattern.test(new URL(response.url()).pathname) &&
        response.request().method() === "POST" &&
        response.ok(),
      { timeout: timeoutMs },
    );
    const [downloadResult, acknowledgementResult] = await runSmokeStage(
      "download-handoff",
      async () => {
        await downloadButton.click();
        return Promise.allSettled([downloadPromise, acknowledgementPromise]);
      },
    );
    if (downloadResult.status !== "fulfilled") {
      throw new Error(`${stableFailure} [browser-download]`);
    }
    if (acknowledgementResult.status !== "fulfilled") {
      throw new Error(`${stableFailure} [download-ack]`);
    }
    const download = downloadResult.value;
    if (download.suggestedFilename() !== expectedDownloadName) throw new Error(stableFailure);
    const stream = await download.createReadStream();
    if (stream === null) throw new Error(stableFailure);
    let downloadBytes = 0;
    for await (const chunk of stream) downloadBytes += chunk.byteLength;
    if (downloadBytes < 1) throw new Error(stableFailure);
    await page.waitForTimeout(250);
    if (state.consoleError) throw new Error(`${stableFailure} [${stagePrefix}-console]`);
    if (state.pageError) throw new Error(`${stableFailure} [${stagePrefix}-page-error]`);
    if (state.sourceFilenameLeak) {
      throw new Error(`${stableFailure} [${stagePrefix}-source-leak]`);
    }
    if (state.downloadAcknowledgements !== 1) {
      throw new Error(`${stableFailure} [${stagePrefix}-download-ack-count]`);
    }
    if (!state.downloadAcknowledged) {
      throw new Error(`${stableFailure} [${stagePrefix}-download-ack-status]`);
    }
    return { workerRequests: state.workerRequests };
  } finally {
    await context.close().catch(() => undefined);
  }
}

function authenticatedSmokeResult(pageOrigin) {
  return {
    schema:
      pageOrigin === PROCESSING_PRODUCTION_ORIGIN
        ? "hereisit-processing-production-canary-smoke@1"
        : "hereisit-processing-staging-smoke@1",
    version: 1,
    passed: true,
    rolloutPercent: 0,
    nonMaintainerLocal: true,
    maintainerServer: true,
    browserPreflight: true,
    exactLengthUpload: true,
    directDownload: true,
    downloadAcknowledged: true,
    sourceFilenameLeak: false,
  };
}

function publicSmokeResult() {
  return {
    schema: "hereisit-processing-production-public-smoke@1",
    version: 1,
    passed: true,
    rolloutPercent: 100,
    nonMaintainerServer: true,
    directDownload: true,
    downloadAcknowledged: true,
    exactLengthUpload: true,
    sourceFilenameLeak: false,
  };
}

async function performImageCompressServerSmoke({
  pageOrigin,
  sourcePath = resolve("tests/image-corpus/public/photo-ordinary-jpeg.jpg"),
  timeoutMs = 120_000,
  maintainerSessionId,
  publicAdmission = false,
}) {
  const origin = pageOrigin;
  const browser = await runSmokeStage("browser-launch", () => chromium.launch({ headless: true }));
  try {
    if (maintainerSessionId !== undefined) {
      if (
        (origin !== PROCESSING_STAGING_ORIGIN && origin !== PROCESSING_PRODUCTION_ORIGIN) ||
        !SESSION_UUID_PATTERN.test(maintainerSessionId)
      ) {
        throw new TypeError(stableFailure);
      }
      await assertNonMaintainerLocal(browser, origin, timeoutMs);
      await assertServerJob(browser, origin, {
        sessionId: maintainerSessionId,
        expectedMaintainer: true,
        stagePrefix: "maintainer",
        sourcePath,
        timeoutMs,
      });
      return authenticatedSmokeResult(origin);
    }

    if (publicAdmission && origin !== PROCESSING_PRODUCTION_ORIGIN) {
      throw new TypeError(stableFailure);
    }
    const summary = await assertServerJob(browser, origin, {
      sessionId: PUBLIC_BUCKET_ZERO_SESSION_ID,
      expectedMaintainer: false,
      stagePrefix: "public-server",
      sourcePath,
      timeoutMs,
    });
    return publicAdmission
      ? publicSmokeResult()
      : {
          directDownload: true,
          workerRequests: summary.workerRequests,
          sourceFilenameLeak: false,
        };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

export async function smokeImageCompressServer(input) {
  const pageOrigin = assertOrigin(input.pageOrigin, "page origin");
  return runProcessingStagingBrowserSmoke(
    { ...input, pageOrigin },
    performImageCompressServerSmoke,
  );
}

function parseStagingSmokeCli(argv, environment) {
  try {
    const args = parseCliArguments(argv);
    const pageOrigin = args["page-origin"];
    const sessionId =
      pageOrigin === PROCESSING_STAGING_ORIGIN
        ? environment.STAGING_MAINTAINER_SESSION_ID
        : pageOrigin === PROCESSING_PRODUCTION_ORIGIN
          ? environment.PRODUCTION_MAINTAINER_SESSION_ID
          : undefined;
    if (
      argv.join("\0") !== `--page-origin\0${pageOrigin ?? ""}\0--output\0${args.output ?? ""}` ||
      Object.keys(args).sort().join() !== "output,page-origin" ||
      typeof args.output !== "string" ||
      args.output.length === 0 ||
      !SESSION_UUID_PATTERN.test(sessionId ?? "")
    ) {
      throw new TypeError(stableFailure);
    }
    return {
      pageOrigin,
      outputPath: args.output,
      sessionId,
    };
  } catch {
    throw new TypeError("processing staging smoke configuration is invalid");
  }
}

export async function runProcessingStagingSmokeCli({ argv, environment }) {
  const input = parseStagingSmokeCli(argv, environment);
  try {
    await lstat(input.outputPath).then(
      () => Promise.reject(new Error(stableFailure)),
      (error) => {
        if (error?.code !== "ENOENT") throw new Error(stableFailure);
      },
    );
    const result = await smokeImageCompressServer({
      pageOrigin: input.pageOrigin,
      maintainerSessionId: input.sessionId,
    });
    if (canonicalJson(result) !== canonicalJson(authenticatedSmokeResult(input.pageOrigin))) {
      throw new Error(stableFailure);
    }
    await writeCanonicalJsonAtomic(input.outputPath, result, {
      refuseOverwrite: true,
      mode: 0o600,
    });
    return result;
  } catch (error) {
    if (error instanceof Error && safeFailures.has(error.message)) {
      throw new Error(error.message);
    }
    throw new Error(stableFailure);
  }
}

function parsePublicSmokeCli(argv) {
  try {
    const args = parseCliArguments(argv);
    if (
      argv.join("\0") !==
        `--page-origin\0${PROCESSING_PRODUCTION_ORIGIN}\0--output\0${args.output ?? ""}` ||
      Object.keys(args).sort().join() !== "output,page-origin" ||
      typeof args.output !== "string" ||
      args.output.length === 0
    ) {
      throw new TypeError(stableFailure);
    }
    return { outputPath: args.output };
  } catch {
    throw new TypeError("processing production public smoke configuration is invalid");
  }
}

export async function runProcessingPublicSmokeCli({ argv }) {
  const input = parsePublicSmokeCli(argv);
  try {
    await lstat(input.outputPath).then(
      () => Promise.reject(new Error(stableFailure)),
      (error) => {
        if (error?.code !== "ENOENT") throw new Error(stableFailure);
      },
    );
    const result = await smokeImageCompressServer({
      pageOrigin: PROCESSING_PRODUCTION_ORIGIN,
      publicAdmission: true,
    });
    if (canonicalJson(result) !== canonicalJson(publicSmokeResult())) {
      throw new Error(stableFailure);
    }
    await writeCanonicalJsonAtomic(input.outputPath, result, {
      refuseOverwrite: true,
      mode: 0o600,
    });
    return result;
  } catch (error) {
    if (error instanceof Error && safeFailures.has(error.message)) throw error;
    throw new Error("processing production public smoke failed");
  }
}

async function main() {
  await runProcessingStagingSmokeCli({ argv: process.argv.slice(2), environment: process.env });
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    await main();
  } catch (error) {
    const message =
      error instanceof Error && safeFailures.has(error.message) ? error.message : stableFailure;
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

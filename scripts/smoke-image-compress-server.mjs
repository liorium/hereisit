import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { parseCliArguments } from "./image-lab-common.mjs";

const privateSourceName = "stack-source-private.jpg";
const jobIdPattern = /\/v1\/jobs\/[0-9a-f-]+/gi;

export function summarizeSmokeRequests(requests) {
  return requests.map((value) => {
    const separator = value.indexOf(" ");
    const method = value.slice(0, separator);
    const url = new URL(value.slice(separator + 1));
    return `${method} ${url.pathname.replace(jobIdPattern, "/v1/jobs/[job]")}`;
  });
}

function assertOrigin(value, label) {
  const url = new URL(value);
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new TypeError(`${label} must be an origin`);
  }
  return url.origin;
}

export async function smokeImageCompressServer({
  pageOrigin,
  sourcePath = resolve("tests/image-corpus/public/photo-ordinary-jpeg.jpg"),
  timeoutMs = 120_000,
}) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const network = [];
  const consoleMessages = [];
  const policyResponses = [];
  page.on("request", (request) => network.push(`${request.method()} ${request.url()}`));
  page.on("response", (response) => {
    if (new URL(response.url()).pathname !== "/v1/policy") return;
    void response
      .json()
      .then((body) => {
        policyResponses.push({
          status: response.status(),
          execution: typeof body?.execution === "string" ? body.execution : null,
          reason: typeof body?.reason === "string" ? body.reason : null,
        });
      })
      .catch(() => {
        policyResponses.push({ status: response.status(), execution: null, reason: null });
      });
  });
  page.on("console", (message) => consoleMessages.push(message.text()));
  try {
    await page.goto(`${assertOrigin(pageOrigin, "page origin")}/image/compress`, {
      waitUntil: "networkidle",
      timeout: timeoutMs,
    });
    await page.locator('[data-policy="server"] strong').waitFor({ timeout: timeoutMs });
    const source = await readFile(sourcePath);
    await page.locator('input[type="file"]').setInputFiles({
      name: privateSourceName,
      mimeType: "image/jpeg",
      buffer: source,
    });
    await page.getByRole("button", { name: "이미지 1개 압축하기" }).click();
    const downloadButton = page.getByRole("button", { name: "결과 다운로드 ↓" });
    await downloadButton.waitFor({ timeout: timeoutMs });
    const downloadPromise = page.waitForEvent("download", { timeout: timeoutMs });
    await downloadButton.click();
    const download = await downloadPromise;
    if (download.suggestedFilename() !== "stack-source-private-hereisit.jpg") {
      throw new Error("server smoke did not preserve the expected local-derived filename");
    }
    await download.createReadStream().then(async (stream) => {
      if (stream === null) throw new Error("server smoke download stream is unavailable");
      let bytes = 0;
      for await (const chunk of stream) bytes += chunk.byteLength;
      if (bytes < 1) throw new Error("server smoke download is empty");
    });
    await page.waitForTimeout(250);
    const leaked = [...network, ...consoleMessages].some((value) =>
      value.includes(privateSourceName),
    );
    if (leaked) throw new Error("browser network or console exposed a source filename");
    const jobRequests = network.filter((value) => value.includes("/v1/jobs"));
    if (!jobRequests.some((value) => value.startsWith("PUT "))) {
      throw new Error(
        `browser smoke did not perform the Worker streaming upload: requests=${JSON.stringify(summarizeSmokeRequests(network))} policies=${JSON.stringify(policyResponses)}`,
      );
    }
    return {
      directDownload: true,
      workerRequests: jobRequests.length,
      sourceFilenameLeak: false,
    };
  } finally {
    await context.close();
    await browser.close();
  }
}

async function main() {
  const args = parseCliArguments(process.argv.slice(2));
  if (Object.keys(args).sort().join() !== "page-origin") {
    throw new TypeError("usage: smoke-image-compress-server --page-origin <origin>");
  }
  const result = await smokeImageCompressServer({ pageOrigin: args["page-origin"] });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}

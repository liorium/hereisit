import { createServer } from "node:http";
import { checkProductionHealth } from "../../scripts/check-production-health.mjs";

// Use native Node fetch outside Vitest's VM; GC must not detach the body deadline.
const server = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.write("{");
  } else {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>Test</title>");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
let watchdogFired = false;
const watchdog = setTimeout(() => {
  watchdogFired = true;
  server.closeAllConnections();
}, 12_000);
const collect = setTimeout(() => globalThis.gc(), 500);
try {
  const report = await checkProductionHealth({
    fetchImpl: (url, init) => fetch(`http://127.0.0.1:${port}${new URL(url).pathname}`, init),
  });
  process.stdout.write(`${JSON.stringify({ watchdogFired, check: report.checks[2] })}\n`);
} finally {
  clearTimeout(watchdog);
  clearTimeout(collect);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

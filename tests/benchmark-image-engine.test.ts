import { createServer } from "node:http";
import { expect, it } from "vitest";
import { deleteBenchmarkJob } from "../scripts/benchmark-image-engine.mjs";

it.each([false, true])("verifies removal after DELETE, still readable=%s", async (readable) => {
  let deleted = false;
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.method === "DELETE") {
      deleted = true;
      response.writeHead(204).end();
    } else {
      response.writeHead(deleted && !readable ? 404 : 200).end("result");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing address");
    const result = deleteBenchmarkJob(`http://127.0.0.1:${address.port}`, "job");
    if (readable) await expect(result).rejects.toThrow("readable after deletion");
    else {
      expect(await result).toBeGreaterThanOrEqual(0);
      expect(requests).toEqual([
        "DELETE /v1/jobs/job",
        "GET /v1/jobs/job",
        "GET /v1/jobs/job/output",
      ]);
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { engineCreatePdfJobRequestSchema } from "@hereisit/server-contracts";
import { ZodError } from "zod";
import {
  PdfEngineBusyError,
  PdfEngineUnavailableError,
  PdfJobConflictError,
  type PdfJobController,
  PdfJobNotFoundError,
} from "../job/job-runner";

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function finish(response: ServerResponse, status: number, body?: unknown): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.statusCode = status;
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  if (body === undefined) {
    response.end();
    return;
  }
  const bytes = Buffer.from(JSON.stringify(body));
  response.setHeader("content-type", "application/json");
  response.setHeader("content-length", bytes.byteLength);
  response.end(bytes);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const raw of request) {
    const chunk = Buffer.from(raw);
    bytes += chunk.byteLength;
    if (bytes > 64 * 1024) throw new RangeError("JSON is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function route(
  pathname: string,
): { readonly jobId: string; readonly action: string | null } | null {
  const match = /^\/v1\/jobs\/([^/]+)(?:\/(input|run|output))?$/.exec(pathname);
  if (match === null) return null;
  const jobId = match[1] ?? "";
  if (!JOB_ID.test(jobId)) throw new TypeError("job ID is invalid");
  return { jobId, action: match[2] ?? null };
}

export function createPdfEngineRequestHandler(input: {
  readonly controller: PdfJobController;
  readonly build: { readonly protocol: 1; readonly engineBuildId: string; readonly qpdf: string };
}): RequestListener {
  return (request, response) =>
    void (async () => {
      try {
        const method = request.method ?? "GET";
        const rawUrl = request.url ?? "/";
        if (/%(?:2e|2f|5c)/iu.test(rawUrl)) return finish(response, 400);
        const pathname = new URL(rawUrl, "http://engine.internal").pathname;
        if (method === "GET" && pathname === "/healthz") return finish(response, 204);
        if (method === "GET" && pathname === "/v1/build") return finish(response, 200, input.build);
        if (method === "POST" && pathname === "/v1/jobs") {
          const created = await input.controller.create(
            engineCreatePdfJobRequestSchema.parse(await readJson(request)),
          );
          return finish(response, created.replay ? 200 : 201, created.status);
        }
        const job = route(pathname);
        if (job === null) return finish(response, 404);
        if (method === "GET" && job.action === null) {
          const status = input.controller.get(job.jobId);
          return finish(response, status === null ? 404 : 200, status ?? undefined);
        }
        if (method === "PUT" && job.action === "input") {
          const expected = input.controller.expectedInput(job.jobId);
          if (expected === null) return finish(response, 404);
          const length = request.headers["content-length"];
          if (length === undefined) return finish(response, 411);
          if (!/^\d+$/u.test(length) || Number(length) !== expected.byteLength)
            return finish(response, 400);
          if (request.headers["content-type"] !== "application/pdf") return finish(response, 415);
          await input.controller.upload(job.jobId, request);
          return finish(response, 204);
        }
        if (method === "POST" && job.action === "run") {
          await input.controller.run(job.jobId);
          return finish(response, 202);
        }
        if (method === "GET" && job.action === "output") {
          const status = input.controller.get(job.jobId);
          if (status === null) return finish(response, 404);
          if (status.state !== "succeeded" || status.result.kind !== "download")
            return finish(response, 409);
          const output = await input.controller.output(job.jobId);
          if (output === null) return finish(response, 409);
          response.statusCode = 200;
          response.setHeader("content-type", "application/pdf");
          response.setHeader("content-length", output.byteLength);
          response.setHeader("digest", output.digest);
          response.setHeader("cache-control", "no-store");
          response.setHeader("x-content-type-options", "nosniff");
          response.setHeader("x-hereisit-engine-build", status.result.engineBuildId);
          await pipeline(output.stream, response);
          return;
        }
        if (method === "DELETE" && job.action === null) {
          await input.controller.remove(job.jobId);
          return finish(response, 204);
        }
        return finish(response, 405);
      } catch (error) {
        if (error instanceof PdfEngineUnavailableError) return finish(response, 503);
        if (error instanceof PdfEngineBusyError || error instanceof PdfJobConflictError)
          return finish(response, 409);
        if (error instanceof PdfJobNotFoundError) return finish(response, 404);
        if (
          error instanceof ZodError ||
          error instanceof SyntaxError ||
          error instanceof TypeError ||
          error instanceof RangeError
        )
          return finish(response, 400);
        return finish(response, 500);
      }
    })();
}

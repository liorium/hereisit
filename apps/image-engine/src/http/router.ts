import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { engineCreateJobRequestSchema } from "@hereisit/server-contracts";
import { ZodError } from "zod";
import type { EngineBuildInfo } from "../contract";
import {
  EngineBusyError,
  EngineUnavailableError,
  JobConflictError,
  type JobController,
  JobNotFoundError,
} from "../job/job-controller";

const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_JSON_BYTES = 64 * 1024;

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
  const json = JSON.stringify(body);
  response.setHeader("content-type", "application/json");
  response.setHeader("content-length", Buffer.byteLength(json));
  response.end(json);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const raw of request) {
    const chunk = Buffer.from(raw);
    bytes += chunk.byteLength;
    if (bytes > MAX_JSON_BYTES) throw new RangeError("JSON body is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function jobRoute(pathname: string): { jobId: string; action: string | null } | null {
  const match = /^\/v1\/jobs\/([^/]+)(?:\/(input|run|output))?$/.exec(pathname);
  if (match === null) return null;
  const jobId = match[1] ?? "";
  if (!JOB_ID_PATTERN.test(jobId)) throw new TypeError("job ID is invalid");
  return { jobId, action: match[2] ?? null };
}

export function createEngineRequestHandler(input: {
  readonly controller: JobController;
  readonly build: EngineBuildInfo;
}): RequestListener {
  return (request, response) => {
    void (async () => {
      try {
        const method = request.method ?? "GET";
        const rawUrl = request.url ?? "/";
        if (/%(?:2e|2f|5c)/i.test(rawUrl)) return finish(response, 400);
        const pathname = new URL(rawUrl, "http://engine.internal").pathname;
        if (method === "GET" && pathname === "/healthz") return finish(response, 204);
        if (method === "GET" && pathname === "/v1/build") return finish(response, 200, input.build);
        if (method === "POST" && pathname === "/v1/jobs") {
          const parsed = engineCreateJobRequestSchema.parse(await readJson(request));
          const created = await input.controller.create(parsed);
          return finish(response, created.replay ? 200 : 201, created.status);
        }
        const route = jobRoute(pathname);
        if (route === null) return finish(response, 404);
        if (method === "GET" && route.action === null) {
          const status = input.controller.get(route.jobId);
          return finish(response, status === null ? 404 : 200, status ?? undefined);
        }
        if (method === "PUT" && route.action === "input") {
          const expected = input.controller.expectedInput(route.jobId);
          if (expected === null) return finish(response, 404);
          const length = request.headers["content-length"];
          if (length === undefined) return finish(response, 411);
          if (!/^\d+$/.test(length) || Number(length) !== expected.byteLength) {
            return finish(response, 400);
          }
          if (request.headers["content-type"] !== expected.mimeHint) return finish(response, 415);
          await input.controller.upload(route.jobId, request);
          return finish(response, 204);
        }
        if (method === "POST" && route.action === "run") {
          await input.controller.run(route.jobId);
          return finish(response, 202);
        }
        if (method === "GET" && route.action === "output") {
          const status = input.controller.get(route.jobId);
          if (status === null) return finish(response, 404);
          if (status.state !== "succeeded" || status.result.kind !== "download") {
            return finish(response, 409);
          }
          const output = await input.controller.output(route.jobId);
          if (output === null) return finish(response, 409);
          response.statusCode = 200;
          response.setHeader("content-type", status.result.mime);
          response.setHeader("content-length", output.byteLength);
          response.setHeader("digest", output.digest);
          response.setHeader("x-hereisit-engine-build", status.result.engineBuildId);
          response.setHeader(
            "x-hereisit-tested-candidates",
            String(status.result.testedCandidates),
          );
          await pipeline(output.stream, response);
          return;
        }
        if (method === "DELETE" && route.action === null) {
          await input.controller.remove(route.jobId);
          return finish(response, 204);
        }
        return finish(response, 405);
      } catch (error) {
        if (error instanceof EngineUnavailableError) return finish(response, 503);
        if (error instanceof EngineBusyError) return finish(response, 409);
        if (error instanceof JobConflictError) return finish(response, 409);
        if (error instanceof JobNotFoundError) return finish(response, 404);
        if (
          error instanceof ZodError ||
          error instanceof SyntaxError ||
          error instanceof TypeError
        ) {
          return finish(response, 400);
        }
        if (error instanceof RangeError) return finish(response, 400);
        return finish(response, 500);
      }
    })();
  };
}

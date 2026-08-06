import {
  type ProductUsageEventV1,
  productUsageEventSchema,
} from "@hereisit/tool-contracts/product-usage";
import { availableToolEntries } from "@hereisit/tool-registry/catalog";
import type { ProductUsagePoint } from "../product-analytics";

const availableToolIds = new Set<string>(availableToolEntries.map((tool) => tool.id));

export interface ProductAnalyticsRouteRuntime {
  readonly environment: ProductUsagePoint["environment"];
  readonly currentSecret: string;
  readonly previousSecret: string;
  readonly versionId: string;
  readonly releaseSha256: string;
  readonly rateLimiter: Pick<RateLimit, "limit">;
  readonly readJson: (request: Request, maximumBytes: number) => Promise<unknown>;
  readonly hashNetwork: (input: {
    ip: string;
    utcDay: string;
    currentSecret: string;
    previousSecret: string;
  }) => Promise<{ readonly writeHash: string }>;
  readonly writePoint: (point: ProductUsagePoint) => void;
  readonly now: () => Date;
}

function jsonError(status: number, code: string): Response {
  return Response.json({ error: code }, { status });
}

function toPoint(
  event: ProductUsageEventV1,
  runtime: ProductAnalyticsRouteRuntime,
): ProductUsagePoint {
  return {
    environment: runtime.environment,
    toolId: event.toolId,
    event: event.event,
    ...(event.event === "processing-succeeded" || event.event === "processing-failed"
      ? { duration: event.duration }
      : {}),
    ...(event.event === "processing-failed" ? { failure: event.failure } : {}),
    versionId: runtime.versionId,
    releaseSha256: runtime.releaseSha256,
  };
}

export async function routeProductAnalyticsRequest(
  request: Request,
  runtime: ProductAnalyticsRouteRuntime,
): Promise<Response> {
  if (request.method !== "POST") {
    const response = jsonError(405, "METHOD_NOT_ALLOWED");
    response.headers.set("allow", "POST, OPTIONS");
    return response;
  }

  const connectingIp = request.headers.get("cf-connecting-ip");
  if (connectingIp === null) return jsonError(400, "INVALID_REQUEST");

  let limiterKey: string;
  try {
    limiterKey = (
      await runtime.hashNetwork({
        ip: connectingIp,
        utcDay: runtime.now().toISOString().slice(0, 10),
        currentSecret: runtime.currentSecret,
        previousSecret: runtime.previousSecret,
      })
    ).writeHash;
  } catch {
    return jsonError(400, "INVALID_REQUEST");
  }

  try {
    if (!(await runtime.rateLimiter.limit({ key: limiterKey })).success) {
      const response = jsonError(429, "RATE_LIMITED");
      response.headers.set("retry-after", "60");
      return response;
    }
  } catch {
    return jsonError(503, "ANALYTICS_UNAVAILABLE");
  }

  let body: unknown;
  try {
    body = await runtime.readJson(request, 512);
  } catch (error) {
    return jsonError(error instanceof RangeError ? 413 : 400, "INVALID_REQUEST");
  }

  const parsed = productUsageEventSchema.safeParse(body);
  if (!parsed.success || !availableToolIds.has(parsed.data.toolId)) {
    return jsonError(400, "INVALID_REQUEST");
  }

  try {
    runtime.writePoint(toPoint(parsed.data, runtime));
  } catch {
    return jsonError(503, "ANALYTICS_UNAVAILABLE");
  }
  return new Response(null, { status: 204 });
}

import { readBoundedJson } from "./bounded-json";
import { type Env, type OperationalConfig, parseOperationalConfig } from "./env";
import {
  type PolicyRouteRuntime,
  readPolicyStateFromD1,
  routePolicyRequest,
} from "./routes/policy";

const ALLOW_METHODS = "GET, POST, PUT, DELETE, OPTIONS";
const ALLOW_HEADERS = "authorization, content-type, x-download-lease";
const EXPOSE_HEADERS = "content-length, content-type, etag, retry-after, x-download-lease";

function jsonError(status: number, code: string): Response {
  return Response.json({ error: code }, { status });
}

function originIsAllowed(origin: string, allowedOrigins: readonly URL[]): boolean {
  return allowedOrigins.some((allowedOrigin) => allowedOrigin.origin === origin);
}

function withCors(response: Response, origin: string | null): Response {
  const headers = new Headers(response.headers);
  headers.set("vary", "Origin");
  if (origin !== null) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-allow-methods", ALLOW_METHODS);
    headers.set("access-control-allow-headers", ALLOW_HEADERS);
    headers.set("access-control-expose-headers", EXPOSE_HEADERS);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function routeRequestWithDependencies(
  request: Request,
  runtime: PolicyRouteRuntime,
): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin !== null && !originIsAllowed(origin, runtime.config.appOrigins)) {
    return withCors(jsonError(403, "ORIGIN_NOT_ALLOWED"), null);
  }

  const url = new URL(request.url);
  if (url.pathname !== "/v1/policy" || url.search !== "") {
    return withCors(jsonError(404, "NOT_FOUND"), origin);
  }
  if (request.method === "OPTIONS") {
    return withCors(new Response(null, { status: 204 }), origin);
  }
  if (request.method !== "POST") {
    const response = jsonError(405, "METHOD_NOT_ALLOWED");
    response.headers.set("allow", "POST, OPTIONS");
    return withCors(response, origin);
  }

  return withCors(await routePolicyRequest(request, runtime), origin);
}

function unavailableConfigurationResponse(request: Request): Response {
  const origin = request.headers.get("origin");
  if (origin !== null) {
    return withCors(jsonError(403, "ORIGIN_NOT_ALLOWED"), null);
  }
  return withCors(jsonError(503, "SERVER_PROCESSING_DISABLED"), null);
}

export async function routeRequest(
  request: Request,
  env: Env,
  _context: ExecutionContext,
): Promise<Response> {
  let config: OperationalConfig;
  try {
    config = await parseOperationalConfig(env);
  } catch {
    return unavailableConfigurationResponse(request);
  }
  return routeRequestWithDependencies(request, {
    config,
    currentSecret: env.ABUSE_HMAC_SECRET_CURRENT,
    previousSecret: env.ABUSE_HMAC_SECRET_PREVIOUS,
    policyRateLimiter: env.POLICY_RATE_LIMITER,
    readState: (query) => readPolicyStateFromD1(env.DB, query),
    readJson: readBoundedJson,
    now: () => new Date(),
    timeoutMilliseconds: 250,
  });
}

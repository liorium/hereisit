import { readBoundedJson } from "./bounded-json";
import { createD1JobRepository } from "./d1-job-repository";
import { type Env, type OperationalConfig, parseOperationalConfig } from "./env";
import { dispatchJobOutbox } from "./outbox";
import { deleteAuthorizedArtifact, storeExactInputArtifact } from "./r2-artifacts";
import { type CreateJobRouteRuntime, routeCreateJobRequest } from "./routes/jobs";
import {
  type PolicyRouteRuntime,
  readPolicyStateFromD1,
  routePolicyRequest,
} from "./routes/policy";
import { routeUploadRequest, type UploadRouteRuntime } from "./routes/uploads";

const ALLOW_METHODS = "GET, POST, PUT, DELETE, OPTIONS";
const ALLOW_HEADERS = "authorization, content-type, x-download-lease";
const EXPOSE_HEADERS = "content-length, content-type, etag, retry-after, x-download-lease";
const UPLOAD_PATH_PATTERN =
  /^\/v1\/jobs\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/input$/;

export interface RouterRouteRuntimes {
  readonly create?: CreateJobRouteRuntime;
  readonly upload?: UploadRouteRuntime;
}

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
  routes: RouterRouteRuntimes = {},
): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin !== null && !originIsAllowed(origin, runtime.config.appOrigins)) {
    return withCors(jsonError(403, "ORIGIN_NOT_ALLOWED"), null);
  }

  const url = new URL(request.url);
  if (url.search !== "") {
    return withCors(jsonError(404, "NOT_FOUND"), origin);
  }

  let route:
    | { readonly kind: "policy"; readonly methods: "POST, OPTIONS" }
    | { readonly kind: "create"; readonly methods: "POST, OPTIONS" }
    | {
        readonly kind: "upload";
        readonly methods: "PUT, OPTIONS";
        readonly jobId: string;
      };
  if (url.pathname === "/v1/policy") {
    route = { kind: "policy", methods: "POST, OPTIONS" };
  } else if (url.pathname === "/v1/jobs") {
    route = { kind: "create", methods: "POST, OPTIONS" };
  } else {
    const uploadMatch = UPLOAD_PATH_PATTERN.exec(url.pathname);
    const jobId = uploadMatch?.[1];
    if (jobId === undefined) {
      return withCors(jsonError(404, "NOT_FOUND"), origin);
    }
    route = { kind: "upload", methods: "PUT, OPTIONS", jobId };
  }

  if (request.method === "OPTIONS") {
    return withCors(new Response(null, { status: 204 }), origin);
  }
  const expectedMethod = route.kind === "upload" ? "PUT" : "POST";
  if (request.method !== expectedMethod) {
    const response = jsonError(405, "METHOD_NOT_ALLOWED");
    response.headers.set("allow", route.methods);
    return withCors(response, origin);
  }

  if (route.kind === "policy") {
    return withCors(await routePolicyRequest(request, runtime), origin);
  }
  if (route.kind === "create") {
    const createRuntime = routes.create;
    if (createRuntime === undefined) {
      return withCors(jsonError(503, "SERVER_PROCESSING_DISABLED"), origin);
    }
    return withCors(await routeCreateJobRequest(request, createRuntime), origin);
  }
  const uploadRuntime = routes.upload;
  if (uploadRuntime === undefined) {
    return withCors(jsonError(503, "SERVER_PROCESSING_DISABLED"), origin);
  }
  return withCors(await routeUploadRequest(request, route.jobId, uploadRuntime), origin);
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
  const repository = createD1JobRepository(env.DB);
  const policyRuntime: PolicyRouteRuntime = {
    config,
    currentSecret: env.ABUSE_HMAC_SECRET_CURRENT,
    previousSecret: env.ABUSE_HMAC_SECRET_PREVIOUS,
    policyRateLimiter: env.POLICY_RATE_LIMITER,
    readState: (query) => readPolicyStateFromD1(env.DB, query),
    readJson: readBoundedJson,
    now: () => new Date(),
    timeoutMilliseconds: 250,
  };
  const createRuntime: CreateJobRouteRuntime = {
    config,
    currentSecret: env.ABUSE_HMAC_SECRET_CURRENT,
    previousSecret: env.ABUSE_HMAC_SECRET_PREVIOUS,
    networkRateLimiter: env.NETWORK_JOB_RATE_LIMITER,
    sessionRateLimiter: env.SESSION_JOB_RATE_LIMITER,
    repository,
    readJson: readBoundedJson,
    now: () => new Date(),
    randomUuid: () => crypto.randomUUID(),
    logCreated: (event) => {
      console.log(JSON.stringify({ event: "image_job_created", ...event }));
    },
  };
  const uploadRuntime: UploadRouteRuntime = {
    config,
    currentSecret: env.ABUSE_HMAC_SECRET_CURRENT,
    previousSecret: env.ABUSE_HMAC_SECRET_PREVIOUS,
    networkRateLimiter: env.JOB_API_NETWORK_RATE_LIMITER,
    repository,
    storeInput: (input) =>
      storeExactInputArtifact({
        bucket: env.JOB_OBJECTS,
        ...input,
      }),
    deleteInput: (authorization) => deleteAuthorizedArtifact(env.JOB_OBJECTS, authorization),
    dispatchOutbox: (jobId, now) =>
      dispatchJobOutbox(
        {
          DB: env.DB,
          IMAGE_JOBS: env.IMAGE_JOBS,
        },
        jobId,
        now,
      ),
    now: Date.now,
  };
  return routeRequestWithDependencies(request, policyRuntime, {
    create: createRuntime,
    upload: uploadRuntime,
  });
}

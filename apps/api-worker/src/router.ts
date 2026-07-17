import { hashNetworkBuckets } from "./auth";
import { readBoundedJson } from "./bounded-json";
import { createD1JobRepository, createD1LifecycleRepository } from "./d1-job-repository";
import { type OperationalConfig, parseOperationalConfig } from "./env";
import { dispatchJobOutbox } from "./outbox";
import type { QueueEnv } from "./pending-container-binding";
import { deleteAuthorizedArtifact, storeExactInputArtifact } from "./r2-artifacts";
import {
  type CreateJobRouteRuntime,
  routeCreateJobRequest,
  routeJobCancelRequest,
  routeJobStatusRequest,
} from "./routes/jobs";
import {
  type PolicyRouteRuntime,
  readPolicyStateFromD1,
  routePolicyRequest,
} from "./routes/policy";
import {
  type LifecycleRouteRuntime,
  routeJobDeleteRequest,
  routeJobDownloadedRequest,
  routeJobResultRequest,
} from "./routes/results";
import { routeUploadRequest, type UploadRouteRuntime } from "./routes/uploads";

const ALLOW_METHODS = "GET, POST, PUT, DELETE, OPTIONS";
const ALLOW_HEADERS = "authorization, content-type, x-download-lease";
const EXPOSE_HEADERS = "content-length, content-type, etag, retry-after, x-download-lease";
const UPLOAD_PATH_PATTERN =
  /^\/v1\/jobs\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/input$/;
const JOB_PATH_PATTERN =
  /^\/v1\/jobs\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const JOB_ACTION_PATH_PATTERN =
  /^\/v1\/jobs\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/(cancel|result|downloaded)$/;

export interface RouterRouteRuntimes {
  readonly create?: CreateJobRouteRuntime;
  readonly upload?: UploadRouteRuntime;
  readonly lifecycle?: LifecycleRouteRuntime;
  readonly health?: {
    readonly buildId: string;
    readonly serverJobsEnabled: boolean;
  };
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
  const healthQueryAllowed =
    url.pathname === "/health" && (url.search === "" || url.search === "?requireJobs=1");
  if (url.search !== "" && !healthQueryAllowed) {
    return withCors(jsonError(404, "NOT_FOUND"), origin);
  }

  let route:
    | { readonly kind: "policy"; readonly methods: "POST, OPTIONS" }
    | { readonly kind: "create"; readonly methods: "POST, OPTIONS" }
    | { readonly kind: "health"; readonly methods: "GET, OPTIONS" }
    | {
        readonly kind: "upload";
        readonly methods: "PUT, OPTIONS";
        readonly jobId: string;
      }
    | {
        readonly kind: "job";
        readonly methods: "GET, DELETE, OPTIONS";
        readonly jobId: string;
      }
    | {
        readonly kind: "cancel" | "downloaded";
        readonly methods: "POST, OPTIONS";
        readonly jobId: string;
      }
    | {
        readonly kind: "result";
        readonly methods: "GET, OPTIONS";
        readonly jobId: string;
      };
  if (url.pathname === "/v1/policy") {
    route = { kind: "policy", methods: "POST, OPTIONS" };
  } else if (url.pathname === "/v1/jobs") {
    route = { kind: "create", methods: "POST, OPTIONS" };
  } else if (url.pathname === "/health") {
    route = { kind: "health", methods: "GET, OPTIONS" };
  } else {
    const uploadMatch = UPLOAD_PATH_PATTERN.exec(url.pathname);
    const uploadJobId = uploadMatch?.[1];
    if (uploadJobId !== undefined) {
      route = { kind: "upload", methods: "PUT, OPTIONS", jobId: uploadJobId };
    } else {
      const jobMatch = JOB_PATH_PATTERN.exec(url.pathname);
      const plainJobId = jobMatch?.[1];
      if (plainJobId !== undefined) {
        route = { kind: "job", methods: "GET, DELETE, OPTIONS", jobId: plainJobId };
      } else {
        const actionMatch = JOB_ACTION_PATH_PATTERN.exec(url.pathname);
        const actionJobId = actionMatch?.[1];
        const action = actionMatch?.[2];
        if (
          actionJobId === undefined ||
          (action !== "cancel" && action !== "result" && action !== "downloaded")
        ) {
          return withCors(jsonError(404, "NOT_FOUND"), origin);
        }
        route =
          action === "result"
            ? { kind: "result", methods: "GET, OPTIONS", jobId: actionJobId }
            : { kind: action, methods: "POST, OPTIONS", jobId: actionJobId };
      }
    }
  }

  if (request.method === "OPTIONS") {
    return withCors(new Response(null, { status: 204 }), origin);
  }
  const methodAllowed =
    (route.kind === "upload" && request.method === "PUT") ||
    ((route.kind === "policy" ||
      route.kind === "create" ||
      route.kind === "cancel" ||
      route.kind === "downloaded") &&
      request.method === "POST") ||
    ((route.kind === "health" || route.kind === "result") && request.method === "GET") ||
    (route.kind === "job" && (request.method === "GET" || request.method === "DELETE"));
  if (!methodAllowed) {
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
  if (route.kind === "health") {
    const health = routes.health ?? { buildId: "unknown", serverJobsEnabled: false };
    const requireJobs = url.searchParams.get("requireJobs") === "1";
    return withCors(
      Response.json(
        {
          status: requireJobs && !health.serverJobsEnabled ? "unavailable" : "ok",
          buildId: health.buildId,
          serverJobsEnabled: health.serverJobsEnabled,
        },
        {
          status: requireJobs && !health.serverJobsEnabled ? 503 : 200,
          headers: { "cache-control": "no-store" },
        },
      ),
      origin,
    );
  }
  const uploadRuntime = routes.upload;
  if (route.kind === "upload") {
    if (uploadRuntime === undefined) {
      return withCors(jsonError(503, "SERVER_PROCESSING_DISABLED"), origin);
    }
    return withCors(await routeUploadRequest(request, route.jobId, uploadRuntime), origin);
  }
  const lifecycle = routes.lifecycle;
  if (lifecycle === undefined) {
    return withCors(jsonError(503, "SERVER_PROCESSING_DISABLED"), origin);
  }
  if (route.kind === "job") {
    return withCors(
      request.method === "GET"
        ? await routeJobStatusRequest(request, route.jobId, lifecycle)
        : await routeJobDeleteRequest(request, route.jobId, lifecycle),
      origin,
    );
  }
  if (route.kind === "cancel") {
    return withCors(await routeJobCancelRequest(request, route.jobId, lifecycle), origin);
  }
  if (route.kind === "result") {
    return withCors(await routeJobResultRequest(request, route.jobId, lifecycle), origin);
  }
  return withCors(await routeJobDownloadedRequest(request, route.jobId, lifecycle), origin);
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
  env: QueueEnv,
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
  const lifecycleRepository = createD1LifecycleRepository(env.DB);
  const lifecycleRuntime: LifecycleRouteRuntime = {
    now: Date.now,
    randomLeaseToken: () => {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    },
    networkKey: async (jobRequest, now) => {
      const connectingIp = jobRequest.headers.get("cf-connecting-ip");
      if (connectingIp === null) throw new TypeError("Missing connecting address.");
      return (
        await hashNetworkBuckets({
          ip: connectingIp,
          utcDay: new Date(now).toISOString().slice(0, 10),
          currentSecret: env.ABUSE_HMAC_SECRET_CURRENT,
          previousSecret: env.ABUSE_HMAC_SECRET_PREVIOUS,
        })
      ).writeHash;
    },
    networkRateLimiter: env.JOB_API_NETWORK_RATE_LIMITER,
    jobRateLimiter: env.JOB_READ_RATE_LIMITER,
    downloadRateLimiter: env.RESULT_DOWNLOAD_RATE_LIMITER,
    repository: lifecycleRepository,
    artifacts: {
      getOutput: async (key) => {
        const object = await env.JOB_OBJECTS.get(key);
        if (object === null || object.body === null) return null;
        return {
          body: object.body,
          size: object.size,
          httpEtag: object.httpEtag,
          contentType: object.httpMetadata?.contentType,
          kind: object.customMetadata?.kind,
          jobId: object.customMetadata?.jobId,
        };
      },
      deleteInput: (key) => env.JOB_OBJECTS.delete(key),
      deleteOutput: (key) => env.JOB_OBJECTS.delete(key),
    },
    engine: {
      cancel: async (jobId) => {
        const { createContainerEngineClient } = await import("./container-client");
        await createContainerEngineClient(env).cancel(jobId);
      },
      remove: async (jobId) => {
        const { createContainerEngineClient } = await import("./container-client");
        await createContainerEngineClient(env).remove(jobId);
      },
    },
  };
  return routeRequestWithDependencies(request, policyRuntime, {
    create: createRuntime,
    upload: uploadRuntime,
    lifecycle: lifecycleRuntime,
    health: {
      buildId: config.engineImageDigest,
      serverJobsEnabled:
        config.rolloutPercent > 0 &&
        config.accountDailyWeightedUnitLimit > 0 &&
        config.anonymousDailyWeightedUnitLimit > 0 &&
        config.networkDailyWeightedUnitLimit > 0,
    },
  });
}

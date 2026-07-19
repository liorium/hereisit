const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export type UsageEnvironment = "local" | "staging" | "production";
export type UsageEventType = "fetch" | "queue" | "scheduled";
export type UsageEntrypoint = "default" | "queue" | "scheduled";
export type UsageRouteClass =
  | "policy"
  | "job-create"
  | "job-upload"
  | "job-read"
  | "job-result"
  | "job-delete"
  | "other";
export type UsageStatusClass = "success" | "client-error" | "server-error" | "exception";

export interface UsageAnalyticsPoint {
  readonly environment: UsageEnvironment;
  readonly eventType: UsageEventType;
  readonly entrypoint: UsageEntrypoint;
  readonly routeClass: UsageRouteClass;
  readonly statusClass: UsageStatusClass;
  readonly eventHourKey: number;
  readonly versionId: string;
  readonly releaseSha256: string;
}

export type UsageAnalyticsPointBase = Omit<UsageAnalyticsPoint, "statusClass">;

export function eventHourKey(startedAtMilliseconds: number): number {
  if (!Number.isSafeInteger(startedAtMilliseconds) || startedAtMilliseconds < 0) {
    throw new RangeError("Usage event start must be a non-negative safe integer.");
  }
  return Math.floor(startedAtMilliseconds / 3_600_000);
}

export function classifyStatus(status: number): Exclude<UsageStatusClass, "exception"> {
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new RangeError("HTTP status must be an integer between 100 and 599.");
  }
  if (status >= 500) return "server-error";
  if (status >= 400) return "client-error";
  return "success";
}

export function classifyFetchRoute(url: URL, method = "GET"): UsageRouteClass {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length === 2 && segments[0] === "v1" && segments[1] === "policy") return "policy";
  if (segments.length === 2 && segments[0] === "v1" && segments[1] === "jobs") {
    return method === "POST" ? "job-create" : "other";
  }
  if (segments.length < 3 || segments[0] !== "v1" || segments[1] !== "jobs") return "other";
  if (segments.length === 3) return method === "DELETE" ? "job-delete" : "job-read";
  if (segments.length !== 4) return "other";
  if (segments[3] === "upload") return "job-upload";
  if (segments[3] === "result") return "job-result";
  return "other";
}

export function writeUsageAnalyticsPoint(
  dataset: Pick<AnalyticsEngineDataset, "writeDataPoint">,
  point: UsageAnalyticsPoint,
): void {
  if (!Number.isSafeInteger(point.eventHourKey) || point.eventHourKey < 0) {
    throw new RangeError("Usage event hour must be a non-negative safe integer.");
  }
  if (!UUID_PATTERN.test(point.versionId)) {
    throw new TypeError("Usage Worker version ID must be a canonical UUID.");
  }
  if (!SHA256_PATTERN.test(point.releaseSha256)) {
    throw new TypeError("Usage release identity must be a lowercase SHA-256 digest.");
  }
  dataset.writeDataPoint({
    indexes: [`${point.environment}:usage-v1`],
    doubles: [point.eventHourKey],
    blobs: [
      "usage-v1",
      point.environment,
      point.eventType,
      point.entrypoint,
      point.routeClass,
      point.statusClass,
      point.versionId,
      point.releaseSha256,
    ],
  });
}

export async function trackUsageOperation<T>(
  dataset: Pick<AnalyticsEngineDataset, "writeDataPoint">,
  point: UsageAnalyticsPointBase,
  operation: () => Promise<T>,
  classifyResult: (result: T) => Exclude<UsageStatusClass, "exception">,
): Promise<T> {
  let statusClass: UsageStatusClass = "exception";
  try {
    const result = await operation();
    statusClass = classifyResult(result);
    return result;
  } finally {
    writeUsageAnalyticsPoint(dataset, { ...point, statusClass });
  }
}

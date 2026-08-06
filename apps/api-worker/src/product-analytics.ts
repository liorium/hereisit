import {
  PRODUCT_USAGE_SCHEMA,
  type ProductUsageDuration,
  type ProductUsageEventV1,
  type ProductUsageFailure,
  productUsageEventSchema,
} from "@hereisit/tool-contracts/product-usage";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface ProductUsagePoint {
  readonly environment: "local" | "staging" | "production";
  readonly toolId: string;
  readonly event: ProductUsageEventV1["event"];
  readonly duration?: ProductUsageDuration;
  readonly failure?: ProductUsageFailure;
  readonly versionId: string;
  readonly releaseSha256: string;
}

export function writeProductUsagePoint(
  dataset: Pick<AnalyticsEngineDataset, "writeDataPoint">,
  point: ProductUsagePoint,
): void {
  if (
    point.environment !== "local" &&
    point.environment !== "staging" &&
    point.environment !== "production"
  ) {
    throw new TypeError("Product usage environment is invalid.");
  }
  const event = productUsageEventSchema.parse({
    schema: PRODUCT_USAGE_SCHEMA,
    toolId: point.toolId,
    event: point.event,
    ...(point.duration === undefined ? {} : { duration: point.duration }),
    ...(point.failure === undefined ? {} : { failure: point.failure }),
  });
  if (!UUID_PATTERN.test(point.versionId)) {
    throw new TypeError("Product usage Worker version ID must be a canonical UUID.");
  }
  if (!SHA256_PATTERN.test(point.releaseSha256)) {
    throw new TypeError("Product usage release identity must be a lowercase SHA-256 digest.");
  }

  dataset.writeDataPoint({
    indexes: [`${point.environment}:product-usage-v1`],
    blobs: [
      PRODUCT_USAGE_SCHEMA,
      point.environment,
      event.toolId,
      event.event,
      "duration" in event ? event.duration : "",
      "failure" in event ? event.failure : "",
      point.versionId,
      point.releaseSha256,
    ],
  });
}

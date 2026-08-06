import { z } from "zod";

export const PRODUCT_USAGE_SCHEMA = "product-usage@1" as const;

export const productUsageDurationSchema = z.enum(["lt-1s", "1-3s", "3-10s", "10-30s", "gte-30s"]);

export const productUsageFailureSchema = z.enum([
  "invalid-input",
  "unsupported",
  "cancelled",
  "resource-limit",
  "processing-error",
]);

const base = {
  schema: z.literal(PRODUCT_USAGE_SCHEMA),
  toolId: z.string().min(1).max(64),
};

export const productUsageEventSchema = z.discriminatedUnion("event", [
  z
    .object({
      ...base,
      event: z.enum(["processing-started", "download-requested"]),
    })
    .strict(),
  z
    .object({
      ...base,
      event: z.literal("processing-succeeded"),
      duration: productUsageDurationSchema,
    })
    .strict(),
  z
    .object({
      ...base,
      event: z.literal("processing-failed"),
      duration: productUsageDurationSchema,
      failure: productUsageFailureSchema,
    })
    .strict(),
]);

export type ProductUsageEventV1 = z.infer<typeof productUsageEventSchema>;
export type ProductUsageDuration = z.infer<typeof productUsageDurationSchema>;
export type ProductUsageFailure = z.infer<typeof productUsageFailureSchema>;

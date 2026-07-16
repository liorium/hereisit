import type { Env } from "./env";

/** Temporary compile-time binding. Task 11 replaces this with Wrangler-generated container types. */
export type QueueEnv = Env & {
  readonly IMAGE_ENGINE: DurableObjectNamespace;
};

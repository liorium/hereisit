import type { ImageJobMessage } from "@hereisit/server-contracts";
import type { Env } from "./env";
import { consumeImageQueue } from "./queue-consumer";
import { routeRequest } from "./router";
import { runScheduledMaintenance } from "./sweeper";
import {
  classifyFetchRoute,
  classifyStatus,
  eventHourKey,
  trackUsageOperation,
  type UsageEnvironment,
} from "./usage-analytics";

export { ImageEngineContainer } from "./container-client";

function usageEnvironment(value: string): UsageEnvironment {
  if (value === "local" || value === "staging" || value === "production") return value;
  throw new TypeError("Usage analytics environment is invalid.");
}

function usageIdentity(env: Env, startedAt: number) {
  return {
    environment: usageEnvironment(env.ENVIRONMENT),
    eventHourKey: eventHourKey(startedAt),
    versionId: env.WORKER_VERSION.id,
    releaseSha256: env.RELEASE_REPORT_SHA256,
  };
}

export default {
  fetch: (request, env, context) => {
    const startedAt = Date.now();
    return trackUsageOperation(
      env.USAGE_ANALYTICS,
      {
        ...usageIdentity(env, startedAt),
        eventType: "fetch",
        entrypoint: "default",
        routeClass: classifyFetchRoute(new URL(request.url), request.method),
      },
      () => routeRequest(request, env, context),
      (response) => classifyStatus(response.status),
    );
  },
  queue: (batch, env) => {
    const startedAt = Date.now();
    return trackUsageOperation(
      env.USAGE_ANALYTICS,
      {
        ...usageIdentity(env, startedAt),
        eventType: "queue",
        entrypoint: "queue",
        routeClass: "other",
      },
      () => consumeImageQueue(batch, env),
      () => "success",
    );
  },
  scheduled: (controller, env, context) => {
    const startedAt = Date.now();
    context.waitUntil(
      trackUsageOperation(
        env.USAGE_ANALYTICS,
        {
          ...usageIdentity(env, startedAt),
          eventType: "scheduled",
          entrypoint: "scheduled",
          routeClass: "other",
        },
        () => runScheduledMaintenance(env, controller.scheduledTime),
        () => "success",
      ),
    );
  },
} satisfies ExportedHandler<Env, ImageJobMessage>;

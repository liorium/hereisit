import type { ImageJobMessage } from "@hereisit/server-contracts";
import type { Env } from "./env";
import { consumeImageQueue } from "./queue-consumer";
import { routeRequest } from "./router";
import { runScheduledMaintenance } from "./sweeper";

export { ImageEngineContainer } from "./container-client";

export default {
  fetch: routeRequest,
  queue: (batch, env) => consumeImageQueue(batch, env),
  scheduled: (controller, env, context) => {
    context.waitUntil(runScheduledMaintenance(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env, ImageJobMessage>;

import type { ImageJobMessage } from "@hereisit/server-contracts";
import type { QueueEnv } from "./pending-container-binding";
import { consumeImageQueue } from "./queue-consumer";
import { routeRequest } from "./router";

export { ImageEngineContainer } from "./container-client";

export default {
  fetch: routeRequest,
  queue: (batch, env) => consumeImageQueue(batch, env),
} satisfies ExportedHandler<QueueEnv, ImageJobMessage>;

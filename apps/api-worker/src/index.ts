import type { Env } from "./env";
import { routeRequest } from "./router";

export default {
  fetch: routeRequest,
} satisfies ExportedHandler<Env>;

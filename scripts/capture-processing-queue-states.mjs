import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson, parseCliArguments, writeCanonicalJsonAtomic } from "./image-lab-common.mjs";
import { inspectQueueDeliveryState } from "./verify-queue-delivery-state.mjs";

const queueKeys = ["image-primary", "image-dlq", "pdf-primary", "pdf-dlq"];

export async function captureProcessingQueueStates({
  accountId,
  queues,
  apiToken,
  output,
  inspect = inspectQueueDeliveryState,
}) {
  if (Object.keys(queues).sort().join(",") !== [...queueKeys].sort().join(",")) {
    throw new TypeError("all four processing queues are required");
  }
  const entries = {};
  for (const key of queueKeys) {
    const result = await inspect({ accountId, queueName: queues[key], apiToken });
    if (
      result.queue !== queues[key] ||
      !["paused", "resumed"].includes(result.state) ||
      result.verified !== true
    ) {
      throw new TypeError(`${key} Queue state is not verified`);
    }
    entries[key] = { name: result.queue, state: result.state };
  }
  const snapshot = { schema: "hereisit-processing-queue-rollback@1", queues: entries };
  if (output !== undefined)
    await writeCanonicalJsonAtomic(output, snapshot, { refuseOverwrite: true, mode: 0o600 });
  return snapshot;
}

export async function runCaptureProcessingQueueStatesCli(argv, stdout = process.stdout) {
  const args = parseCliArguments(argv);
  const expected = ["account-id", "image-primary", "image-dlq", "pdf-primary", "pdf-dlq", "output"];
  if (Object.keys(args).sort().join(",") !== expected.sort().join(","))
    throw new TypeError("queue snapshot arguments are invalid");
  const snapshot = await captureProcessingQueueStates({
    accountId: args["account-id"],
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
    output: args.output,
    queues: {
      "image-primary": args["image-primary"],
      "image-dlq": args["image-dlq"],
      "pdf-primary": args["pdf-primary"],
      "pdf-dlq": args["pdf-dlq"],
    },
  });
  stdout.write(canonicalJson(snapshot));
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await runCaptureProcessingQueueStatesCli(process.argv.slice(2));
}

import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectQueueDeliveryState,
  verifyQueueDeliveryState,
} from "../scripts/verify-queue-delivery-state.mjs";

const accountId = "0123456789abcdef0123456789abcdef";
const queueId = "11111111111111111111111111111111";
const queueName = "hereisit-image-jobs-production";

function queue(deliveryPaused = true) {
  return {
    consumers: [],
    consumers_total_count: 0,
    created_on: "2026-07-19T00:00:00.000Z",
    modified_on: "2026-07-19T00:01:00.000Z",
    producers: [],
    producers_total_count: 0,
    queue_id: queueId,
    queue_name: queueName,
    settings: {
      delivery_delay: 0,
      delivery_paused: deliveryPaused,
      message_retention_period: 345600,
    },
  };
}

function envelope(result: unknown, resultInfo?: object) {
  return {
    errors: [],
    messages: [],
    result,
    ...(resultInfo === undefined ? {} : { result_info: resultInfo }),
    success: true,
  };
}

const servers: Array<ReturnType<typeof createServer>> = [];

async function startApi({
  list = [queue()],
  detail = queue(),
  expectedAccountId = accountId,
} = {}) {
  const requests: Array<{ url: string; authorization: string | undefined }> = [];
  const server = createServer((request, response) => {
    requests.push({
      url: request.url ?? "",
      authorization: request.headers.authorization,
    });
    response.setHeader("content-type", "application/json");
    const prefix = `/client/v4/accounts/${expectedAccountId}/queues`;
    if (request.url === `${prefix}?page=1`) {
      response.end(
        JSON.stringify(
          envelope(list, {
            count: list.length,
            page: 1,
            per_page: 20,
            total_count: list.length,
            total_pages: 1,
          }),
        ),
      );
    } else if (request.url === `${prefix}/${queueId}`) {
      response.end(JSON.stringify(envelope(detail)));
    } else {
      response.statusCode = 404;
      response.end(JSON.stringify({ errors: [], messages: [], result: null, success: false }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server failed");
  return { apiOrigin: `http://127.0.0.1:${address.port}`, requests };
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe("Queue delivery state verifier", () => {
  it("queries the exact account and queue, then verifies paused delivery", async () => {
    const api = await startApi();

    await expect(
      inspectQueueDeliveryState({
        accountId,
        queueName,
        expected: "paused",
        apiToken: "test-token",
        apiOrigin: api.apiOrigin,
      }),
    ).resolves.toEqual({ queue: queueName, state: "paused", verified: true });
    expect(api.requests).toEqual([
      { url: `/client/v4/accounts/${accountId}/queues?page=1`, authorization: "Bearer test-token" },
      {
        url: `/client/v4/accounts/${accountId}/queues/${queueId}`,
        authorization: "Bearer test-token",
      },
    ]);
  });

  it("verifies resumed delivery from a strict authenticated detail response", () => {
    expect(
      verifyQueueDeliveryState({
        document: envelope(queue(false)),
        expectedQueueId: queueId,
        queueName,
        expected: "resumed",
      }),
    ).toEqual({ queue: queueName, state: "resumed", verified: true });
  });

  it("accepts successful Cloudflare responses with nullable metadata", () => {
    expect(
      verifyQueueDeliveryState({
        document: { success: true, errors: null, messages: null, result: queue() },
        expectedQueueId: queueId,
        queueName,
        expected: "paused",
      }),
    ).toEqual({ queue: queueName, state: "paused", verified: true });
  });

  it.each([
    ["wrong state", envelope(queue(false)), "paused"],
    ["wrong queue", envelope({ ...queue(), queue_name: "other" }), "paused"],
    ["wrong ID", envelope({ ...queue(), queue_id: "2".repeat(32) }), "paused"],
    ["missing boolean", envelope({ ...queue(), settings: {} }), "paused"],
    ["failed API", { errors: [], messages: [], result: queue(), success: false }, "paused"],
    ["human output", "name paused", "paused"],
  ])("rejects %s", (_label, document, expected) => {
    expect(() =>
      verifyQueueDeliveryState({
        document,
        expectedQueueId: queueId,
        queueName,
        expected,
      }),
    ).toThrow();
  });

  it("rejects missing and duplicate queue discoveries", async () => {
    for (const list of [[], [queue(), queue()]]) {
      const api = await startApi({ list });
      await expect(
        inspectQueueDeliveryState({
          accountId,
          queueName,
          expected: "paused",
          apiToken: "test-token",
          apiOrigin: api.apiOrigin,
        }),
      ).rejects.toThrow(/exactly one/i);
    }
  });
});

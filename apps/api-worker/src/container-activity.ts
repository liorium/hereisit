import { prepareOperationalCounter } from "./operational-counters";

const CONTAINER_BILLING_TAIL_MS = 60_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface ContainerActivityInterval {
  readonly startedAt: number;
  readonly billedUntilAt: number;
}

export interface RecordContainerActivityInput {
  readonly segmentId: string;
  readonly contactedAt: number;
}

function requireTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer.`);
  }
}

export function unionActivityMilliseconds(
  intervals: readonly ContainerActivityInterval[],
  windowStartedAt: number,
  windowEndedAt: number,
): number {
  requireTimestamp(windowStartedAt, "Activity window start");
  requireTimestamp(windowEndedAt, "Activity window end");
  if (windowEndedAt <= windowStartedAt) throw new RangeError("Activity window must be positive.");

  const clipped = intervals
    .map((interval) => {
      requireTimestamp(interval.startedAt, "Activity start");
      requireTimestamp(interval.billedUntilAt, "Activity end");
      if (interval.billedUntilAt < interval.startedAt) {
        throw new RangeError("Activity interval end precedes its start.");
      }
      return {
        startedAt: Math.max(interval.startedAt, windowStartedAt),
        billedUntilAt: Math.min(interval.billedUntilAt, windowEndedAt),
      };
    })
    .filter((interval) => interval.billedUntilAt > interval.startedAt)
    .sort(
      (left, right) => left.startedAt - right.startedAt || left.billedUntilAt - right.billedUntilAt,
    );

  let total = 0;
  let activeStart: number | null = null;
  let activeEnd = 0;
  for (const interval of clipped) {
    if (activeStart === null) {
      activeStart = interval.startedAt;
      activeEnd = interval.billedUntilAt;
      continue;
    }
    if (interval.startedAt <= activeEnd) {
      activeEnd = Math.max(activeEnd, interval.billedUntilAt);
      continue;
    }
    total += activeEnd - activeStart;
    activeStart = interval.startedAt;
    activeEnd = interval.billedUntilAt;
  }
  if (activeStart !== null) total += activeEnd - activeStart;
  if (!Number.isSafeInteger(total)) throw new RangeError("Activity duration exceeded its bound.");
  return total;
}

export async function recordContainerActivity(
  database: D1Database,
  input: RecordContainerActivityInput,
): Promise<void> {
  if (!UUID_PATTERN.test(input.segmentId)) throw new TypeError("Activity segment ID is invalid.");
  requireTimestamp(input.contactedAt, "Container contact time");
  const billedUntilAt = input.contactedAt + CONTAINER_BILLING_TAIL_MS;
  requireTimestamp(billedUntilAt, "Container billing tail");

  const session = database.withSession("first-primary");
  await session.batch([
    session
      .prepare(
        `INSERT INTO container_activity_segments (id, started_at, billed_until_at)
         VALUES (?, ?, ?)`,
      )
      .bind(input.segmentId, input.contactedAt, billedUntilAt),
    session
      .prepare(
        `UPDATE container_activity_segments
         SET started_at = (
               SELECT MIN(started_at) FROM container_activity_segments
               WHERE started_at <= ? AND billed_until_at >= ?
             ),
             billed_until_at = (
               SELECT MAX(billed_until_at) FROM container_activity_segments
               WHERE started_at <= ? AND billed_until_at >= ?
             )
         WHERE id = ?`,
      )
      .bind(billedUntilAt, input.contactedAt, billedUntilAt, input.contactedAt, input.segmentId),
    session
      .prepare(
        `DELETE FROM container_activity_segments
         WHERE id <> ?
           AND started_at <= (
             SELECT billed_until_at FROM container_activity_segments WHERE id = ?
           )
           AND billed_until_at >= (
             SELECT started_at FROM container_activity_segments WHERE id = ?
           )`,
      )
      .bind(input.segmentId, input.segmentId, input.segmentId),
    prepareOperationalCounter(session, {
      recordedAt: input.contactedAt,
      durableObjectRequests: 1,
      d1RowsRead: 10,
      d1RowsWritten: 4,
    }),
  ]);
}

const MAXIMUM_COUNTER_INCREMENT = 1_000_000_000;

export interface OperationalCounterIncrement {
  readonly recordedAt: number;
  readonly admittedJobs?: number;
  readonly durableObjectRequests?: number;
  readonly queueOperations?: number;
  readonly d1RowsRead?: number;
  readonly d1RowsWritten?: number;
  readonly r2ClassAOperations?: number;
  readonly r2ClassBOperations?: number;
  readonly observabilityLogEvents?: number;
}

function counter(value: number | undefined, label: string): number {
  const resolved = value ?? 0;
  if (!Number.isSafeInteger(resolved) || resolved < 0 || resolved > MAXIMUM_COUNTER_INCREMENT) {
    throw new RangeError(`${label} counter increment is invalid.`);
  }
  return resolved;
}

export function prepareOperationalCounter(
  database: Pick<D1Database, "prepare">,
  input: OperationalCounterIncrement,
): D1PreparedStatement {
  if (!Number.isSafeInteger(input.recordedAt) || input.recordedAt < 0) {
    throw new RangeError("Operational counter time is invalid.");
  }
  const hourKey = Math.floor(input.recordedAt / 3_600_000);
  const values = [
    counter(input.admittedJobs, "Admitted jobs"),
    counter(input.durableObjectRequests, "Durable Object requests"),
    counter(input.queueOperations, "Queue operations"),
    counter(input.d1RowsRead, "D1 rows read"),
    counter(input.d1RowsWritten, "D1 rows written"),
    counter(input.r2ClassAOperations, "R2 class A operations"),
    counter(input.r2ClassBOperations, "R2 class B operations"),
    counter(input.observabilityLogEvents, "Observability log events"),
  ] as const;
  if (values.every((value) => value === 0)) {
    throw new RangeError("At least one operational counter must increase.");
  }

  return database
    .prepare(
      `INSERT INTO operational_counter_hourly (
         accounting_epoch, hour_key, admitted_jobs, durable_object_requests,
         queue_operations, d1_rows_read, d1_rows_written,
         r2_class_a_operations, r2_class_b_operations, observability_log_events, updated_at
       )
       SELECT cost_accounting_epoch, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       FROM rollout_control WHERE id = 1
       ON CONFLICT(accounting_epoch, hour_key) DO UPDATE SET
         admitted_jobs = admitted_jobs + excluded.admitted_jobs,
         durable_object_requests = durable_object_requests + excluded.durable_object_requests,
         queue_operations = queue_operations + excluded.queue_operations,
         d1_rows_read = d1_rows_read + excluded.d1_rows_read,
         d1_rows_written = d1_rows_written + excluded.d1_rows_written,
         r2_class_a_operations = r2_class_a_operations + excluded.r2_class_a_operations,
         r2_class_b_operations = r2_class_b_operations + excluded.r2_class_b_operations,
         observability_log_events = observability_log_events + excluded.observability_log_events,
         updated_at = MAX(updated_at, excluded.updated_at)`,
    )
    .bind(hourKey, ...values, input.recordedAt);
}

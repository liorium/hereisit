CREATE TABLE operational_cost_hourly (
  accounting_epoch TEXT NOT NULL CHECK (
    length(accounting_epoch) = 32
    AND accounting_epoch NOT GLOB '*[^0-9a-f]*'
  ),
  hour_key INTEGER NOT NULL CHECK (hour_key >= 0),
  live_cost_model_sha256 TEXT NOT NULL CHECK (
    length(live_cost_model_sha256) = 64
    AND live_cost_model_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  provider_usage_schema_sha256 TEXT NOT NULL CHECK (
    length(provider_usage_schema_sha256) = 64
    AND provider_usage_schema_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  release_report_sha256 TEXT NOT NULL CHECK (
    length(release_report_sha256) = 64
    AND release_report_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  admitted_jobs INTEGER NOT NULL DEFAULT 0,
  provider_worker_requests INTEGER NOT NULL DEFAULT 0,
  provider_worker_cpu_ms INTEGER NOT NULL DEFAULT 0,
  provider_worker_usage_complete INTEGER NOT NULL DEFAULT 0
    CHECK (provider_worker_usage_complete IN (0, 1)),
  provider_container_cpu_microseconds INTEGER NOT NULL DEFAULT 0,
  provider_container_allocated_memory_byte_milliseconds INTEGER NOT NULL DEFAULT 0,
  provider_container_allocated_disk_byte_milliseconds INTEGER NOT NULL DEFAULT 0,
  provider_container_tx_bytes INTEGER NOT NULL DEFAULT 0,
  provider_container_usage_complete INTEGER NOT NULL DEFAULT 0
    CHECK (provider_container_usage_complete IN (0, 1)),
  analytics_engine_data_points INTEGER NOT NULL DEFAULT 0,
  analytics_engine_read_queries INTEGER NOT NULL DEFAULT 0,
  analytics_engine_usage_complete INTEGER NOT NULL DEFAULT 0
    CHECK (analytics_engine_usage_complete IN (0, 1)),
  workers_logpush_events INTEGER NOT NULL DEFAULT 0,
  usage_log_objects INTEGER NOT NULL DEFAULT 0,
  usage_log_bytes INTEGER NOT NULL DEFAULT 0,
  provider_usage_complete INTEGER NOT NULL DEFAULT 0
    CHECK (provider_usage_complete IN (0, 1)),
  container_active_milliseconds INTEGER NOT NULL DEFAULT 0,
  durable_object_active_milliseconds INTEGER NOT NULL DEFAULT 0,
  worker_requests INTEGER NOT NULL DEFAULT 0,
  worker_cpu_ms INTEGER NOT NULL DEFAULT 0,
  durable_object_requests INTEGER NOT NULL DEFAULT 0,
  durable_object_storage_byte_milliseconds INTEGER NOT NULL DEFAULT 0,
  queue_operations INTEGER NOT NULL DEFAULT 0,
  d1_rows_read INTEGER NOT NULL DEFAULT 0,
  d1_rows_written INTEGER NOT NULL DEFAULT 0,
  d1_storage_byte_milliseconds INTEGER NOT NULL DEFAULT 0,
  r2_class_a_operations INTEGER NOT NULL DEFAULT 0,
  r2_class_b_operations INTEGER NOT NULL DEFAULT 0,
  r2_storage_byte_milliseconds INTEGER NOT NULL DEFAULT 0,
  container_egress_bytes INTEGER NOT NULL DEFAULT 0,
  observability_log_events INTEGER NOT NULL DEFAULT 0,
  worker_cost_microusd INTEGER NOT NULL DEFAULT 0,
  container_cost_microusd INTEGER NOT NULL DEFAULT 0,
  durable_object_cost_microusd INTEGER NOT NULL DEFAULT 0,
  queue_cost_microusd INTEGER NOT NULL DEFAULT 0,
  d1_cost_microusd INTEGER NOT NULL DEFAULT 0,
  r2_cost_microusd INTEGER NOT NULL DEFAULT 0,
  analytics_engine_cost_microusd INTEGER NOT NULL DEFAULT 0,
  observability_cost_microusd INTEGER NOT NULL DEFAULT 0,
  fixed_cost_microusd INTEGER NOT NULL DEFAULT 0,
  total_cost_microusd INTEGER NOT NULL DEFAULT 0,
  complete INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0, 1)),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (accounting_epoch, hour_key),
  CHECK (
    admitted_jobs >= 0
    AND provider_worker_requests >= 0
    AND provider_worker_cpu_ms >= 0
    AND provider_container_cpu_microseconds >= 0
    AND provider_container_allocated_memory_byte_milliseconds >= 0
    AND provider_container_allocated_disk_byte_milliseconds >= 0
    AND provider_container_tx_bytes >= 0
    AND analytics_engine_data_points >= 0
    AND analytics_engine_read_queries >= 0
    AND workers_logpush_events >= 0
    AND usage_log_objects >= 0
    AND usage_log_bytes >= 0
    AND container_active_milliseconds >= 0
    AND durable_object_active_milliseconds >= 0
    AND worker_requests >= 0
    AND worker_cpu_ms >= 0
    AND durable_object_requests >= 0
    AND durable_object_storage_byte_milliseconds >= 0
    AND queue_operations >= 0
    AND d1_rows_read >= 0
    AND d1_rows_written >= 0
    AND d1_storage_byte_milliseconds >= 0
    AND r2_class_a_operations >= 0
    AND r2_class_b_operations >= 0
    AND r2_storage_byte_milliseconds >= 0
    AND container_egress_bytes >= 0
    AND observability_log_events >= 0
    AND worker_cost_microusd >= 0
    AND container_cost_microusd >= 0
    AND durable_object_cost_microusd >= 0
    AND queue_cost_microusd >= 0
    AND d1_cost_microusd >= 0
    AND r2_cost_microusd >= 0
    AND analytics_engine_cost_microusd >= 0
    AND observability_cost_microusd >= 0
    AND fixed_cost_microusd >= 0
    AND total_cost_microusd >= 0
  )
) STRICT;

CREATE TABLE container_activity_segments (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(id) = 36
    AND substr(id, 9, 1) = '-'
    AND substr(id, 14, 1) = '-'
    AND substr(id, 19, 1) = '-'
    AND substr(id, 24, 1) = '-'
    AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'
  ),
  started_at INTEGER NOT NULL CHECK (started_at >= 0),
  billed_until_at INTEGER NOT NULL CHECK (billed_until_at >= started_at)
) STRICT;

CREATE INDEX container_activity_segments_time_idx
ON container_activity_segments(started_at, billed_until_at);

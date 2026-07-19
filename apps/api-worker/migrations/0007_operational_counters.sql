CREATE TABLE operational_counter_hourly (
  accounting_epoch TEXT NOT NULL CHECK (
    length(accounting_epoch) = 32
    AND accounting_epoch NOT GLOB '*[^0-9a-f]*'
  ),
  hour_key INTEGER NOT NULL CHECK (hour_key >= 0),
  admitted_jobs INTEGER NOT NULL DEFAULT 0 CHECK (admitted_jobs >= 0),
  durable_object_requests INTEGER NOT NULL DEFAULT 0 CHECK (durable_object_requests >= 0),
  queue_operations INTEGER NOT NULL DEFAULT 0 CHECK (queue_operations >= 0),
  d1_rows_read INTEGER NOT NULL DEFAULT 0 CHECK (d1_rows_read >= 0),
  d1_rows_written INTEGER NOT NULL DEFAULT 0 CHECK (d1_rows_written >= 0),
  r2_class_a_operations INTEGER NOT NULL DEFAULT 0 CHECK (r2_class_a_operations >= 0),
  r2_class_b_operations INTEGER NOT NULL DEFAULT 0 CHECK (r2_class_b_operations >= 0),
  observability_log_events INTEGER NOT NULL DEFAULT 0 CHECK (observability_log_events >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (accounting_epoch, hour_key)
) STRICT;

ALTER TABLE rollout_control ADD COLUMN last_evaluated_at INTEGER CHECK (
  last_evaluated_at IS NULL OR (
    typeof(last_evaluated_at) = 'integer'
    AND last_evaluated_at >= 0
  )
);
ALTER TABLE rollout_control ADD COLUMN last_sample_size INTEGER NOT NULL DEFAULT 0 CHECK (
  typeof(last_sample_size) = 'integer'
  AND last_sample_size >= 0
);
ALTER TABLE rollout_control ADD COLUMN traffic_breach_count INTEGER NOT NULL DEFAULT 0 CHECK (
  typeof(traffic_breach_count) = 'integer'
  AND traffic_breach_count >= 0
);
ALTER TABLE rollout_control ADD COLUMN traffic_breach_reason TEXT;
ALTER TABLE rollout_control ADD COLUMN traffic_breach_window_started_at INTEGER CHECK (
  traffic_breach_window_started_at IS NULL OR (
    typeof(traffic_breach_window_started_at) = 'integer'
    AND traffic_breach_window_started_at >= 0
  )
);
ALTER TABLE rollout_control ADD COLUMN cost_breach_count INTEGER NOT NULL DEFAULT 0 CHECK (
  typeof(cost_breach_count) = 'integer'
  AND cost_breach_count >= 0
);
ALTER TABLE rollout_control ADD COLUMN cost_breach_window_started_at INTEGER CHECK (
  cost_breach_window_started_at IS NULL OR (
    typeof(cost_breach_window_started_at) = 'integer'
    AND cost_breach_window_started_at >= 0
  )
);
ALTER TABLE rollout_control ADD COLUMN last_cost_per_1000_microusd INTEGER CHECK (
  last_cost_per_1000_microusd IS NULL OR (
    typeof(last_cost_per_1000_microusd) = 'integer'
    AND last_cost_per_1000_microusd >= 0
  )
);
ALTER TABLE rollout_control ADD COLUMN last_projected_monthly_cost_microusd INTEGER CHECK (
  last_projected_monthly_cost_microusd IS NULL OR (
    typeof(last_projected_monthly_cost_microusd) = 'integer'
    AND last_projected_monthly_cost_microusd >= 0
  )
);
ALTER TABLE rollout_control ADD COLUMN cost_accounting_started_at INTEGER NOT NULL DEFAULT 0 CHECK (
  typeof(cost_accounting_started_at) = 'integer'
  AND cost_accounting_started_at >= 0
);
ALTER TABLE rollout_control ADD COLUMN first_admitted_at INTEGER CHECK (
  first_admitted_at IS NULL OR (
    typeof(first_admitted_at) = 'integer'
    AND first_admitted_at >= 0
  )
);
ALTER TABLE rollout_control ADD COLUMN last_sealed_hour_key INTEGER CHECK (
  last_sealed_hour_key IS NULL OR (
    typeof(last_sealed_hour_key) = 'integer'
    AND last_sealed_hour_key >= 0
  )
);
ALTER TABLE rollout_control ADD COLUMN last_cost_evaluated_hour_key INTEGER CHECK (
  last_cost_evaluated_hour_key IS NULL OR (
    typeof(last_cost_evaluated_hour_key) = 'integer'
    AND last_cost_evaluated_hour_key >= 0
  )
);
ALTER TABLE rollout_control ADD COLUMN last_cost_window_complete INTEGER NOT NULL DEFAULT 0 CHECK (
  last_cost_window_complete IN (0, 1)
);
ALTER TABLE rollout_control ADD COLUMN deletion_overdue_count INTEGER NOT NULL DEFAULT 0 CHECK (
  typeof(deletion_overdue_count) = 'integer'
  AND deletion_overdue_count >= 0
);
ALTER TABLE rollout_control ADD COLUMN deletion_sweep_generation INTEGER NOT NULL DEFAULT 0 CHECK (
  typeof(deletion_sweep_generation) = 'integer'
  AND deletion_sweep_generation >= 0
);
ALTER TABLE rollout_control ADD COLUMN deletion_sweep_started_at INTEGER CHECK (
  deletion_sweep_started_at IS NULL OR (
    typeof(deletion_sweep_started_at) = 'integer'
    AND deletion_sweep_started_at >= 0
  )
);
ALTER TABLE rollout_control ADD COLUMN deletion_sweep_completed_at INTEGER CHECK (
  deletion_sweep_completed_at IS NULL OR (
    typeof(deletion_sweep_completed_at) = 'integer'
    AND deletion_sweep_completed_at >= 0
  )
);
ALTER TABLE rollout_control ADD COLUMN manual_reset_at INTEGER CHECK (
  manual_reset_at IS NULL OR (
    typeof(manual_reset_at) = 'integer'
    AND manual_reset_at >= 0
  )
);

UPDATE rollout_control
SET cost_accounting_epoch = lower(hex(randomblob(16))),
    cost_accounting_started_at = unixepoch() * 1000
WHERE id = 1;

CREATE TABLE operational_alert_state (
  kind TEXT PRIMARY KEY NOT NULL CHECK (
    length(kind) BETWEEN 1 AND 64
    AND kind NOT GLOB '*[^a-z0-9-]*'
  ),
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
  last_sent_at INTEGER CHECK (
    last_sent_at IS NULL OR (
      typeof(last_sent_at) = 'integer'
      AND last_sent_at >= 0
    )
  ),
  recovered_at INTEGER CHECK (
    recovered_at IS NULL OR (
      typeof(recovered_at) = 'integer'
      AND recovered_at >= 0
    )
  ),
  CHECK (
    recovered_at IS NULL
    OR last_sent_at IS NULL
    OR recovered_at >= last_sent_at
  )
);

CREATE INDEX operational_alert_active_idx
ON operational_alert_state(active, last_sent_at);

CREATE TABLE artifact_presence_audit (
  job_id TEXT PRIMARY KEY NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  input_exists INTEGER NOT NULL CHECK (input_exists IN (0, 1)),
  output_exists INTEGER NOT NULL CHECK (output_exists IN (0, 1)),
  checked_at INTEGER NOT NULL CHECK (
    typeof(checked_at) = 'integer'
    AND checked_at >= 0
  )
);

CREATE INDEX jobs_health_window_idx
ON jobs(finished_at, status, error_code, verified_input_mime, input_has_alpha, declared_bytes);

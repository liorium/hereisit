ALTER TABLE rollout_control ADD COLUMN safety_generation INTEGER NOT NULL DEFAULT 0 CHECK (typeof(safety_generation) = 'integer' AND safety_generation >= 0);
ALTER TABLE rollout_control ADD COLUMN safety_history_started_at INTEGER NOT NULL DEFAULT 0 CHECK (typeof(safety_history_started_at) = 'integer' AND safety_history_started_at >= 0);
-- A schema migration does not prove that legacy Worker writers have stopped.
-- Keep coverage unknown until authoritative incident history establishes it.
CREATE TABLE safety_incidents (
  generation INTEGER PRIMARY KEY CHECK (generation > 0),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 64),
  recorded_at INTEGER NOT NULL CHECK (typeof(recorded_at) = 'integer' AND recorded_at >= 0)
);
CREATE TRIGGER record_safety_incident AFTER UPDATE OF safety_generation ON rollout_control
WHEN NEW.safety_generation > OLD.safety_generation
BEGIN
  INSERT INTO safety_incidents(generation, reason, recorded_at)
  VALUES(NEW.safety_generation, COALESCE(NEW.reason, 'ACCOUNTING_STATE_INVALID'), MAX(NEW.safety_history_started_at, unixepoch() * 1000));
END;
CREATE TABLE accounting_health (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  epoch TEXT NOT NULL CHECK (length(epoch) = 32 AND epoch NOT GLOB '*[^a-f0-9]*'),
  status TEXT NOT NULL CHECK (status IN ('unknown', 'degraded', 'healthy')),
  reason TEXT CHECK (reason IN ('PROVIDER_UNAVAILABLE','PROVIDER_SAMPLED','ACCOUNTING_DELAY','HISTORICAL_GAP','SAFETY_CONFLICT')),
  evaluated_at INTEGER NOT NULL CHECK (typeof(evaluated_at) = 'integer' AND evaluated_at >= 0),
  pending_hour_key INTEGER CHECK (pending_hour_key IS NULL OR (typeof(pending_hour_key) = 'integer' AND pending_hour_key >= 0)),
  unresolved_since_hour_key INTEGER CHECK (unresolved_since_hour_key IS NULL OR (typeof(unresolved_since_hour_key) = 'integer' AND unresolved_since_hour_key >= 0)),
  CHECK (status <> 'healthy' OR (reason IS NULL AND pending_hour_key IS NULL AND unresolved_since_hour_key IS NULL))
);
INSERT INTO accounting_health(id, epoch, status, reason, evaluated_at)
SELECT 1, cost_accounting_epoch, 'unknown', NULL, 0 FROM rollout_control WHERE id = 1;
ALTER TABLE operational_alert_state ADD COLUMN event_key TEXT;
ALTER TABLE operational_alert_state ADD COLUMN lease_token TEXT;
ALTER TABLE operational_alert_state ADD COLUMN lease_expires_at INTEGER CHECK (lease_expires_at IS NULL OR (typeof(lease_expires_at) = 'integer' AND lease_expires_at >= 0));
ALTER TABLE operational_alert_state ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0 CHECK (typeof(next_attempt_at) = 'integer' AND next_attempt_at >= 0);

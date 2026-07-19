CREATE TABLE container_provider_egress_hourly (
  accounting_epoch TEXT NOT NULL,
  hour_key INTEGER NOT NULL,
  region TEXT NOT NULL CHECK (
    length(region) BETWEEN 1 AND 32
    AND region = lower(region)
    AND substr(region, 1, 1) GLOB '[a-z]'
    AND region NOT GLOB '*[^a-z0-9_-]*'
  ),
  transmitted_bytes INTEGER NOT NULL CHECK (transmitted_bytes >= 0),
  PRIMARY KEY (accounting_epoch, hour_key, region),
  FOREIGN KEY (accounting_epoch, hour_key)
    REFERENCES operational_cost_hourly(accounting_epoch, hour_key)
    ON DELETE CASCADE
) STRICT;

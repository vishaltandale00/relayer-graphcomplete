-- codex-basic-high was briefly product-visible. Existing product threads move to
-- the replacement product Codex configuration while historical interaction and
-- attempt receipts retain the configuration that actually produced them.
UPDATE threads
SET harness_configuration_name = 'codex-basic'
WHERE harness_configuration_name = 'codex-basic-high';

UPDATE product_model_preferences
SET default_harness_configuration_name = 'codex-basic'
WHERE default_harness_configuration_name = 'codex-basic-high';

UPDATE product_harnesses
SET product_visible = 0,
    available = 0,
    unavailable_reason_code = 'harness_retired',
    unavailable_reason_message = 'This harness configuration is no longer available in Relayer Desktop.'
WHERE configuration_name = 'codex-basic-high';

DELETE FROM harness_model_rules
WHERE harness_configuration_name IN (
  SELECT configuration_name
  FROM product_harnesses
  WHERE model_rules_modified = 1
);

UPDATE product_harnesses
SET model_rules_modified = 0,
    model_rules_present = 0,
    configuration_revision = runtime_configuration_revision,
    configuration_digest = runtime_configuration_digest
WHERE model_rules_modified = 1;

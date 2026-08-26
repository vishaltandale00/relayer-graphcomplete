ALTER TABLE product_harnesses ADD COLUMN runtime_configuration_revision INTEGER NOT NULL DEFAULT 1
    CHECK (runtime_configuration_revision > 0);

ALTER TABLE product_harnesses ADD COLUMN runtime_configuration_digest TEXT NOT NULL DEFAULT '';

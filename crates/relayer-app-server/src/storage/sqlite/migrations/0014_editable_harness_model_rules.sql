ALTER TABLE product_harnesses ADD COLUMN model_rules_modified INTEGER NOT NULL DEFAULT 0
    CHECK (model_rules_modified IN (0,1));

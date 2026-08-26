DROP INDEX model_families_name_nocase;

CREATE UNIQUE INDEX model_families_name_nocase
ON model_families(name COLLATE NOCASE)
WHERE lifecycle_state='active';

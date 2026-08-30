-- Migration 0011 predates SQLx's transactional SQLite runner and must keep its
-- published checksum. The runner applies that exact migration with foreign-key
-- enforcement disabled before reaching this forward validation boundary.
CREATE TEMP TABLE input_action_foreign_key_validation (
    valid INTEGER NOT NULL CHECK(valid = 1)
);

INSERT INTO input_action_foreign_key_validation(valid)
SELECT CASE WHEN
    (SELECT COUNT(*) FROM pragma_foreign_key_list('nodes')
        WHERE "from"='leased_action_id' AND "table"='actions') = 1
    AND (SELECT COUNT(*) FROM pragma_foreign_key_list('layer_actions')
        WHERE "from"='action_id' AND "table"='actions') = 1
    AND (SELECT COUNT(*) FROM pragma_foreign_key_list('completions')
        WHERE "from"='root_action_id' AND "table"='actions') = 1
    AND (SELECT COUNT(*) FROM pragma_foreign_key_list('interaction_context_actions')
        WHERE "from"='action_id' AND "table"='actions') = 1
    AND (SELECT COUNT(*) FROM pragma_foreign_key_list('input_action_payloads')
        WHERE "from"='action_id' AND "table"='actions') = 1
    AND (SELECT COUNT(*) FROM pragma_foreign_key_list('interaction_input_children')
        WHERE "from"='action_id' AND "table"='actions') = 1
THEN 1 ELSE 0 END;

DROP TABLE input_action_foreign_key_validation;
